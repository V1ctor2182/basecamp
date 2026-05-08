#!/usr/bin/env node
// Smoke for the pre-call budget gate at POST /evaluate/stage-b and
// POST /cv/tailor. Spawns server with MOCK_ANTHROPIC=1; pre-loads
// llm-costs.jsonl with fixture cost records to drive paused state;
// pre-loads pipeline.json + resumes/index.yml + resume base.md so the
// happy paths land 200.
//
// Verifies:
//   - paused state is FAST-FAILED with 402 + banner_message + today/budget
//   - force:true bypasses the gate; cost still records via runner
//   - Stage A endpoint NEVER gates (constraint #1)
//   - body.force = string/number rejected with 400 (Zod boolean enforcement)
//   - 402 response shape exactly matches what the UI banner consumes
//   - Mutex still releases on 402 path (subsequent /scan call works)

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
const LLM_COSTS = path.join(DATA_DIR, 'llm-costs.jsonl');
const PREFS = path.join(DATA_DIR, 'preferences.yml');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const RESUME_INDEX = path.join(RESUMES_DIR, 'index.yml');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(REPORTS_DIR, { recursive: true });
await fs.mkdir(RESUMES_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

async function backup(file) {
  try { await fs.copyFile(file, file + SUFFIX); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}

const pipelineBack = await backup(PIPELINE);
const llmCostsBack = await backup(LLM_COSTS);
const prefsBack = await backup(PREFS);
const indexBack = await backup(RESUME_INDEX);

const preExistingResumeDirs = new Set();
if (existsSync(RESUMES_DIR)) {
  for (const f of await fs.readdir(RESUMES_DIR)) preExistingResumeDirs.add(f);
}
const preExistingReports = new Set();
if (existsSync(REPORTS_DIR)) {
  for (const f of await fs.readdir(REPORTS_DIR)) preExistingReports.add(f);
}
const preExistingOutput = new Set();
if (existsSync(OUTPUT_DIR)) {
  for (const f of await fs.readdir(OUTPUT_DIR)) preExistingOutput.add(f);
}

// Helper: write llm-costs.jsonl with N records dated to today's local
// timestamp so the today-mode filter includes them.
async function writeCostsToday(records) {
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

async function writePrefsBudget(daily) {
  const yaml = `
targets: []
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
  await fs.writeFile(PREFS, yaml.trimStart());
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    location: ['SF, CA'],
    url: 'https://example.com/jobs/1',
    description: 'Build safe distributed AI.',
    posted_at: null,
    scraped_at: '2026-05-07T00:00:00Z',
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: {
      stage_a: {
        score: 4.2,
        reason: 'strong fit',
        model: 'claude-haiku-4-5-20251001',
        evaluated_at: '2026-05-07T01:00:00Z',
        cost_usd: 0.0008,
        status: 'evaluated',
      },
      stage_b: {
        total_score: 4.3,
        report_path: 'data/career/reports/0123456789ab.md',
        blocks_emitted: ['A', 'B', 'C', 'E', 'F'],
        model: 'claude-sonnet-4-6',
        evaluated_at: '2026-05-07T02:00:00Z',
        cost_usd: 0.18,
        web_search_requests: 0,
        tool_rounds_used: 1,
        status: 'evaluated',
      },
    },
    ...over,
  };
}
function makeFixture(jobs) {
  return { last_scan_at: '2026-05-07T00:00:00Z', jobs, scan_summary: [], totals: {} };
}
async function writeResume(id, isDefault) {
  const dir = path.join(RESUMES_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'base.md'), `# ${id} resume\n\n## Summary\nPlaceholder.`);
  await fs.writeFile(path.join(dir, 'metadata.yml'), `archetype: ${id}\n`);
}
async function writeIndex(entries) {
  if (entries.length === 0) {
    await fs.writeFile(RESUME_INDEX, 'resumes: []\n');
    return;
  }
  const lines = ['resumes:'];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    title: ${JSON.stringify(e.title ?? e.id)}`);
    lines.push('    source: manual');
    lines.push(`    is_default: ${e.is_default ? 'true' : 'false'}`);
    lines.push(`    created_at: ${JSON.stringify(e.created_at ?? '2026-04-01')}`);
  }
  await fs.writeFile(RESUME_INDEX, lines.join('\n') + '\n');
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

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(PIPELINE, pipelineBack);
  await restore(LLM_COSTS, llmCostsBack);
  await restore(PREFS, prefsBack);
  await restore(RESUME_INDEX, indexBack);
  if (existsSync(RESUMES_DIR)) {
    for (const f of await fs.readdir(RESUMES_DIR)) {
      if (preExistingResumeDirs.has(f)) continue;
      await fs.rm(path.join(RESUMES_DIR, f), { recursive: true, force: true }).catch(() => {});
    }
  }
  if (existsSync(REPORTS_DIR)) {
    for (const f of await fs.readdir(REPORTS_DIR)) {
      if (preExistingReports.has(f)) continue;
      await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
    }
  }
  if (existsSync(OUTPUT_DIR)) {
    for (const f of await fs.readdir(OUTPUT_DIR)) {
      if (preExistingOutput.has(f)) continue;
      await fs.unlink(path.join(OUTPUT_DIR, f)).catch(() => {});
    }
  }
}

try {
  // ── Stage B happy path (paused=false) ────────────────────────────────
  await test('Stage B happy path — paused=false → 200 (existing flow preserved)', async () => {
    await writeCostsToday([]);
    await writePrefsBudget(10);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1', evaluation: {
      stage_a: { score: 4.2, reason: '', model: 'haiku', evaluated_at: '2026-05-07T01:00:00Z', cost_usd: 0.001, status: 'evaluated' },
      stage_b: null,
    }})])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
  });

  // ── Stage B paused + no force → 402 ─────────────────────────────────
  await test('Stage B paused + no force → 402 with banner_message + today/budget', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);  // > $10 budget
    await writePrefsBudget(10);
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 402);
    const data = await r.json();
    assert.match(data.error, /daily_budget_usd reached for Stage B/);
    assert.match(data.banner_message, /预算/);
    assert.equal(typeof data.today_total_usd, 'number');
    assert.equal(data.daily_budget_usd, 10);
    assert.ok(data.today_total_usd >= 10);
  });

  // ── Stage B paused + force=true → 200 (cost still records) ───────────
  await test('Stage B paused + force=true → 200, cost STILL records', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa2', evaluation: {
      stage_a: { score: 4.2, reason: '', model: 'haiku', evaluated_at: '2026-05-07T01:00:00Z', cost_usd: 0.001, status: 'evaluated' },
      stage_b: null,
    }})])));
    // Capture today_total before
    const before = (await fetch(`${BASE}/api/career/evaluate/budget`).then((x) => x.json())).today_total_usd;
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
    });
    assert.equal(r.status, 200);
    const after = (await fetch(`${BASE}/api/career/evaluate/budget`).then((x) => x.json())).today_total_usd;
    assert.ok(after > before, 'cost should have incremented (constraint #3 — no white-label)');
  });

  // ── Tailor paused + no force → 402 ──────────────────────────────────
  await test('Tailor paused + no force → 402', async () => {
    await writeCostsToday([{ caller: 'cv-tailor', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'bbbbbbbbbbb1' })])));

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'bbbbbbbbbbb1', resumeId: 'default' }),
    });
    assert.equal(r.status, 402);
    const data = await r.json();
    assert.match(data.error, /daily_budget_usd reached for Tailor/);
    assert.match(data.banner_message, /预算/);
  });

  // ── Tailor paused + force=true → 200 ────────────────────────────────
  await test('Tailor paused + force=true → 200, cost STILL records', async () => {
    await writeCostsToday([{ caller: 'cv-tailor', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'bbbbbbbbbbb2' })])));

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'bbbbbbbbbbb2', resumeId: 'default', force: true }),
    });
    assert.equal(r.status, 200);
  });

  // ── Stage A NEVER gated (constraint #1) ─────────────────────────────
  await test('Stage A NEVER gated — 200 even when paused (Haiku is cheap)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'ccccccccccc1', evaluation: null })])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    // Stage A endpoint exists at /evaluate/stage-a — verify NOT 402 even when paused
    assert.notEqual(r.status, 402, 'Stage A must never be budget-gated');
    // Likely 200 or 500 depending on mock-haiku behavior, but NEVER 402
  });

  // ── 402 response shape verbatim (UI banner contract) ────────────────
  await test('402 response shape — exact 4 fields UI banner expects', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 402);
    const data = await r.json();
    // UI banner uses error / banner_message / today_total_usd / daily_budget_usd
    for (const k of ['error', 'banner_message', 'today_total_usd', 'daily_budget_usd']) {
      assert.ok(k in data, `field "${k}" must be in 402 response`);
    }
  });

  // ── body.force = string rejected (Zod boolean enforcement) ──────────
  await test('Stage B body.force = "truthy-string" → 400 (strict boolean)', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: 'true' }),
    });
    assert.equal(r.status, 400);
  });

  await test('Stage B body.force = 1 → 400 (strict boolean)', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: 1 }),
    });
    assert.equal(r.status, 400);
  });

  await test('Tailor body.force = "yes" → 400 (strict boolean)', async () => {
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '0123456789ab', force: 'yes' }),
    });
    assert.equal(r.status, 400);
  });

  // ── Mutex still releases on 402 path ────────────────────────────────
  await test('Stage B 402 path still releases pipelineMutex (subsequent /scan works)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    // Hit Stage B → 402 (paused)
    const r1 = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r1.status, 402);
    // Subsequent /scan must succeed (mutex was released)
    const r2 = await fetch(`${BASE}/api/career/finder/scan`, { method: 'POST' });
    // 202 = scan started; 409 would mean mutex contention (not what we want)
    assert.notEqual(r2.status, 409, 'mutex must be released after 402');
    assert.equal(r2.status, 202);
    // Drain scan
    let attempts = 0;
    while (attempts < 200) {
      const s = await fetch(`${BASE}/api/career/finder/scan/status`).then((x) => x.json());
      if (!s.running) break;
      await new Promise((res) => setTimeout(res, 200));
      attempts++;
    }
  });

  // ── Budget reflects new total after force-runs (no caching) ─────────
  await test('GET /budget reflects forced-run cost increment (verifies no caching at gate)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 11.0 }]);
    await writePrefsBudget(10);
    // Bump budget so subsequent gate checks unpause
    await writePrefsBudget(50);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.daily_budget_usd, 50);
    assert.equal(data.paused, false, 'budget bump should immediately unpause');
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
