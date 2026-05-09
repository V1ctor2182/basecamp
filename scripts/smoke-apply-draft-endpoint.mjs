#!/usr/bin/env node
// Smoke for 07-applier/01-mode1 m3: POST /api/career/apply/draft +
// GET /:jobId endpoints. Server-spawn pattern with MOCK_ANTHROPIC=1.
//
// MOCK_ANTHROPIC produces a degenerate "Score: 4.0/5" string that the
// applier draft parser correctly rejects (it's not valid JSON). So the
// success path here returns 502 — that's the WIRING test (the runner is
// invoked + the parse failure is propagated). The success-with-fields
// contract is covered by m2's smoke-draft-prompt.mjs (custom mock client
// in-process). The GET /:jobId round-trip is verified by pre-seeding a
// draft directly via writeDraft.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { writeDraft, deleteDraft, DRAFTS_DIR } from '../src/career/applier/draftsStore.mjs';

const PORT = 4595;
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
const PREFS = path.join(DATA_DIR, 'preferences.yml');
const LLM_COSTS = path.join(DATA_DIR, 'llm-costs.jsonl');
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
const prefsBack = await backup(PREFS);
const costsBack = await backup(LLM_COSTS);

const preExistingReports = new Set();
if (existsSync(REPORTS_DIR)) {
  for (const f of await fs.readdir(REPORTS_DIR)) preExistingReports.add(f);
}
const preExistingDrafts = new Set();
if (existsSync(DRAFTS_DIR)) {
  for (const f of await fs.readdir(DRAFTS_DIR)) preExistingDrafts.add(f);
}

async function writePrefsBudget(daily) {
  const yaml = `targets: []
comp_target:
  currency: USD
location:
  accept_any: false
  remote_only: false
  preferred_cities: []
  acceptable_countries: []
hard_filters:
  source_filter:
    blocked_sources: []
  company_blocklist: []
  title_blocklist: []
  title_allowlist: []
  location:
    allowed_countries: []
    allowed_cities: []
    disallowed_countries: []
  seniority:
    allowed: []
  posted_within_days: 0
  comp_floor:
    currency: USD
  jd_text_blocklist: []
soft_preferences:
  company_types: []
  remote_culture: []
  tech_stack_preferred: []
  tech_stack_avoid: []
  industries_preferred: []
  industries_avoid: []
scoring_weights:
  tech_match: 0.2
  comp_match: 0.2
  location_match: 0.2
  company_match: 0.2
  growth_signal: 0.2
thresholds:
  strong: 4.5
  worth: 4.0
  consider: 3.5
  skip_below: 3.0
evaluator_strategy:
  stage_a:
    enabled: true
    model: claude-haiku-4-5
    threshold: 3.5
  stage_b:
    enabled: true
    model: claude-sonnet-4-6
    daily_budget_usd: ${daily}
    blocks:
      block_b: true
      block_c: false
      block_d: false
      block_e: true
      block_f: false
      block_g: false
`;
  await fs.writeFile(PREFS, yaml);
}

async function writeCosts(records) {
  const lines = records.map((r) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      caller: r.caller ?? 'evaluator:stage-b',
      model: r.model ?? 'claude-sonnet-4-6',
      input_tokens: r.input_tokens ?? 1000,
      output_tokens: r.output_tokens ?? 500,
      cost_usd: r.cost_usd,
    })
  );
  await fs.writeFile(LLM_COSTS, lines.join('\n') + (lines.length ? '\n' : ''));
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    location: ['SF, CA'],
    url: 'https://example.com/jobs/abc',
    description: 'Build safe distributed AI.',
    posted_at: null,
    scraped_at: '2026-05-09T00:00:00Z',
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: {
      stage_a: { score: 4.5, reason: '', model: 'haiku', evaluated_at: '2026-05-09T01:00:00Z', cost_usd: 0.001, status: 'evaluated' },
      stage_b: null,
    },
    ...over,
  };
}

async function writeReport(jobId, content) {
  await fs.writeFile(path.join(REPORTS_DIR, `${jobId}.md`), content);
}

const SAMPLE_REPORT = [
  '## Block A — Role Summary',
  'Mock summary.',
  '',
  '## Block E — Personalization',
  '- section: summary, current: brief, suggested: tailor for backend',
  '',
  '**Total: 4.5/5**',
].join('\n');

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

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(PIPELINE, pipelineBack);
  await restore(PREFS, prefsBack);
  await restore(LLM_COSTS, costsBack);
  if (existsSync(REPORTS_DIR)) {
    for (const f of await fs.readdir(REPORTS_DIR)) {
      if (preExistingReports.has(f)) continue;
      await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
    }
  }
  if (existsSync(DRAFTS_DIR)) {
    for (const f of await fs.readdir(DRAFTS_DIR)) {
      if (preExistingDrafts.has(f)) continue;
      await fs.unlink(path.join(DRAFTS_DIR, f)).catch(() => {});
    }
  }
}

