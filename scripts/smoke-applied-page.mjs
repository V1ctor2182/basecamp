#!/usr/bin/env node
// Smoke for 08-human-gate-tracker/02-career-dashboard-views m1:
// Applied.tsx page consumer contract over GET /api/career/applications
// and POST /api/career/applications/:id/status.
//
// The page is React; this smoke locks the endpoint shapes Applied.tsx
// consumes + verifies the Advance Status flow (legal transition →
// timeline event; illegal jump → 400 with allowed_next).
//
// Endpoints are already shipped by 08/01 m2 — this smoke is a consumer
// contract test for the Applied.tsx integration, not a re-verification
// of the endpoints themselves.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4599;
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

const TODAY_SUFFIX = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

function makeRow(jobId, status = 'Applied', extra = {}) {
  return {
    id: `${jobId}-${TODAY_SUFFIX}`,
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    url: 'https://example.com/jobs/abc',
    score: 4.5,
    status,
    legitimacy: 'Unknown',
    reportPath: `data/career/reports/${jobId}.md`,
    pdfPath: null,
    resumeId: null,
    timeline: [
      { ts: '2026-05-09T10:00:00Z', event: 'created' },
      ...(status !== 'Evaluated' ? [{
        ts: '2026-05-09T11:00:00Z',
        event: 'status_changed',
        from: 'Evaluated',
        to: status,
        note: 'manual transition for smoke',
      }] : []),
    ],
    ...extra,
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
  // ── 1. GET /applications returns the Applied.tsx-consumed shape ─────
  await test('GET /applications returns shape Applied.tsx renders', async () => {
    await seedApplications([
      makeRow('aaaaaaaaaaaa', 'Applied'),
      makeRow('bbbbbbbbbbbb', 'Interview'),
      makeRow('cccccccccccc', 'Discarded'),
    ]);
    const r = await fetch(`${BASE}/api/career/applications`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 3);
    assert.equal(data.results.length, 3);
    // Every row must have the Applied.tsx-required fields
    for (const row of data.results) {
      assert.equal(typeof row.id, 'string');
      assert.equal(typeof row.company, 'string');
      assert.equal(typeof row.role, 'string');
      assert.ok(Array.isArray(row.timeline));
      assert.ok(typeof row.score === 'number' || row.score === null);
      assert.ok(['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'].includes(row.status));
    }
  });

  // ── 2. ?status=Applied filter ───────────────────────────────────────
  await test('?status=Applied filter returns only Applied rows with timeline preserved', async () => {
    await seedApplications([
      makeRow('aaaaaaaaaaaa', 'Applied'),
      makeRow('bbbbbbbbbbbb', 'Interview'),
      makeRow('cccccccccccc', 'Applied'),
    ]);
    const r = await fetch(`${BASE}/api/career/applications?status=Applied`);
    const data = await r.json();
    assert.equal(data.total, 3);
    assert.equal(data.filtered, 2);
    for (const row of data.results) {
      assert.equal(row.status, 'Applied');
      assert.ok(row.timeline.length >= 2, 'timeline preserved through filter');
    }
  });

  // ── 3. POST /:id/status {Responded} from Applied → 200 + event ─────
  await test('Advance Applied → Responded transitions cleanly + appends timeline event', async () => {
    const jobId = 'dddddddddddd';
    await seedApplications([makeRow(jobId, 'Applied')]);
    const r = await fetch(`${BASE}/api/career/applications/${jobId}-${TODAY_SUFFIX}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Responded' }),
    });
    const data = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'Responded');
    const lastEvent = data.timeline[data.timeline.length - 1];
    assert.equal(lastEvent.event, 'status_changed');
    assert.equal(lastEvent.from, 'Applied');
    assert.equal(lastEvent.to, 'Responded');
  });

  // ── 4. Quick Discard from any non-terminal: Interview → Discarded ───
  await test('Quick Discard: Interview → Discarded allowed (terminal-from-any-non-terminal)', async () => {
    const jobId = 'eeeeeeeeeeee';
    await seedApplications([makeRow(jobId, 'Interview')]);
    const r = await fetch(`${BASE}/api/career/applications/${jobId}-${TODAY_SUFFIX}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Discarded' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.status, 'Discarded');
  });

  // ── 5. Illegal jump Applied → Offer → 400 with allowed_next ────────
  await test('Illegal jump: Applied → Offer → 400 with allowed_next', async () => {
    const jobId = 'ffffffffffff';
    await seedApplications([makeRow(jobId, 'Applied')]);
    const r = await fetch(`${BASE}/api/career/applications/${jobId}-${TODAY_SUFFIX}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Offer' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.equal(data.current_status, 'Applied');
    assert.deepEqual(
      [...data.allowed_next].sort(),
      ['Discarded', 'Responded', 'SKIP'].sort()
    );
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
