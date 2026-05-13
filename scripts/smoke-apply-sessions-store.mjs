#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step-state-machine m1:
// applySessionsStore.mjs schema + atomic CRUD.
//
// Pure-Node, fast (<1s).

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  APPLY_SESSIONS_DIR,
  ApplySessionSchema,
  ABANDON_AFTER_MS,
  SITE_ADAPTERS,
  SESSION_STATUSES,
  PER_STEP_STATUSES,
  JOB_ID_RE,
  buildInitialSession,
  readSession,
  writeSession,
  deleteSession,
  listSessionJobIds,
  withSessionLock,
} from '../src/career/applier/multistep/applySessionsStore.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    // Restore backup before exit so a mid-run failure doesn't orphan
    // the user's real data/career/apply-sessions/
    syncRestoreOnCrash();
    process.exit(1);
  }
}

// ── Fixture isolation ────────────────────────────────────────────────
const BACKUP = APPLY_SESSIONS_DIR + `.smoke-backup.${process.pid}`;
let hadSessions = false;
if (existsSync(APPLY_SESSIONS_DIR)) {
  await fs.rename(APPLY_SESSIONS_DIR, BACKUP);
  hadSessions = true;
}
async function cleanup() {
  if (existsSync(APPLY_SESSIONS_DIR)) {
    await fs.rm(APPLY_SESSIONS_DIR, { recursive: true, force: true });
  }
  if (hadSessions) await fs.rename(BACKUP, APPLY_SESSIONS_DIR);
}
function syncRestoreOnCrash() {
  try {
    if (existsSync(APPLY_SESSIONS_DIR)) rmSync(APPLY_SESSIONS_DIR, { recursive: true, force: true });
    if (hadSessions && existsSync(BACKUP)) renameSync(BACKUP, APPLY_SESSIONS_DIR);
  } catch {}
}
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); syncRestoreOnCrash(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); syncRestoreOnCrash(); process.exit(1); });

// ── 1. Constants + enum exports ──────────────────────────────────────

await test('exports: SITE_ADAPTERS / SESSION_STATUSES / PER_STEP_STATUSES are frozen enums', () => {
  assert.deepEqual(SITE_ADAPTERS, ['workday', 'icims', 'successfactors', 'generic']);
  assert.deepEqual(SESSION_STATUSES, ['active', 'paused', 'abandoned', 'completed']);
  assert.deepEqual(PER_STEP_STATUSES, ['pending', 'filled', 'skipped', 'approved']);
  assert.ok(Object.isFrozen(SITE_ADAPTERS));
});

await test('exports: ABANDON_AFTER_MS = 24h', () => {
  assert.equal(ABANDON_AFTER_MS, 24 * 60 * 60 * 1000);
});

await test('exports: JOB_ID_RE matches drafts contract', () => {
  assert.ok(JOB_ID_RE.test('abc123def456'));
  assert.ok(!JOB_ID_RE.test('ABCDEF123456')); // uppercase rejected
  assert.ok(!JOB_ID_RE.test('abc123def45'));  // 11 chars rejected
});

// ── 2. buildInitialSession ───────────────────────────────────────────

await test('buildInitialSession: defaults are valid + status=active', () => {
  const s = buildInitialSession({
    jobId: 'aaaaaaaaaaaa',
    jobUrl: 'https://jobs.example.com/apply/123',
    siteAdapter: 'workday',
  });
  // Should pass Zod
  const validated = ApplySessionSchema.parse(s);
  assert.equal(validated.status, 'active');
  assert.equal(validated.current_step, 0);
  assert.equal(validated.total_steps, null);
  assert.equal(validated.site_adapter, 'workday');
  assert.deepEqual(validated.per_step_draft, {});
  assert.deepEqual(validated.field_memory, {});
  assert.equal(validated.started_at, validated.last_activity_at);
});

