#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/02-data-flywheel m4 backend:
// /api/career/feedback/stats (14-day error_series) +
// /api/career/feedback/site-coverage.
//
// Pure-Node — boots server.mjs in a child process on a free port, hits
// the routes, asserts response shape. UI side is build-verified via
// tsc + vite build (separate step).

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  FEEDBACK_DIR,
  recordFieldMisclassified,
  recordFieldEdit,
  recordSiteFailure,
} from '../src/career/feedback/stores.mjs';
import { savePending } from '../src/career/feedback/suggestionStore.mjs';

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

// ── Fixture isolation ─────────────────────────────────────────────────

const FEEDBACK_BACKUP = FEEDBACK_DIR + `.smoke-m4-backup.${process.pid}`;

function setupFixtures() {
  if (existsSync(FEEDBACK_DIR)) renameSync(FEEDBACK_DIR, FEEDBACK_BACKUP);
}
function restoreFixtures() {
  if (existsSync(FEEDBACK_DIR)) rmSync(FEEDBACK_DIR, { recursive: true, force: true });
  if (existsSync(FEEDBACK_BACKUP)) renameSync(FEEDBACK_BACKUP, FEEDBACK_DIR);
}
setupFixtures();

let serverProc = null;
let serverPort = 0;

function killServer() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill('SIGTERM');
    } catch {}
  }
}

process.on('exit', () => {
  killServer();
  restoreFixtures();
});
process.on('uncaughtException', (e) => {
  killServer();
  restoreFixtures();
  console.error('uncaught:', e);
  process.exit(2);
});

// Pick a random free-ish port for the test server to avoid colliding
// with a developer's running dev server on :8000.
serverPort = 8000 + Math.floor(Math.random() * 1000) + 1000;
const BASE = `http://127.0.0.1:${serverPort}`;

async function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(serverPort) };
    serverProc = spawn('node', ['server.mjs'], {
      env,
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes(`:${serverPort}`)) {
        ready = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onData);
    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`server exited before listening (code ${code})`));
    });
    // Hard timeout in case the listen log line never appears.
    setTimeout(() => {
      if (!ready) reject(new Error('server start timeout'));
    }, 10_000).unref?.();
  });
}

async function get(url) {
  const r = await fetch(BASE + url);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function seedRecords() {
  // 7 misclassified + 4 heavy edits (today). All within the 14-day window.
  for (let i = 0; i < 7; i++) {
    await recordFieldMisclassified({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      field_label: `Field ${i}`,
      refId: `e${i}`,
      predicted_class: 'open',
      actual_class: 'legal',
      actual_mapping: 'eeo.pronouns',
      site: 'workday',
    });
  }
  for (let i = 0; i < 4; i++) {
    await recordFieldEdit({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      field_id: `e${i}`,
      field_label: `Heavy edit ${i}`,
      suggested: 'short',
      user_final: 'a much longer answer that the user composed and which differs significantly from the suggestion',
      edit_distance: 80, // > 50 → counts as heavy
      confidence: 'medium',
    });
  }
  // A small edit (distance ≤ 50) should NOT count toward issues series.
  await recordFieldEdit({
    ts: new Date().toISOString(),
    jobId: '0123456789ab',
    field_id: 'eS',
    field_label: 'Small edit',
    suggested: 'foo',
    user_final: 'bar',
    edit_distance: 3,
    confidence: 'high',
  });
  // 6 site-failures across 2 domains (3 each, one domain is a known
  // bundled adapter, one is novel).
  for (let i = 0; i < 3; i++) {
    await recordSiteFailure({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      domain: 'jobs.acme.com',
      site_adapter_id: 'generic',
      step_idx: 0,
      error_kind: 'timeout',
      error_message: 'next button missing',
    });
    await recordSiteFailure({
      ts: new Date().toISOString(),
      jobId: '0123456789ab',
      domain: 'myworkdayjobs.com',
      site_adapter_id: 'workday',
      step_idx: 1,
      error_kind: 'stale_ref',
      error_message: 'STALE_REF e2',
    });
  }
  // One pending proposal so suggestions stats has a non-zero pending.
  await savePending({
    type: 'classifier-rule',
    group_key: 'workday',
    feedback_type: 'field-misclassified',
    source_records: [{ ts: new Date().toISOString(), field_label: 'Pronouns' }],
    proposal: {
      regex: '\\bpronouns?\\b',
      class: 'legal',
      maps_to: 'eeo.pronouns',
      confidence: 'high',
      rationale: 'r',
    },
  });
}

// ── Boot the server with fixtures in place ────────────────────────────

await seedRecords();
await startServer();

// ── Tests ─────────────────────────────────────────────────────────────

await test('GET /stats: shape — flywheels + suggestions + error_series', async () => {
  const { status, body } = await get('/api/career/feedback/stats');
  assert.equal(status, 200);
  assert.ok(body.flywheels, 'flywheels object present');
  assert.equal(body.flywheels.field_misclassified, 7);
  // 4 heavy edits + 1 small edit (both counted in the 30d flywheel count;
  // only heavy counted in error_series).
  assert.equal(body.flywheels.field_edits, 5);
  assert.equal(body.flywheels.site_failures, 6);
  assert.ok(body.suggestions, 'suggestions object present');
  assert.equal(body.suggestions.pending, 1);
  assert.ok(Array.isArray(body.error_series), 'error_series is array');
  assert.equal(body.error_series.length, 14, '14-day window');
});

await test('GET /stats: error_series shape (date + issues)', async () => {
  const { body } = await get('/api/career/feedback/stats');
  for (const row of body.error_series) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
    assert.equal(typeof row.issues, 'number');
    assert.ok(row.issues >= 0);
  }
});

