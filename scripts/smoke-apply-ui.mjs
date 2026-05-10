#!/usr/bin/env node
// Smoke for 07-applier/01-mode1 m5: Apply.tsx UI page contracts.
// The page itself is React; this smoke locks the API shapes Apply.tsx
// consumes — verifies that GET /apply/draft/:jobId returns the
// DraftSchema-shape Apply.tsx renders + POST /apply/submitted accepts
// the body shape Apply.tsx sends.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { writeDraft, deleteDraft } from '../src/career/applier/draftsStore.mjs';

const PORT = 4598;
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
const qaHistoryBack = await backup(QA_HISTORY);

const TODAY_SUFFIX = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();

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

try {
  // ── 1. GET /apply/draft/:jobId returns a 4-class shape Apply.tsx renders
  await test('GET /apply/draft/:jobId returns persisted draft with all 4 classes', async () => {
    const jobId = 'aaaaaaaaaaaa';
    await writeDraft(jobId, {
      jobId,
      fields: [
        { label: 'Full name', class: 'hard', suggested_value: 'Jane Doe', confidence: 'high', source_ref: 'identity.yml#full_name' },
        { label: 'Authorized to work?', class: 'legal', suggested_value: 'Yes', confidence: 'high', source_ref: 'qa-bank/legal.yml#work_authorization.authorized_us_yes_no' },
        { label: 'Why this company?', class: 'open', suggested_value: 'I admire the team.', confidence: 'medium' },
        { label: 'Resume / CV upload', class: 'file', suggested_value: 'data/career/output/aaaaaaaaaaaa-default.pdf', confidence: 'high' },
      ],
      generated_at: '2026-05-09T10:00:00Z',
      model: 'claude-sonnet-4-6',
      cost_usd: 0.05,
    });
    const r = await fetch(`${BASE}/api/career/apply/draft/${jobId}`);
    assert.equal(r.status, 200);
    const d = await r.json();
    // Shape that Apply.tsx renders
    assert.equal(d.jobId, jobId);
    assert.equal(d.fields.length, 4);
    assert.equal(typeof d.cost_usd, 'number');
    assert.equal(typeof d.generated_at, 'string');
    assert.equal(typeof d.model, 'string');
    // Each field has the shape the Apply.tsx field-card renderer expects
    const classes = d.fields.map((f) => f.class).sort();
    assert.deepEqual(classes, ['file', 'hard', 'legal', 'open']);
    for (const f of d.fields) {
      assert.equal(typeof f.label, 'string');
      assert.equal(typeof f.suggested_value, 'string');
      assert.ok(['hard', 'legal', 'open', 'file'].includes(f.class));
      assert.ok(['high', 'medium', 'low'].includes(f.confidence));
    }
    await deleteDraft(jobId);
  });

  // ── 2. POST /apply/submitted accepts the Apply.tsx body shape ────────
  await test('POST /apply/submitted accepts {jobId, fields:[{label, final_answer, class}]}', async () => {
    const jobId = 'bbbbbbbbbbbb';
    // Pre-seed Evaluated application row
    await fs.writeFile(APPLICATIONS, JSON.stringify([{
      id: `${jobId}-${TODAY_SUFFIX}`,
      company: 'Anthropic',
      role: 'Senior BE',
      url: 'https://example.com/jobs/x',
      score: 4.5,
      status: 'Evaluated',
      legitimacy: 'Unknown',
      reportPath: `data/career/reports/${jobId}.md`,
      pdfPath: null,
      resumeId: null,
      timeline: [{ ts: '2026-05-09T10:00:00Z', event: 'created' }],
    }], null, 2));
    await fs.writeFile(QA_HISTORY, '');

    // Body shape EXACTLY what Apply.tsx markSubmitted() sends
    const body = {
      jobId,
      fields: [
        { label: 'Full name', final_answer: 'Jane Doe', class: 'hard' },
        { label: 'Why this company?', final_answer: 'My edited answer.', class: 'open' },
      ],
    };
    const r = await fetch(`${BASE}/api/career/apply/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    assert.equal(r.status, 200, `non-200: ${JSON.stringify(data)}`);
    assert.equal(data.application.status, 'Applied');
    assert.equal(data.history_lines_added, 2);
    assert.equal(data.total_fields, 2);
    assert.equal(data.partial, false);
  });

  // ── 3. Apply.tsx 404 → auto-generate path: GET 404 propagates ────────
  await test('GET /apply/draft/:unknown → 404 (Apply.tsx auto-generates)', async () => {
    const r = await fetch(`${BASE}/api/career/apply/draft/cccccccccccc`);
    assert.equal(r.status, 404);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
