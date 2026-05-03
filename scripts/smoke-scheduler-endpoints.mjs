#!/usr/bin/env node
// Smoke for GET /api/career/finder/scheduler/status + POST /api/career/finder/scan/source.
// Spawns the server with DISABLE_SCAN_SCHEDULER=1 (no background tick to race
// our test) on a non-default port. Backs up + restores cadence-state file
// around the run so the user's real state isn't disturbed.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4587;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

const DATA_DIR = path.resolve('data', 'career');
const CADENCE_FILE = path.join(DATA_DIR, 'scan-cadence-state.json');
const CADENCE_BACKUP = path.join(DATA_DIR, `scan-cadence-state.json.smoke-backup.${process.pid}`);

await fs.mkdir(DATA_DIR, { recursive: true });
let hadOriginal = false;
try {
  await fs.copyFile(CADENCE_FILE, CADENCE_BACKUP);
  hadOriginal = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// Seed deterministic cadence state for predictable assertions.
async function seedState(state) {
  await fs.writeFile(CADENCE_FILE, JSON.stringify(state, null, 2));
}

const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DISABLE_SCAN_SCHEDULER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverReady = false;
proc.stdout.on('data', (b) => {
  if (b.toString().includes(`API server on :${PORT}`)) serverReady = true;
});
proc.stderr.on('data', () => {}); // quiet during smoke

const t0 = Date.now();
while (!serverReady) {
  if (Date.now() - t0 > 15_000) {
    proc.kill();
    throw new Error('server did not become ready in 15s');
  }
  await new Promise((r) => setTimeout(r, 100));
}

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  if (hadOriginal) {
    await fs.rename(CADENCE_BACKUP, CADENCE_FILE).catch(() => {});
  } else {
    await fs.unlink(CADENCE_FILE).catch(() => {});
  }
}

try {
  // ── GET /scheduler/status — happy path ─────────────────────────────
  await test('GET /scheduler/status returns rows derived from portals.scan_cadence', async () => {
    await seedState({});
    const r = await fetch(`${BASE}/api/career/finder/scheduler/status`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(Array.isArray(data.rows), 'rows must be array');
    // portals.yml has 5 cadence types (greenhouse/ashby/lever/github-md/scrape)
    // and ~5 active source types. Union is ~5; assertion is "at least 1".
    assert.ok(data.rows.length >= 1);
    // Each row has the documented shape
    for (const row of data.rows) {
      assert.ok(typeof row.type === 'string');
      assert.ok('cadence_str' in row);
      assert.ok('cadence_ms' in row);
      assert.ok('cadence_valid' in row);
      assert.ok('last_run_at' in row);
      assert.ok('next_run_at' in row);
      assert.ok('last_outcome' in row);
      assert.ok('has_active_source' in row);
    }
    assert.ok('scan_status' in data);
  });

  // ── GET /scheduler/status reflects cadence-state writes ────────────
  await test('GET /scheduler/status reflects cadenceState last_run_at + next_run_at', async () => {
    const lastRun = '2026-05-01T00:00:00.000Z';
    await seedState({
      greenhouse: {
        last_run_at: lastRun,
        last_outcome: 'ok',
        last_jobs_count: 42,
      },
    });
    const r = await fetch(`${BASE}/api/career/finder/scheduler/status`);
    const data = await r.json();
    const greenhouse = data.rows.find((row) => row.type === 'greenhouse');
    assert.ok(greenhouse, 'greenhouse row exists');
    assert.equal(greenhouse.last_run_at, lastRun);
    assert.equal(greenhouse.last_outcome, 'ok');
    assert.equal(greenhouse.last_jobs_count, 42);
    // next_run_at = last_run + cadence_ms (portals.yml has greenhouse: 72h)
    const expectedNext = new Date(Date.parse(lastRun) + 72 * 60 * 60 * 1000).toISOString();
    assert.equal(greenhouse.next_run_at, expectedNext);
  });

  // ── GET /scheduler/status surfaces last_error ──────────────────────
  await test('GET /scheduler/status surfaces last_error on failed run', async () => {
    await seedState({
      ashby: {
        last_run_at: '2026-05-01T00:00:00.000Z',
        last_outcome: 'error',
        last_error: 'synthetic adapter failure',
      },
    });
    const r = await fetch(`${BASE}/api/career/finder/scheduler/status`);
    const data = await r.json();
    const ashby = data.rows.find((row) => row.type === 'ashby');
    assert.equal(ashby.last_outcome, 'error');
    assert.equal(ashby.last_error, 'synthetic adapter failure');
  });

  // ── POST /scan/source — bad type → 400 ─────────────────────────────
  await test('POST /scan/source { type: "not-real" } → 400', async () => {
    const r = await fetch(`${BASE}/api/career/finder/scan/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'not-real' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /Invalid type/);
  });

  // ── POST /scan/source — missing body field → 400 ───────────────────
  await test('POST /scan/source missing type → 400', async () => {
    const r = await fetch(`${BASE}/api/career/finder/scan/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  // ── POST /scan/source — valid type → 202 + immediate-409-on-second-call ──
  // Single combined test: the first /scan/source returns 202, the second
  // (fired before the first finishes) returns 409. Avoids the test-order
  // hazard of test 5 leaving a scan running into test 6's drain loop.
  await test('POST /scan/source: valid type → 202 + concurrent second call → 409', async () => {
    const first = await fetch(`${BASE}/api/career/finder/scan/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual' }),
    });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.ok(typeof firstBody.scan_id === 'string');
    assert.ok(typeof firstBody.started_at === 'string');
    assert.deepEqual(firstBody.types, ['manual']);
    // Race a second call IMMEDIATELY — pipelineMutex should 409 it.
    const second = await fetch(`${BASE}/api/career/finder/scan/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual' }),
    });
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.match(secondBody.error, /scan already running/);

    // Drain the running scan before letting the test framework exit the
    // try block. Manual-type with no matching source falls back to a full
    // scan (m1 drop-unknown semantics), so this can take ~12s × 1s rate.
    let attempts = 0;
    while (attempts < 200) { // 200 × 200ms = 40s timeout
      const s = await fetch(`${BASE}/api/career/finder/scan/status`).then((x) => x.json());
      if (!s.running) break;
      await new Promise((res) => setTimeout(res, 200));
      attempts++;
    }
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
