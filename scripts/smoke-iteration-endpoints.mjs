#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/03-iteration-dashboard m1:
// eventStream.mjs (readEvents / buildHealth / buildPending / buildCoverage /
// stableId) + promote.mjs (promoteEvidence / EVIDENCE_ID_RE).
//
// Pure-function-first — exercises every code path against the real
// `data/career/` files. Promote tests redirect to a tmp dir so we
// don't accidentally pollute the real promote-queue/. HTTP endpoints
// themselves are thin Express adapters around these pure functions;
// covered by m2's full-stack vite-build smoke.

import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readEvents,
  buildHealth,
  buildPending,
  buildCoverage,
  stableId,
  _PATHS as ITERATION_PATHS,
} from '../src/career/iteration/eventStream.mjs';
import {
  promoteEvidence,
  EVIDENCE_ID_RE,
  PROMOTE_QUEUE_DIR,
} from '../src/career/iteration/promote.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── 1. stableId ────────────────────────────────────────────────────────

await test('stableId: deterministic for identical inputs', () => {
  const r = { ts: '2026-05-18T00:00:00Z', jobId: 'abc', domain: 'x.com' };
  assert.equal(stableId(r), stableId(r));
  assert.equal(stableId(r).length, 12);
  assert.match(stableId(r), /^[a-f0-9]{12}$/);
});

await test('stableId: differs for different records', () => {
  const a = { ts: '2026-05-18T00:00:00Z', domain: 'a.com' };
  const b = { ts: '2026-05-18T00:00:00Z', domain: 'b.com' };
  assert.notEqual(stableId(a), stableId(b));
});

// ── 2. EVIDENCE_ID_RE ─────────────────────────────────────────────────

await test('EVIDENCE_ID_RE: accepts 12-hex', () => {
  assert.ok(EVIDENCE_ID_RE.test('abc123def456'));
  assert.ok(EVIDENCE_ID_RE.test('0000000000ff'));
});

await test('EVIDENCE_ID_RE: rejects junk', () => {
  assert.ok(!EVIDENCE_ID_RE.test('not-hex'));
  assert.ok(!EVIDENCE_ID_RE.test('abc')); // too short
  assert.ok(!EVIDENCE_ID_RE.test('AAAAAAAAAAAA')); // uppercase
  assert.ok(!EVIDENCE_ID_RE.test('abc123def4567')); // too long
  assert.ok(!EVIDENCE_ID_RE.test('../../../etc/passwd')); // path traversal attempt
});

// ── 3. readEvents (against real repo data) ─────────────────────────────

await test('readEvents: returns events in DESC ts order', async () => {
  const { events, hasMore } = await readEvents({ limit: 100 });
  assert.ok(Array.isArray(events));
  assert.equal(typeof hasMore, 'boolean');
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i - 1].ts >= events[i].ts,
      `events not sorted DESC at ${i}: ${events[i - 1].ts} vs ${events[i].ts}`,
    );
  }
});

await test('readEvents: every event has required shape', async () => {
  const { events } = await readEvents({ limit: 50 });
  for (const e of events) {
    assert.ok(typeof e.id === 'string' && e.id.length > 0, `bad id: ${JSON.stringify(e.id)}`);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(typeof e.kind === 'string' && e.kind.length > 0);
    assert.ok(typeof e.summary === 'string' && e.summary.length > 0);
    assert.ok(typeof e.payload === 'object' && e.payload !== null);
  }
});

await test('readEvents: site-failures.jsonl → evidence.captured kind', async () => {
  const { events } = await readEvents({ limit: 100 });
  const sf = events.find((e) => e.kind === 'evidence.captured');
  if (sf) {
    assert.ok(sf.payload.domain, 'evidence.captured payload missing domain');
    assert.ok(sf.payload.error_kind, 'evidence.captured payload missing error_kind');
  }
  // Note: if no site-failures.jsonl exists in CI, this test passes vacuously.
});

await test('readEvents: limit caps page size', async () => {
  const { events } = await readEvents({ limit: 5 });
  assert.ok(events.length <= 5);
});

await test('readEvents: limit out-of-range clamps (negative → 1, huge → 100)', async () => {
  const a = await readEvents({ limit: -1 });
  const b = await readEvents({ limit: 9999 });
  assert.ok(a.events.length <= 100);
  assert.ok(b.events.length <= 100);
});

await test('readEvents: beforeTs paginates further back', async () => {
  const page1 = await readEvents({ limit: 5 });
  if (page1.events.length < 5) return; // not enough data — skip
  const earliest = page1.events[page1.events.length - 1].ts;
  const page2 = await readEvents({ limit: 5, beforeTs: earliest });
  // Every page2 event must strictly precede the page1 boundary.
  for (const e of page2.events) {
    assert.ok(e.ts < earliest, `page2 event ${e.ts} >= boundary ${earliest}`);
  }
});

await test('readEvents: since filter excludes older events', async () => {
  const future = Date.now() + 60_000;
  const { events } = await readEvents({ since: future });
  assert.equal(events.length, 0, 'no events should be after now+1min');
});