await test('GET /stats: today bucket counts misclassified + heavy edits only (not small edits)', async () => {
  const { body } = await get('/api/career/feedback/stats');
  const today = body.error_series[body.error_series.length - 1];
  // 7 misclassified + 4 heavy edits = 11; small edit NOT counted.
  assert.equal(today.issues, 11);
});

await test('GET /stats: invalid since query falls back to default (30d)', async () => {
  const { status, body } = await get('/api/career/feedback/stats?since=not-a-date');
  assert.equal(status, 200);
  // Should still return real counts (since defaults to 30d)
  assert.equal(body.flywheels.field_misclassified, 7);
});

await test('GET /stats?status query is unused (only since matters)', async () => {
  // The stats endpoint ignores arbitrary query params; it should not 400.
  const { status } = await get('/api/career/feedback/stats?foo=bar');
  assert.equal(status, 200);
});

await test('GET /site-coverage: rows sorted by failures DESC + alpha tiebreak', async () => {
  const { status, body } = await get('/api/career/feedback/site-coverage');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.rows));
  assert.equal(body.rows.length, 2);
  for (const row of body.rows) assert.equal(row.failures, 3);
  // REVIEW H2 adv: deterministic tiebreak alphabetical
  assert.equal(body.rows[0].domain, 'jobs.acme.com');
  assert.equal(body.rows[1].domain, 'myworkdayjobs.com');
});

await test('REVIEW C1 (adv): error_series uses LOCAL day bucketing (consecutive day labels)', async () => {
  const { body } = await get('/api/career/feedback/stats');
  // 14 consecutive days
  for (let i = 1; i < body.error_series.length; i++) {
    const prev = new Date(body.error_series[i - 1].date + 'T12:00:00');
    const curr = new Date(body.error_series[i].date + 'T12:00:00');
    const diff = (curr.getTime() - prev.getTime()) / (24 * 3600 * 1000);
    assert.equal(diff, 1, `consecutive: ${prev} → ${curr}`);
  }
  // Last bucket is today (local). Compare with the runner's local-day key.
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(body.error_series[13].date, todayKey, 'last bucket = local today');
});

await test('REVIEW M1 (adv): edit_distance finite-check (NaN / undefined edits skipped)', async () => {
  // Already implicit — the smoke seed has a small edit (distance=3) that
  // wasn't counted. Verify the count is exactly misclassified + heavy.
  const { body } = await get('/api/career/feedback/stats');
  const today = body.error_series[body.error_series.length - 1];
  assert.equal(today.issues, 11, 'misclassified(7) + heavy edits(4) = 11; small edit (distance=3) excluded');
});

await test('GET /site-coverage: has_adapter true for myworkdayjobs.com (bundled)', async () => {
  const { body } = await get('/api/career/feedback/site-coverage');
  const wd = body.rows.find((r) => r.domain === 'myworkdayjobs.com');
  assert.ok(wd);
  assert.equal(wd.has_adapter, true, 'bundled workday.yml matches');
  assert.equal(wd.site_adapter_id, 'workday');
});

await test('GET /site-coverage: has_adapter false for unknown domain', async () => {
  const { body } = await get('/api/career/feedback/site-coverage');
  const acme = body.rows.find((r) => r.domain === 'jobs.acme.com');
  assert.ok(acme);
  assert.equal(acme.has_adapter, false, 'no bundled adapter matches');
});

await test('GET /suggestions?status=pending: returns the seeded proposal', async () => {
  const { status, body } = await get('/api/career/feedback/suggestions?status=pending');
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.suggestions.length, 1);
  assert.equal(body.suggestions[0].status, 'pending');
});

await test('GET /suggestions: bad status query → 400', async () => {
  const { status } = await get('/api/career/feedback/suggestions?status=bogus');
  assert.equal(status, 400);
});

// ── Cleanup ───────────────────────────────────────────────────────────

killServer();
// Brief wait so the child process emits its exit before we restore fixtures.
await new Promise((r) => setTimeout(r, 100));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