await test('buildInitialSession: with totalSteps passes through', () => {
  const s = buildInitialSession({
    jobId: 'bbbbbbbbbbbb',
    jobUrl: 'https://workday.com/x',
    siteAdapter: 'workday',
    totalSteps: 7,
  });
  assert.equal(s.total_steps, 7);
});

// ── 3. CRUD round-trip ───────────────────────────────────────────────

await test('writeSession + readSession: round-trip preserves all fields', async () => {
  const jobId = 'cccccccccccc';
  const initial = buildInitialSession({
    jobId,
    jobUrl: 'https://jobs.example.com/apply/123',
    siteAdapter: 'workday',
    totalSteps: 5,
  });
  await writeSession(jobId, initial);
  const round = await readSession(jobId);
  assert.ok(round);
  assert.equal(round.jobId, jobId);
  assert.equal(round.site_adapter, 'workday');
  assert.equal(round.total_steps, 5);
  assert.equal(round.status, 'active');
  // last_activity_at should be bumped relative to initial.started_at
  // (because writeSession bumps; even though both happen close in time
  // the read should be at least equal to write's value)
  assert.ok(round.last_activity_at >= initial.started_at);

  await deleteSession(jobId);
});

await test('writeSession: with per_step_draft + field_memory + statuses', async () => {
  const jobId = 'dddddddddddd';
  const initial = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'icims',
  });
  initial.current_step = 2;
  initial.per_step_draft = {
    '0': {
      step_idx: 0,
      fields: [
        { label: 'Email', class: 'hard', suggested_value: 'a@b.com', confidence: 'high' },
      ],
      captured_at: new Date().toISOString(),
    },
    '1': {
      step_idx: 1,
      fields: [
        { label: 'Why this role?', class: 'open', suggested_value: 'because...', confidence: 'medium' },
      ],
      captured_at: new Date().toISOString(),
    },
  };
  initial.per_step_status = { '0': 'approved', '1': 'approved' };
  initial.field_memory = {
    'identity.email': 'a@b.com',
    'first_name': 'Victor',
  };
  await writeSession(jobId, initial);
  const round = await readSession(jobId);
  assert.equal(round.current_step, 2);
  assert.equal(round.per_step_status['0'], 'approved');
  assert.equal(round.field_memory['identity.email'], 'a@b.com');
  assert.equal(round.per_step_draft['0'].fields[0].label, 'Email');

  await deleteSession(jobId);
});

// ── 4. readSession: missing file → null ──────────────────────────────

await test('readSession: nonexistent jobId → null (not throw)', async () => {
  const r = await readSession('eeeeeeeeeeee');
  assert.equal(r, null);
});

// ── 5. Invalid jobId rejected ────────────────────────────────────────

await test('writeSession: invalid jobId (uppercase) → TypeError', async () => {
  await assert.rejects(
    () => writeSession('ABCDEF123456', { jobId: 'ABCDEF123456' }),
    /invalid jobId/,
  );
});

await test('readSession: invalid jobId → TypeError', async () => {
  await assert.rejects(() => readSession('not-hex'), /invalid jobId/);
});

await test('writeSession: jobId mismatch (arg vs session.jobId) → error', async () => {
  const jobId = 'ffffffffffff';
  const s = buildInitialSession({
    jobId: '111111111111', // intentionally different
    jobUrl: 'https://x.com',
    siteAdapter: 'generic',
  });
  await assert.rejects(() => writeSession(jobId, s), /jobId mismatch/);
});

// ── 6. Zod schema enforces enums ─────────────────────────────────────

