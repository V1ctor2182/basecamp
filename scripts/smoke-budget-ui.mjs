#!/usr/bin/env node
// Smoke for the GET /api/career/evaluate/budget endpoint that drives
// the BudgetBanner UI. UI itself verified manually via dev server
// (matches Stage B m5 / Tailor m4 smoke pattern). Here we lock the
// 3-state contract (normal / warning / paused) the banner consumes.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4588;
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
const LLM_COSTS = path.join(DATA_DIR, 'llm-costs.jsonl');
const PREFS = path.join(DATA_DIR, 'preferences.yml');
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
const costsBack = await backup(LLM_COSTS);
const prefsBack = await backup(PREFS);

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
  await restore(LLM_COSTS, costsBack);
  await restore(PREFS, prefsBack);
}

try {
  // ── Normal state — banner contract ───────────────────────────────────
  await test('normal state: paused=false, warning=false, by_caller breakdown present', async () => {
    await writeCostsToday([
      { caller: 'evaluator:stage-a', cost_usd: 0.10 },
      { caller: 'evaluator:stage-b', cost_usd: 0.50 },
      { caller: 'cv-tailor', cost_usd: 0.30 },
    ]);
    await writePrefsBudget(10);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.paused, false);
    assert.equal(data.warning, false);
    assert.ok(data.by_caller['evaluator:stage-a']);
    assert.ok(data.by_caller['evaluator:stage-b']);
    assert.ok(data.by_caller['cv-tailor']);
    // Banner uses these for the per-caller ribbon
    assert.equal(data.by_caller['evaluator:stage-a'].record_count, 1);
    assert.equal(data.by_caller['evaluator:stage-b'].record_count, 1);
    assert.equal(data.by_caller['cv-tailor'].record_count, 1);
  });

  // ── Warning state ────────────────────────────────────────────────────
  await test('warning state: ≥80% of budget, paused=false', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 8.5 }]);
    await writePrefsBudget(10);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.warning, true);
    assert.equal(data.paused, false);
    assert.equal(data.today_total_usd, 8.5);
    assert.equal(data.daily_budget_usd, 10);
  });

  // ── Paused state ─────────────────────────────────────────────────────
  await test('paused state: ≥100% of budget; warning becomes false (mutually exclusive)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 10.5 }]);
    await writePrefsBudget(10);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.paused, true);
    assert.equal(data.warning, false, 'paused supersedes warning');
  });

  // ── day_start is local-tz today 00:00 — banner uses for transitions ──
  await test('day_start = today\'s local 00:00 ISO (banner uses for state-transition detection)', async () => {
    await fs.unlink(LLM_COSTS).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    const ds = new Date(data.day_start);
    const now = new Date();
    assert.equal(ds.getFullYear(), now.getFullYear());
    assert.equal(ds.getMonth(), now.getMonth());
    assert.equal(ds.getDate(), now.getDate());
    assert.equal(ds.getHours(), 0);
    assert.equal(ds.getMinutes(), 0);
  });

  // ── PUT /preferences live-updates daily_budget_usd → GET reflects ───
  await test('PUT /preferences daily_budget_usd live-updates budget threshold (no caching)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 9.0 }]);
    await writePrefsBudget(10);

    let r = await fetch(`${BASE}/api/career/evaluate/budget`);
    let data = await r.json();
    assert.equal(data.warning, true, '$9 of $10 → warning');
    assert.equal(data.paused, false);

    // PUT prefs to bump the budget; subsequent GET reflects new threshold
    const prefsR = await fetch(`${BASE}/api/career/preferences`);
    const current = await prefsR.json();
    const updated = {
      ...current,
      evaluator_strategy: {
        ...current.evaluator_strategy,
        stage_b: {
          ...current.evaluator_strategy.stage_b,
          daily_budget_usd: 20,
        },
      },
    };
    const putR = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    assert.equal(putR.status, 200);

    r = await fetch(`${BASE}/api/career/evaluate/budget`);
    data = await r.json();
    assert.equal(data.daily_budget_usd, 20);
    assert.equal(data.warning, false, '$9 of $20 = 45% → no warning');
    assert.equal(data.paused, false);
  });

  // ── Graceful default when prefs.yml missing ──────────────────────────
  await test('prefs.yml missing → banner gets default $10 budget gracefully', async () => {
    await fs.unlink(PREFS).catch(() => {});
    await writeCostsToday([]);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.daily_budget_usd, 10);
    assert.equal(data.today_total_usd, 0);
    assert.equal(data.paused, false);
    assert.equal(data.warning, false);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