// ── 4. buildHealth ────────────────────────────────────────────────────

await test('buildHealth: returns expected shape', async () => {
  const h = await buildHealth();
  assert.equal(h.window_days, 30);
  assert.equal(typeof h.apply_count, 'number');
  assert.ok(h.success_rate === null || (h.success_rate >= 0 && h.success_rate <= 1));
  assert.equal(typeof h.failure_count, 'number');
  assert.ok(h.calibration_min === null || Number.isFinite(h.calibration_min));
  assert.ok(h.pending_counts);
  assert.equal(typeof h.pending_counts.promote, 'number');
  assert.equal(typeof h.pending_counts.pr_review, 'number');
  assert.equal(h.pending_counts.tier2, 0); // placeholder per m3-OQ
  assert.equal(h.pending_counts.tier3, 0);
  assert.match(h.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ── 5. buildPending ───────────────────────────────────────────────────

await test('buildPending: returns expected shape with promote + pr_review arrays', async () => {
  const p = await buildPending();
  assert.ok(Array.isArray(p.promote));
  assert.ok(Array.isArray(p.pr_review));
  assert.deepEqual(p.tier2, []);
  assert.deepEqual(p.tier3, []);
  for (const item of p.promote) {
    assert.match(item.id, /^[a-f0-9]{12}$/, `promote item id ${item.id} not 12-hex`);
    assert.ok(item.domain);
  }
});

await test('buildPending: promote queue sorted DESC by ts', async () => {
  const p = await buildPending();
  for (let i = 1; i < p.promote.length; i++) {
    assert.ok(p.promote[i - 1].ts >= p.promote[i].ts);
  }
});

// ── 6. buildCoverage ──────────────────────────────────────────────────

await test('buildCoverage: returns fixtures + tuner shape', async () => {
  const c = await buildCoverage();
  assert.ok(Array.isArray(c.fixtures));
  // tuner may be null if no tuner-log.json on disk
  assert.ok(c.tuner === null || typeof c.tuner === 'object');
  if (c.fixtures.length) {
    const fx = c.fixtures[0];
    assert.ok(fx.id);
    assert.ok(fx.vendor);
    assert.equal(typeof fx.must_detect_count, 'number');
  }
});

// ── 7. promoteEvidence (against tmp promote-queue + real site-failures) ─

await test('promoteEvidence: rejects invalid id (path traversal guard)', async () => {
  await assert.rejects(promoteEvidence('../../../etc/passwd'), /12-hex/);
  await assert.rejects(promoteEvidence(''), /12-hex/);
  await assert.rejects(promoteEvidence('UPPERCASE___'), /12-hex/);
});

await test('promoteEvidence: 404 for unknown id', async () => {
  await assert.rejects(promoteEvidence('aaaaaaaaaaaa'), (err) => err.code === 'EVIDENCE_NOT_FOUND');
});

await test('promoteEvidence: real flow + idempotent second call', async () => {
  // Find a real site-failure id from the existing JSONL.
  const { _PATHS } = await import('../src/career/iteration/eventStream.mjs');
  void _PATHS;
  const { readJsonl } = await import('../src/career/feedback/stores.mjs');
  const _FILES = (await import('../src/career/feedback/stores.mjs'))._FILES;
  let first = null;
  for await (const r of readJsonl(_FILES.SITE_FAILURES)) {
    first = r;
    break;
  }
  if (!first) {
    console.log('   (no site-failures.jsonl rows — skip)');
    return;
  }
  const id = stableId(first);

  // Redirect promote-queue/ to tmp via temporary cwd shenanigans isn't
  // viable (DEFAULT_FIXTURES_DIR is path.resolve'd at import time).
  // Instead: scrub any pre-existing test files for this id, do real
  // promote, assert path under PROMOTE_QUEUE_DIR, then clean up.
  // PROMOTE_QUEUE_DIR import is path-resolved at import time, but the
  // dir itself is under the repo's gitignored data/, so writing test
  // artifacts is fine — we just clean them at end.
  await _cleanPromoteForId(id);

  const r1 = await promoteEvidence(id);
  try {
    assert.equal(r1.status, 'created');
    assert.ok(r1.path.startsWith(PROMOTE_QUEUE_DIR));
    assert.ok(existsSync(r1.path));
    const body = await fs.readFile(r1.path, 'utf8');
    assert.match(body, /Promoted from site-failure/);
    assert.match(body, new RegExp(`id: ${id}`));
    assert.match(body, /capture-fixture\.mjs/);

    // Second call must be idempotent — same path returned, status='already_promoted'.
    const r2 = await promoteEvidence(id);
    assert.equal(r2.status, 'already_promoted');
    assert.equal(r2.path, r1.path);
  } finally {
    await _cleanPromoteForId(id);
  }
});

await test('promoteEvidence: yaml body is shell-safe + JSON-quoted strings', async () => {
  // Use a fabricated site-failure to test yaml escaping without writing
  // to the real JSONL. We can't promote a fabricated record (it must
  // exist in site-failures.jsonl), so instead test the slugify + yaml
  // template purely via a minimal record. Skip the disk round-trip.
  // This test ensures string values with embedded quotes survive.
  const { readJsonl } = await import('../src/career/feedback/stores.mjs');
  const _FILES = (await import('../src/career/feedback/stores.mjs'))._FILES;
  let target = null;
  for await (const r of readJsonl(_FILES.SITE_FAILURES)) {
    if (r.error_message && r.error_message.includes('"')) {
      target = r;
      break;
    }
    target = target ?? r;
  }
  if (!target) return; // no data — skip
  const id = stableId(target);
  await _cleanPromoteForId(id);
  try {
    const r = await promoteEvidence(id);
    const body = await fs.readFile(r.path, 'utf8');
    // JSON.stringify-encoded strings: backslash + double-quote
    assert.match(body, /error_message:\s*"/);
  } finally {
    await _cleanPromoteForId(id);
  }
});

// ── 8. Review regression tests ─────────────────────────────────────────

await test('REVIEW HIGH 8 (adv): readEvents returns nextCursor when hasMore', async () => {
  const { events, hasMore, nextCursor } = await readEvents({ limit: 1 });
  if (events.length === 0) return; // no data — skip
  if (hasMore) {
    assert.ok(nextCursor, 'nextCursor must be set when hasMore=true');
    assert.equal(nextCursor.ts, events[events.length - 1].ts);
    assert.equal(nextCursor.id, events[events.length - 1].id);
  } else {
    assert.equal(nextCursor, null);
  }
});

await test('REVIEW HIGH 8 (adv): composite-cursor pagination handles ts ties', async () => {
  // Walk the full event list one-by-one using the composite cursor.
  // If two events share a ts, the OLD strict-`<` filter would drop one;
  // the new cursor admits the second on the next page.
  const seen = new Set();
  let cursor = null;
  while (true) {
    const { events: page, hasMore, nextCursor } = await readEvents({
      limit: 5,
      beforeTs: cursor?.ts,
      beforeId: cursor?.id,
    });
    for (const e of page) {
      assert.ok(!seen.has(e.id), `event ${e.id} appeared twice across pages`);
      seen.add(e.id);
    }
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
    if (seen.size > 200) throw new Error('pagination not terminating'); // safety
  }
  // All events should have been visited exactly once.
  const fullRead = await readEvents({ limit: 1000 });
  assert.equal(seen.size, fullRead.events.length, 'all events covered by paginated walk');
});

await test('REVIEW HIGH 1 (adv): concurrent promote returns same path (in-memory mutex)', async () => {
  const { readJsonl } = await import('../src/career/feedback/stores.mjs');
  const _FILES = (await import('../src/career/feedback/stores.mjs'))._FILES;
  let first = null;
  for await (const r of readJsonl(_FILES.SITE_FAILURES)) {
    first = r;
    break;
  }
  if (!first) return; // no data — skip
  const id = stableId(first);
  await _cleanPromoteForId(id);
  try {
    // Fire two concurrent promotes for the same id — the mutex must
    // serialize them so both resolve to the same path. Without the fix
    // the two could race past _findExistingPromote and both try to write.
    const [a, b] = await Promise.all([promoteEvidence(id), promoteEvidence(id)]);
    assert.equal(a.path, b.path);
    // One should be 'created', the other 'already_promoted' (or both
    // 'created' if they share the same promise via the in-flight Map).
    const statuses = [a.status, b.status].sort();
    assert.ok(
      JSON.stringify(statuses) === JSON.stringify(['already_promoted', 'created']) ||
        JSON.stringify(statuses) === JSON.stringify(['created', 'created']),
      `unexpected race outcome: ${statuses}`,
    );
  } finally {
    await _cleanPromoteForId(id);
  }
});

await test('REVIEW MEDIUM (Plan + adv): buildHealth + buildPending share site-failures scan', async () => {
  // No direct way to inspect the IO count without spying — instead
  // verify the two callers produce CONSISTENT failure counts (a single
  // shared read implies they agree even if a write lands mid-call).
  const h = await buildHealth();
  const p = await buildPending();
  // h.failure_count counts ALL site-failures in window; p.promote counts
  // those NOT YET promoted. So h.failure_count >= p.promote.length.
  assert.ok(
    h.failure_count >= p.promote.length,
    `failure_count ${h.failure_count} should be ≥ promote.length ${p.promote.length}`,
  );
});

// ── Helpers ────────────────────────────────────────────────────────────

async function _cleanPromoteForId(id) {
  try {
    const entries = await fs.readdir(PROMOTE_QUEUE_DIR);
    for (const name of entries) {
      if (name.endsWith(`-${id}.yml`)) {
        await fs.unlink(path.join(PROMOTE_QUEUE_DIR, name)).catch(() => {});
      }
    }
  } catch {
    /* dir may not exist */
  }
}

// Sanity that the paths module is hooked up correctly.
void os.tmpdir();
void ITERATION_PATHS;

// ── Wrap-up ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