await test('ApplySessionSchema: invalid site_adapter rejected', () => {
  const bad = buildInitialSession({
    jobId: '222222222222',
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  bad.site_adapter = 'lever-rip'; // not in enum
  assert.throws(() => ApplySessionSchema.parse(bad));
});

await test('ApplySessionSchema: invalid per_step_status enum rejected', () => {
  const bad = buildInitialSession({
    jobId: '333333333333',
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  bad.per_step_status = { '0': 'mystery-status' };
  assert.throws(() => ApplySessionSchema.parse(bad));
});

// ── 7. Lazy abandon: status=active + >24h → returned as 'abandoned' ──

await test('readSession: active session idle > 24h → returns status=abandoned (file unchanged)', async () => {
  const jobId = '444444444444';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  // Manually backdate last_activity_at to 25h ago
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  s.last_activity_at = past;
  await writeSession(jobId, s, { bumpActivity: false });

  const read = await readSession(jobId);
  assert.equal(read.status, 'abandoned', 'lazy abandon should fire');

  // BUT: file on disk should still say 'active' (lazy = no write-back)
  const onDisk = JSON.parse(await fs.readFile(path.join(APPLY_SESSIONS_DIR, `${jobId}.json`), 'utf-8'));
  assert.equal(onDisk.status, 'active', 'on-disk status must NOT be mutated by readSession');

  await deleteSession(jobId);
});

await test('readSession: paused session > 24h does NOT auto-abandon', async () => {
  const jobId = '555555555555';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  s.status = 'paused';
  s.last_activity_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeSession(jobId, s, { bumpActivity: false });

  const read = await readSession(jobId);
  assert.equal(read.status, 'paused', 'paused sessions are not abandoned automatically');

  await deleteSession(jobId);
});

await test('readSession: active session idle < 24h stays active', async () => {
  const jobId = '666666666666';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  // 1h ago
  s.last_activity_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeSession(jobId, s, { bumpActivity: false });

  const read = await readSession(jobId);
  assert.equal(read.status, 'active');

  await deleteSession(jobId);
});

await test('readSession: now injection for deterministic abandon test', async () => {
  const jobId = '777777777777';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  const fixedActivity = '2026-01-01T00:00:00.000Z';
  s.last_activity_at = fixedActivity;
  await writeSession(jobId, s, { bumpActivity: false });

  // now = 2026-01-02T01:00:00Z = 25h after activity → abandoned
  const fakeNow = () => new Date('2026-01-02T01:00:00.000Z');
  const read = await readSession(jobId, { now: fakeNow });
  assert.equal(read.status, 'abandoned');

  // now = 2026-01-01T12:00:00Z = 12h after activity → still active
  const fakeNowEarly = () => new Date('2026-01-01T12:00:00.000Z');
  const readEarly = await readSession(jobId, { now: fakeNowEarly });
  assert.equal(readEarly.status, 'active');

  await deleteSession(jobId);
});

// ── 8. writeSession auto-bump last_activity_at ──────────────────────

await test('writeSession: auto-bumps last_activity_at by default', async () => {
  const jobId = '888888888888';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  const ancient = '2020-01-01T00:00:00.000Z';
  s.last_activity_at = ancient;
  await writeSession(jobId, s); // default bumps
  const read = await readSession(jobId);
  assert.ok(read.last_activity_at > ancient, 'should have been bumped past ancient');

  await deleteSession(jobId);
});

await test('writeSession: bumpActivity=false preserves explicit timestamp', async () => {
  const jobId = '999999999999';
  const s = buildInitialSession({
    jobId,
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
  });
  const explicit = '2026-03-15T12:00:00.000Z';
  s.last_activity_at = explicit;
  await writeSession(jobId, s, { bumpActivity: false });
  const read = await readSession(jobId);
  assert.equal(read.last_activity_at, explicit);

  await deleteSession(jobId);
});

// ── 9. deleteSession idempotency ─────────────────────────────────────

await test('deleteSession: missing file does not throw', async () => {
  await deleteSession('aaaaaaaaaa01'); // never written
  // also re-delete an already-deleted one
  const jobId = 'aaaaaaaaaa02';
  await writeSession(jobId, buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'generic' }));
  await deleteSession(jobId);
  await deleteSession(jobId); // second call should be silent
});

// ── 10. listSessionJobIds filters by 12-hex regex ────────────────────

await test('listSessionJobIds: returns only valid 12-hex jobIds', async () => {
  // Seed several files
  const ids = ['bbbbbbbbbb01', 'bbbbbbbbbb02', 'bbbbbbbbbb03'];
  for (const id of ids) {
    await writeSession(id, buildInitialSession({ jobId: id, jobUrl: 'https://x.com', siteAdapter: 'workday' }));
  }
  // Write some orphan / unrelated files
  await fs.writeFile(path.join(APPLY_SESSIONS_DIR, 'orphan.tmp'), 'x');
  await fs.writeFile(path.join(APPLY_SESSIONS_DIR, 'NOT-HEX.json'), '{}');
  await fs.writeFile(path.join(APPLY_SESSIONS_DIR, 'README.md'), 'note');

  const listed = await listSessionJobIds();
  for (const id of ids) assert.ok(listed.includes(id), `${id} should be listed`);
  assert.ok(!listed.includes('orphan'));
  assert.ok(!listed.includes('NOT-HEX'));
  assert.equal(listed.length, ids.length);

  for (const id of ids) await deleteSession(id);
  await fs.unlink(path.join(APPLY_SESSIONS_DIR, 'orphan.tmp')).catch(() => {});
  await fs.unlink(path.join(APPLY_SESSIONS_DIR, 'NOT-HEX.json')).catch(() => {});
  await fs.unlink(path.join(APPLY_SESSIONS_DIR, 'README.md')).catch(() => {});
});

await test('listSessionJobIds: missing dir → []', async () => {
  // Temporarily move
  if (existsSync(APPLY_SESSIONS_DIR)) {
    await fs.rm(APPLY_SESSIONS_DIR, { recursive: true, force: true });
  }
  const listed = await listSessionJobIds();
  assert.deepEqual(listed, []);
});

// ── 11. Atomic write — failed write doesn't leave tmp file ──────────

await test('atomicWriteJson: bad data (non-serializable) leaves no tmp file', async () => {
  const jobId = 'cccccccccc01';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  // Inject a BigInt — JSON.stringify will throw
  s.field_memory = { x: 5n };
  await assert.rejects(() => writeSession(jobId, s));
  // No leftover tmp files
  if (existsSync(APPLY_SESSIONS_DIR)) {
    const files = await fs.readdir(APPLY_SESSIONS_DIR);
    const tmps = files.filter((f) => f.includes('.tmp.'));
    assert.equal(tmps.length, 0, 'no tmp files should remain after failed write');
  }
});

// ── 12. Review-fix coverage ──────────────────────────────────────────

await test('H1: concurrent writeSession on same jobId — no tmp-file collision, no corruption', async () => {
  const jobId = 'dddddddddd01';
  const base = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  // 50 concurrent writes with different field_memory entries
  const writes = [];
  for (let i = 0; i < 50; i++) {
    const s = { ...base, field_memory: { [`key_${i}`]: `val_${i}` } };
    writes.push(writeSession(jobId, s));
  }
  await Promise.all(writes);
  const final = await readSession(jobId);
  assert.ok(final, 'session must exist after concurrent writes');
  // Final value is from whichever write was last to win the rename race;
  // we just need ONE of them to have landed cleanly.
  assert.ok(Object.keys(final.field_memory).length === 1, 'last-write-wins shape');
  // No leftover tmp files
  const leftFiles = await fs.readdir(APPLY_SESSIONS_DIR);
  const tmps = leftFiles.filter((f) => f.includes('.tmp.'));
  assert.equal(tmps.length, 0, 'no tmp files leaked');

  await deleteSession(jobId);
});

await test('H2: withSessionLock serializes read-modify-write — no lost updates', async () => {
  const jobId = 'dddddddddd02';
  await writeSession(jobId, buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' }));

  // Without the lock these would race and lose updates;
  // with the lock they serialize cleanly.
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      withSessionLock(jobId, async () => {
        const s = await readSession(jobId);
        s.field_memory[`k${i}`] = `v${i}`;
        await writeSession(jobId, s);
      }),
    ),
  );

  const final = await readSession(jobId);
  // Each iteration ADDED a key; serialized → all 20 should be present
  assert.equal(Object.keys(final.field_memory).length, 20, 'no lost updates under lock');

  await deleteSession(jobId);
});

await test('H2: different jobIds run in parallel (no head-of-line blocking)', async () => {
  const id1 = 'eeeeeeeeee01';
  const id2 = 'eeeeeeeeee02';
  // Slow lock on id1 must not block id2
  const start = Date.now();
  let id2Done = false;
  const id1Task = withSessionLock(id1, async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  const id2Task = withSessionLock(id2, async () => {
    id2Done = true;
  });
  await Promise.all([id1Task, id2Task]);
  const elapsed = Date.now() - start;
  assert.ok(id2Done);
  // id2 should finish well before id1's 100ms blocker — parallel run
  assert.ok(elapsed < 200, `lock should not serialize across jobIds (elapsed ${elapsed}ms)`);
});

await test('H3: writeSession refuses to bump activity on status=abandoned (ghost-timestamp guard)', async () => {
  const jobId = 'fffffffff001';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.status = 'abandoned';
  // Default {bumpActivity: true} on abandoned → should throw
  await assert.rejects(() => writeSession(jobId, s), /refuses to bump activity.*abandoned/);
});

await test('H3: bumpActivity=false bypasses the guard (legitimate persist of abandoned-read)', async () => {
  const jobId = 'fffffffff002';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.status = 'abandoned';
  s.last_activity_at = '2026-01-01T00:00:00.000Z';
  await writeSession(jobId, s, { bumpActivity: false });
  const read = await readSession(jobId);
  assert.equal(read.status, 'abandoned');
  assert.equal(read.last_activity_at, '2026-01-01T00:00:00.000Z');

  await deleteSession(jobId);
});

await test('H3: resume flow — flip status=active then write succeeds (no guard fire)', async () => {
  const jobId = 'fffffffff003';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.status = 'active';
  // Synthesize an abandoned read
  const abandoned = { ...s, status: 'abandoned' };
  // Resume flow: flip back to active before write
  const resumed = { ...abandoned, status: 'active' };
  await writeSession(jobId, resumed); // should NOT throw

  await deleteSession(jobId);
});

await test('M1: field_memory cap rejects > 500 entries', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc001', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  for (let i = 0; i < 501; i++) s.field_memory[`k${i}`] = `v${i}`;
  assert.throws(() => ApplySessionSchema.parse(s), /field_memory cap/);
});

await test('M1: per_step_draft cap rejects > 50 entries', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc002', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  for (let i = 0; i < 51; i++) {
    s.per_step_draft[String(i)] = {
      step_idx: i,
      fields: [{ label: 'x', class: 'hard', confidence: 'high' }],
      captured_at: new Date().toISOString(),
    };
  }
  assert.throws(() => ApplySessionSchema.parse(s), /per_step_draft cap/);
});

