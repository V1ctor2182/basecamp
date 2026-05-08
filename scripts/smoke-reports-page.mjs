#!/usr/bin/env node
// Smoke for the Reports page (06-evaluator/05-pipeline-ui m3). The page
// itself is UI; this smoke locks the two endpoint contracts it consumes:
//   GET /api/career/evaluate/stage-b/results   — list view + meta side-fetch
//   GET /api/career/evaluate/stage-b/report/:id — markdown source
// Both endpoints are already shipped by 02-stage-b-sonnet; this smoke
// guards against contract drift and verifies the specific shapes the
// Reports page relies on (status='error' rows surfaced, role/company
// roundtrip for header derivation, error-state shapes for the friendly
// fallback views).

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4589;
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
const PIPELINE = path.join(DATA_DIR, 'pipeline.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(REPORTS_DIR, { recursive: true });

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}
const pipelineBack = await backup(PIPELINE);

const preExistingReports = new Set();
if (existsSync(REPORTS_DIR)) {
  for (const f of await fs.readdir(REPORTS_DIR)) preExistingReports.add(f);
}

function makeJob({ id, company, role, status = 'evaluated', total_score = 4.5, error = null, report_path = null, location = ['SF, CA'], url = 'https://example.com/jobs/x' } = {}) {
  return {
    id,
    source: { type: 'greenhouse', name: company, url: null },
    company,
    role,
    location,
    url,
    description: 'JD',
    posted_at: null,
    scraped_at: '2026-05-08T00:00:00Z',
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: {
      stage_a: { score: 4.2, reason: '', model: 'haiku', evaluated_at: '2026-05-08T01:00:00Z', cost_usd: 0.001, status: 'evaluated' },
      stage_b: status === null ? null : {
        total_score: status === 'error' ? null : total_score,
        report_path: report_path ?? `data/career/reports/${id}.md`,
        blocks_emitted: status === 'error' ? [] : ['A', 'B', 'E'],
        model: 'claude-sonnet-4-6',
        evaluated_at: '2026-05-08T05:00:00Z',
        cost_usd: 0.18,
        web_search_requests: 0,
        tool_rounds_used: 1,
        status,
        ...(status === 'error' ? { error } : {}),
      },
    },
  };
}
function makeFixture(jobs) {
  return { last_scan_at: '2026-05-08T00:00:00Z', jobs, scan_summary: [], totals: {} };
}

const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), MOCK_ANTHROPIC: '1', DISABLE_SCAN_SCHEDULER: '1' },
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

const createdReports = [];

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(PIPELINE, pipelineBack);
  for (const f of createdReports) {
    if (preExistingReports.has(f)) continue;
    await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
  }
}

const SAMPLE_REPORT = `# Stage B Report

## Block A — Role Summary
TL;DR …

## Block B — CV Match
…

## Block E — Personalization
…

Total Score: 4.5/5
`;

try {
  // ── 1. /report/:id round-trips content + total_score + blocks ───────
  await test('/report/:id returns content+meta for evaluated job', async () => {
    const jobId = '111111111111';
    const reportFile = path.join(REPORTS_DIR, `${jobId}.md`);
    await fs.writeFile(reportFile, SAMPLE_REPORT);
    createdReports.push(`${jobId}.md`);

    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: jobId, company: 'Anthropic', role: 'Senior BE' }),
    ])));

    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/${jobId}`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.content, SAMPLE_REPORT);
    assert.equal(data.total_score, 4.5);
    assert.deepEqual(data.blocks_emitted, ['A', 'B', 'E']);
    assert.ok(typeof data.evaluated_at === 'string', 'evaluated_at present');
  });

  // ── 2. /report/:id 400 on jobId failing the regex ───────────────────
  await test('/report/:bad-id → 400 invalid jobId', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/not-hex`);
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error ?? '', /invalid jobId/i);
  });

  // ── 3. /report/:unknown → 404 job not found ─────────────────────────
  await test('/report/:unknown → 404 job not found', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/222222222222`);
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error ?? '', /job not found/i);
  });

  // ── 4. /report/:id 404 when report file missing on disk ─────────────
  // Reports page consumes this fallback to show the friendly "Report not
  // found" CTA back to Pipeline.
  await test('/report/:id → 404 when on-disk file is missing', async () => {
    const jobId = '333333333333';
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: jobId, company: 'A', role: 'r' }),
    ])));
    // Note: NOT writing the .md file
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/${jobId}`);
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error ?? '', /report file missing|no stage_b report/i);
  });

  // ── 5. /results includes status='error' rows for the list view ─────
  await test('/results returns errored stage_b rows with status=error', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: '444444444444', company: 'OK', role: 'r1', status: 'evaluated', total_score: 4.6 }),
      makeJob({ id: '555555555555', company: 'BAD', role: 'r2', status: 'error', error: 'parse failed: missing total-score line' }),
    ])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    assert.equal(r.status, 200);
    const data = await r.json();
    const errRow = data.results.find((x) => x.id === '555555555555');
    assert.ok(errRow, 'errored row present in /results');
    assert.equal(errRow.status, 'error');
    assert.equal(errRow.error, 'parse failed: missing total-score line');
  });

  // ── 6. /results round-trips role + company + url for the detail header
  await test('/results round-trips role + company + url for detail header derivation', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({
        id: '666666666666',
        company: 'Anthropic',
        role: 'Senior Backend Engineer',
        url: 'https://job.example/abc',
        location: ['SF, CA', 'Remote'],
        total_score: 4.7,
      }),
    ])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    const data = await r.json();
    const row = data.results.find((x) => x.id === '666666666666');
    assert.ok(row, 'row present');
    assert.equal(row.company, 'Anthropic');
    assert.equal(row.role, 'Senior Backend Engineer');
    assert.equal(row.url, 'https://job.example/abc');
    assert.deepEqual(row.location, ['SF, CA', 'Remote']);
    assert.equal(row.total_score, 4.7);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
