#!/usr/bin/env node
// Smoke for 08-human-gate-tracker/01-application-state m2: REST endpoints.
// Server-spawn pattern. Pre-seeds applications.json with one Evaluated row,
// then exercises GET / status transitions / timeline append / illegal
// transition / regex / 404 / concurrent writes.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4591;
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
const APPLICATIONS = path.join(DATA_DIR, 'applications.json');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}
const applicationsBack = await backup(APPLICATIONS);

function makeRow(id, over = {}) {
  return {
    id,
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    url: 'https://example.com/jobs/abc',
    score: 4.5,
    status: 'Evaluated',
    legitimacy: 'Unknown',
    reportPath: `data/career/reports/${id.split('-')[0]}.md`,
    pdfPath: null,
    resumeId: null,
    timeline: [{ ts: '2026-05-08T10:00:00Z', event: 'created' }],
    ...over,
  };
}

async function seedApplications(rows) {
  await fs.writeFile(APPLICATIONS, JSON.stringify(rows, null, 2));
}

const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DISABLE_SCAN_SCHEDULER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverReady = false;
proc.stdout.on('data', (b) => {
  if (b.toString().includes(`API server on :${PORT}`)) serverReady = true;
});
proc.stderr.on('data', () => {});
const t0 = Date.now();
while (!serverReady) {
  if (Date.now() - t0 > 15_000) { proc.kill(); throw new Error('server did not become ready in 15s'); }
  await new Promise((r) => setTimeout(r, 100));
}

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(APPLICATIONS, applicationsBack);
}