await test('M2: PerStepDraftFieldSchema.catchall accepts classifier extras (forward-compat)', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc003', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.per_step_draft['0'] = {
    step_idx: 0,
    fields: [
      {
        label: 'Email',
        class: 'hard',
        suggested_value: 'a@b.com',
        confidence: 'high',
        // Classifier extras must pass through
        subclass: 'email',
        source: { kind: 'identity', key: 'identity.email', status: 'found' },
        cost_usd: 0,
        used: 'none',
      },
    ],
    captured_at: new Date().toISOString(),
  };
  assert.doesNotThrow(() => ApplySessionSchema.parse(s));
});

await test('M2: catchall rejects oversized string extras (no balloon attack)', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc004', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.per_step_draft['0'] = {
    step_idx: 0,
    fields: [
      {
        label: 'X',
        class: 'open',
        evil_extra: 'X'.repeat(3000), // > 2000 cap
      },
    ],
    captured_at: new Date().toISOString(),
  };
  assert.throws(() => ApplySessionSchema.parse(s));
});

await test('L3: current_step > total_steps when known → rejected', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc005', jobUrl: 'https://x.com', siteAdapter: 'workday', totalSteps: 5 });
  s.current_step = 7;
  assert.throws(() => ApplySessionSchema.parse(s), /current_step must be ≤ total_steps/);
});