try {
  // ── 1. POST /draft with bad jobId regex → 400 ────────────────────────
  await test('POST /apply/draft with bad jobId regex → 400', async () => {
    await writePrefsBudget(10);
    await writeCosts([]);
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'not-hex' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(JSON.stringify(data), /jobId must match/i);
  });

  // ── 2. POST /draft when budget paused + no force → 402 ──────────────
  await test('POST /apply/draft paused budget + no force → 402 with banner', async () => {
    await writePrefsBudget(10);
    await writeCosts([{ caller: 'evaluator:stage-b', cost_usd: 20 }]);
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab' }),
    });
    assert.equal(r.status, 402);
    const data = await r.json();
    assert.ok(data.banner_message);
    assert.equal(data.today_total_usd, 20);
    assert.equal(data.daily_budget_usd, 10);
  });

  // ── 3. POST /draft when pipeline.json missing → 404 ─────────────────
  await test('POST /apply/draft when pipeline.json absent → 404', async () => {
    await writePrefsBudget(10);
    await writeCosts([]);
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab' }),
    });
    assert.equal(r.status, 404);
  });

  // ── 4. POST /draft when job missing from pipeline → 404 ─────────────
  await test('POST /apply/draft when job not in pipeline → 404', async () => {
    await writePrefsBudget(10);
    await writeCosts([]);
    await fs.writeFile(PIPELINE, JSON.stringify({
      last_scan_at: '2026-05-09T00:00:00Z',
      jobs: [makeJob({ id: 'aaaaaaaaaaaa' })],
      scan_summary: [], totals: {},
    }));
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab' }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /job not found/);
  });

  // ── 5. POST /draft when Stage B report missing → 404 with hint ──────
  await test('POST /apply/draft when reports/{jobId}.md missing → 404 with hint', async () => {
    await writePrefsBudget(10);
    await writeCosts([]);
    await fs.writeFile(PIPELINE, JSON.stringify({
      last_scan_at: '2026-05-09T00:00:00Z',
      jobs: [makeJob()],
      scan_summary: [], totals: {},
    }));
    // Note: NOT writing reports/0123456789ab.md
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab' }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /Stage B report not generated/);
    assert.match(data.hint, /Run Stage B/);
  });

  // ── 6. POST /draft happy-wiring path (MOCK_ANTHROPIC degenerate) → 502
  // Verifies the runner is invoked + the parse failure surfaces. The
  // success-with-valid-fields path is covered by m2's smoke-draft-prompt.
  await test('POST /apply/draft with everything ready → 502 (MOCK_ANTHROPIC degenerate response)', async () => {
    await writePrefsBudget(10);
    await writeCosts([]);
    await fs.writeFile(PIPELINE, JSON.stringify({
      last_scan_at: '2026-05-09T00:00:00Z',
      jobs: [makeJob()],
      scan_summary: [], totals: {},
    }));
    await writeReport('0123456789ab', SAMPLE_REPORT);

    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab' }),
    });
    assert.equal(r.status, 502);
    const data = await r.json();
    assert.match(data.detail, /parse:|api:/);
  });

  // ── 7. POST /draft with budget paused + force=true → 502 (still hits runner)
  await test('POST /apply/draft paused budget + force=true bypasses gate, hits runner', async () => {
    await writePrefsBudget(10);
    await writeCosts([{ caller: 'evaluator:stage-b', cost_usd: 20 }]);
    await fs.writeFile(PIPELINE, JSON.stringify({
      last_scan_at: '2026-05-09T00:00:00Z',
      jobs: [makeJob()],
      scan_summary: [], totals: {},
    }));
    await writeReport('0123456789ab', SAMPLE_REPORT);
    const r = await fetch(`${BASE}/api/career/apply/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab', force: true }),
    });
    // force bypasses 402; runner produces 502 due to MOCK_ANTHROPIC degenerate
    assert.equal(r.status, 502);
  });

  // ── 8. GET /draft/:jobId returns persisted draft (round-trip via direct write)
  await test('GET /apply/draft/:jobId returns persisted draft', async () => {
    const jobId = 'cccccccccccc';
    await writeDraft(jobId, {
      jobId,
      fields: [
        { label: 'Why us?', class: 'open', suggested_value: 'I admire the team.', confidence: 'medium' },
      ],
      generated_at: '2026-05-09T10:00:00Z',
      model: 'claude-sonnet-4-6',
      cost_usd: 0.05,
    });
    const r = await fetch(`${BASE}/api/career/apply/draft/${jobId}`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.jobId, jobId);
    assert.equal(data.fields.length, 1);
    assert.equal(data.fields[0].class, 'open');
    await deleteDraft(jobId);
  });

  // ── 9. GET /draft/:bad-id → 400 + GET /draft/:unknown → 404 ──────────
  await test('GET /apply/draft regex 400 + missing 404', async () => {
    const r1 = await fetch(`${BASE}/api/career/apply/draft/not-hex`);
    assert.equal(r1.status, 400);
    const r2 = await fetch(`${BASE}/api/career/apply/draft/dddddddddddd`);
    assert.equal(r2.status, 404);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