try {
  // ── 1. GET /applications returns the seeded row ─────────────────────
  await test('GET /applications returns seeded row + counts', async () => {
    await seedApplications([makeRow('aaaaaaaaaaaa-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 1);
    assert.equal(data.filtered, 1);
    assert.equal(data.results[0].id, 'aaaaaaaaaaaa-20260508');
    assert.equal(data.results[0].status, 'Evaluated');
  });

  // ── 2. POST /:id/status Evaluated → Applied succeeds ────────────────
  await test('POST /:id/status Evaluated → Applied succeeds + appends event', async () => {
    await seedApplications([makeRow('bbbbbbbbbbbb-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications/bbbbbbbbbbbb-20260508/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Applied', note: 'submitted via Workday' }),
    });
    const updated = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(updated)}`);
    assert.equal(updated.status, 'Applied');
    assert.equal(updated.timeline.length, 2);
    assert.equal(updated.timeline[1].event, 'status_changed');
    assert.equal(updated.timeline[1].from, 'Evaluated');
    assert.equal(updated.timeline[1].to, 'Applied');
    assert.equal(updated.timeline[1].note, 'submitted via Workday');
  });

  // ── 3. POST /:id/status Evaluated → Interview → 400 with allowed_next
  await test('POST illegal jump returns 400 with structured allowed_next', async () => {
    await seedApplications([makeRow('cccccccccccc-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications/cccccccccccc-20260508/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Interview' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.equal(data.current_status, 'Evaluated');
    assert.deepEqual(
      [...data.allowed_next].sort(),
      ['Applied', 'Discarded', 'SKIP'].sort()
    );
  });

  // ── 4. POST with bad id regex → 400 ─────────────────────────────────
  await test('POST /:bad-id/status → 400 (regex)', async () => {
    const r = await fetch(`${BASE}/api/career/applications/not-hex-id/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Applied' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /invalid id/);
  });

  // ── 5. GET /:unknown-id → 404 ───────────────────────────────────────
  await test('GET /:unknown-valid-id → 404', async () => {
    await seedApplications([makeRow('dddddddddddd-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications/eeeeeeeeeeee-20260508`);
    assert.equal(r.status, 404);
  });

  // ── 6. ?status=CSV filter ───────────────────────────────────────────
  await test('?status=Applied filter returns only Applied rows', async () => {
    await seedApplications([
      makeRow('111111111111-20260508', { status: 'Evaluated' }),
      makeRow('222222222222-20260508', {
        status: 'Applied',
        timeline: [
          { ts: '2026-05-08T10:00:00Z', event: 'created' },
          { ts: '2026-05-08T11:00:00Z', event: 'status_changed', from: 'Evaluated', to: 'Applied' },
        ],
      }),
      makeRow('333333333333-20260508', {
        status: 'Applied',
        timeline: [
          { ts: '2026-05-08T10:00:00Z', event: 'created' },
          { ts: '2026-05-08T12:00:00Z', event: 'status_changed', from: 'Evaluated', to: 'Applied' },
        ],
      }),
    ]);
    const r = await fetch(`${BASE}/api/career/applications?status=Applied`);
    const data = await r.json();
    assert.equal(data.total, 3);
    assert.equal(data.filtered, 2);
    for (const row of data.results) assert.equal(row.status, 'Applied');
    // Sort by max(timeline.ts) desc — 333 (12:00) before 222 (11:00)
    assert.equal(data.results[0].id, '333333333333-20260508');
  });

  // ── 7. ?status=Bogus → 400 ──────────────────────────────────────────
  await test('?status=BogusValue → 400 (unknown filter)', async () => {
    await seedApplications([makeRow('444444444444-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications?status=Bogus`);
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /unknown status filter/);
  });

  // ── 8. POST /:id/timeline event:'correction' appends ─────────────────
  await test('POST /:id/timeline {correction} appends free-form event', async () => {
    await seedApplications([makeRow('555555555555-20260508')]);
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const r = await fetch(`${BASE}/api/career/applications/555555555555-20260508/timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'correction', note: 'fixed company name', ts: futureTs }),
    });
    const updated = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(updated)}`);
    assert.equal(updated.timeline.length, 2);
    assert.equal(updated.timeline[1].event, 'correction');
    assert.equal(updated.timeline[1].note, 'fixed company name');
  });

  // ── 9. POST /:id/timeline backdated → 400 ──────────────────────────
  await test('POST /:id/timeline backdated ts → 400 (append-only violation)', async () => {
    await seedApplications([makeRow('666666666666-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications/666666666666-20260508/timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'note', note: 'too old', ts: '2020-01-01T00:00:00Z' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /Append-only|earlier/i);
  });

  // ── 10. POST timeline rejects reserved internal events ──────────────
  await test('POST /:id/timeline {status_changed} → 400 (reserved internal)', async () => {
    await seedApplications([makeRow('777777777777-20260508')]);
    const r = await fetch(`${BASE}/api/career/applications/777777777777-20260508/timeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'status_changed' }),
    });
    assert.equal(r.status, 400);
    // Zod rejects 'status_changed' because USER_TIMELINE_EVENTS excludes it
    const data = await r.json();
    assert.match(JSON.stringify(data), /event|enum|expected/i);
  });

  // ── 11. Concurrent POST status: mutex serializes; second sees new state ─
  await test('Concurrent /:id/status POSTs serialize via applicationsMutex', async () => {
    await seedApplications([makeRow('888888888888-20260508')]);
    // Fire two concurrent transitions: both Evaluated→Applied. Mutex
    // serializes them. The first wins; the second sees status=Applied
    // and gets InvalidTransitionError 400 (Applied→Applied not allowed).
    const reqA = fetch(`${BASE}/api/career/applications/888888888888-20260508/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Applied' }),
    });
    const reqB = fetch(`${BASE}/api/career/applications/888888888888-20260508/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Applied' }),
    });
    const [resA, resB] = await Promise.all([reqA, reqB]);
    const statuses = [resA.status, resB.status].sort();
    // Either: one 200 + one 400 (InvalidTransition because second sees state changed)
    // OR: one 200 + one 409 (mutex contention if the second hit acquire while
    // first was mid-transition)
    assert.ok(
      (statuses[0] === 200 && (statuses[1] === 400 || statuses[1] === 409)),
      `expected one 200 + one 400-or-409, got ${statuses}`
    );
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