await test('L3: current_step <= total_steps when known → accepted', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc006', jobUrl: 'https://x.com', siteAdapter: 'workday', totalSteps: 5 });
  s.current_step = 5;
  assert.doesNotThrow(() => ApplySessionSchema.parse(s));
});

await test('L3: total_steps=null allows any current_step (exploratory mode)', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc007', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.current_step = 99;
  assert.doesNotThrow(() => ApplySessionSchema.parse(s));
});

await test('strict outer schema: extra top-level field rejected', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc008', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  const bad = { ...s, mystery_field: 'x' };
  assert.throws(() => ApplySessionSchema.parse(bad));
});

await test('schema: current_step must be integer (not float, not negative)', () => {
  const s = buildInitialSession({ jobId: 'ccccccccc009', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.current_step = -1;
  assert.throws(() => ApplySessionSchema.parse(s));
  const s2 = buildInitialSession({ jobId: 'ccccccccc010', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s2.current_step = 1.5;
  assert.throws(() => ApplySessionSchema.parse(s2));
});

await test('readSession: corrupt JSON file → friendly error message', async () => {
  const jobId = 'baaaaaaaaa01';
  await fs.mkdir(APPLY_SESSIONS_DIR, { recursive: true });
  await fs.writeFile(path.join(APPLY_SESSIONS_DIR, `${jobId}.json`), '{bad json');
  await assert.rejects(() => readSession(jobId), /is not valid JSON/);
  await deleteSession(jobId);
});

await test('readSession: valid JSON but schema-invalid → ZodError', async () => {
  const jobId = 'baaaaaaaaa02';
  await fs.mkdir(APPLY_SESSIONS_DIR, { recursive: true });
  await fs.writeFile(path.join(APPLY_SESSIONS_DIR, `${jobId}.json`), '{}');
  await assert.rejects(() => readSession(jobId)); // Zod parse error
  await deleteSession(jobId);
});

await test('writeSession returns validated session (contract)', async () => {
  const jobId = 'baaaaaaaaa03';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  const ret = await writeSession(jobId, s);
  assert.ok(ret);
  assert.equal(ret.jobId, jobId);
  assert.equal(ret.status, 'active');
  // The returned object IS the validated form (passes schema)
  assert.doesNotThrow(() => ApplySessionSchema.parse(ret));

  await deleteSession(jobId);
});

await test('field_memory value at the 4000-char cap (boundary)', () => {
  const s = buildInitialSession({ jobId: 'baaaaaaaaa04', jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.field_memory['k'] = 'X'.repeat(4000);
  assert.doesNotThrow(() => ApplySessionSchema.parse(s));
  s.field_memory['k'] = 'X'.repeat(4001);
  assert.throws(() => ApplySessionSchema.parse(s));
});

await test('listSessionJobIds: sorted output (L1)', async () => {
  // Seed in non-sorted order
  const ids = ['caaaaaaaaa03', 'caaaaaaaaa01', 'caaaaaaaaa02'];
  for (const id of ids) {
    await writeSession(id, buildInitialSession({ jobId: id, jobUrl: 'https://x.com', siteAdapter: 'workday' }));
  }
  const listed = await listSessionJobIds();
  // The sorted ones we seeded are deterministically ordered in the result;
  // other test residue is harmless since we just check our seeds.
  const ourSeeds = listed.filter((id) => id.startsWith('caaaaaaaaa'));
  assert.deepEqual(ourSeeds, ['caaaaaaaaa01', 'caaaaaaaaa02', 'caaaaaaaaa03']);

  for (const id of ids) await deleteSession(id);
});

// ── Cleanup ──────────────────────────────────────────────────────────

await cleanup();

console.log(`\n✅ All ${passed} smoke tests passed.`);
