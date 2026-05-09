#!/usr/bin/env node
// Smoke for 07-applier/01-mode1 m4: POST /api/career/apply/submitted.
// Server-spawn pattern. Pre-seeds applications.json with an Evaluated row
// + qa-bank/history.jsonl as empty, then exercises the Mark Submitted
// path: status transition + history.jsonl append.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4596;
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
const QA_HISTORY = path.join(DATA_DIR, 'qa-bank', 'history.jsonl');
const QA_BANK_DIR = path.join(DATA_DIR, 'qa-bank');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(QA_BANK_DIR, { recursive: true });

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}
const applicationsBack = await backup(APPLICATIONS);
const qaHistoryBack = await backup(QA_HISTORY);

const TODAY_SUFFIX = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

function makeApplicationRow(jobId, status = 'Evaluated') {
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
    timeline: [{ ts: '2026-05-09T10:00:00Z', event: 'created' }],
  };
}

async function seedApplications(rows) {
  await fs.writeFile(APPLICATIONS, JSON.stringify(rows, null, 2));
}

async function readHistory() {
  if (!existsSync(QA_HISTORY)) return [];
  const raw = await fs.readFile(QA_HISTORY, 'utf-8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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
  await restore(QA_HISTORY, qaHistoryBack);
}

const SAMPLE_FIELDS = [
  { label: 'Full name', final_answer: 'Jane Doe', class: 'hard' },
  { label: 'Authorized to work in US?', final_answer: 'Yes', class: 'legal' },
  { label: 'Why this company?', final_answer: 'I admire the mission.', class: 'open' },
  { label: 'Resume / CV upload', final_answer: 'data/career/output/aaaaaaaaaaaa-default.pdf', class: 'file' },
];

try {
  // ── 1. Happy path: Evaluated → Applied + history.jsonl gets all 4 fields
  await test('POST /apply/submitted Evaluated→Applied + appends all 4 fields', async () => {
    const jobId = 'aaaaaaaaaaaa';
    await seedApplications([makeApplicationRow(jobId)]);
    await fs.writeFile(QA_HISTORY, ''); // empty start

    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, fields: SAMPLE_FIELDS, note: 'submitted via Workday' }),
    });
    const data = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(data)}`);
    assert.equal(data.application.status, 'Applied');
    assert.equal(data.application.timeline.length, 2);
    assert.equal(data.application.timeline[1].event, 'status_changed');
    assert.equal(data.application.timeline[1].from, 'Evaluated');
    assert.equal(data.application.timeline[1].to, 'Applied');
    assert.equal(data.application.timeline[1].note, 'submitted via Workday');
    assert.equal(data.history_lines_added, 4);

    const history = await readHistory();
    assert.equal(history.length, 4);
    assert.equal(history[0].jobId, jobId);
    assert.deepEqual(
      history.map((h) => h.class).sort(),
      ['file', 'hard', 'legal', 'open']
    );
    // Every history entry has all 5 required keys
    for (const h of history) {
      for (const k of ['ts', 'jobId', 'label', 'final_answer', 'class']) {
        assert.ok(k in h, `missing ${k}`);
      }
    }
  });

  // ── 2. Re-submit when already Applied → 400 with allowed_next ────────
  await test('POST /apply/submitted on Applied → 400 with allowed_next', async () => {
    const jobId = 'bbbbbbbbbbbb';
    await seedApplications([makeApplicationRow(jobId, 'Applied')]);
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, fields: [SAMPLE_FIELDS[0]] }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.equal(data.current_status, 'Applied');
    assert.deepEqual(
      [...data.allowed_next].sort(),
      ['Discarded', 'Responded', 'SKIP'].sort()
    );
  });

  // ── 3. Bad jobId regex → 400 ─────────────────────────────────────────
  await test('POST /apply/submitted with bad jobId regex → 400', async () => {
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'not-hex', fields: [SAMPLE_FIELDS[0]] }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(JSON.stringify(data), /jobId must match/);
  });

  // ── 4. No applications row → 404 with hint ───────────────────────────
  await test('POST /apply/submitted with no application row → 404 with hint', async () => {
    await seedApplications([]);
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'cccccccccccc', fields: [SAMPLE_FIELDS[0]] }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /no applications.json row/);
    assert.match(data.hint, /Stage B/);
  });

  // ── 5. Empty fields[] → 400 (Zod min(1)) ──────────────────────────────
  await test('POST /apply/submitted with empty fields[] → 400', async () => {
    const jobId = 'dddddddddddd';
    await seedApplications([makeApplicationRow(jobId)]);
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, fields: [] }),
    });
    assert.equal(r.status, 400);
  });

  // ── 6. Cross-day fallback (id with prefix matching) ──────────────────
  await test('POST /apply/submitted falls back to most-recent matching jobId prefix', async () => {
    const jobId = 'eeeeeeeeeeee';
    // Compute yesterday's date robustly (don't hardcode — fragile across
    // calendar boundaries). Robust against running on any date.
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdaySuffix = `${yesterday.getFullYear()}${String(yesterday.getMonth() + 1).padStart(2, '0')}${String(yesterday.getDate()).padStart(2, '0')}`;
    const yesterdayId = `${jobId}-${yesterdaySuffix}`;
    // Also seed an even-older row to verify the newest-first sort tie-break
    const dayBefore = new Date(Date.now() - 2 * 86_400_000);
    const dayBeforeSuffix = `${dayBefore.getFullYear()}${String(dayBefore.getMonth() + 1).padStart(2, '0')}${String(dayBefore.getDate()).padStart(2, '0')}`;
    const dayBeforeId = `${jobId}-${dayBeforeSuffix}`;
    await seedApplications([
      // Seed in oldest-first order on disk to verify the sort picks newest
      { ...makeApplicationRow(jobId), id: dayBeforeId },
      { ...makeApplicationRow(jobId), id: yesterdayId },
    ]);
    await fs.writeFile(QA_HISTORY, '');

    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, fields: [SAMPLE_FIELDS[2]] }),
    });
    const data = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(data)}`);
    assert.equal(
      data.application.id,
      yesterdayId,
      `fallback should pick most-recent (yesterday) over older (day-before); got ${data.application.id}`
    );
    assert.equal(data.application.status, 'Applied');
    assert.equal(data.history_lines_added, 1);
    assert.equal(data.partial, false);
  });

  // ── 7. Unknown class in fields → 400 (Zod) ───────────────────────────
  await test('POST /apply/submitted with unknown class → 400', async () => {
    const jobId = 'ffffffffffff';
    await seedApplications([makeApplicationRow(jobId)]);
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        fields: [{ label: 'X', final_answer: 'Y', class: 'mystery' }],
      }),
    });
    assert.equal(r.status, 400);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
