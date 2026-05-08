#!/usr/bin/env node
// Smoke for GET /api/career/evaluate/budget — pure projection over the
// existing cost-log infrastructure (readCostRecords + aggregateCosts) plus
// the daily_budget_usd field added to PreferencesSchema by 04-budget-gate
// m1. Backs up + restores llm-costs.jsonl + preferences.yml around the run.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4590;
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
  try {
    await fs.copyFile(file, file + SUFFIX);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function restore(file, hadOriginal) {
  if (hadOriginal) await fs.rename(file + SUFFIX, file).catch(() => {});
  else await fs.unlink(file).catch(() => {});
}
const costsBack = await backup(LLM_COSTS);
const prefsBack = await backup(PREFS);

// Helper: write llm-costs.jsonl with N records totaling targetCost USD,
// each record dated to today's local timestamp so the today-mode filter
// includes them.
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

// Helper: write a minimal valid preferences.yml with custom daily_budget_usd
async function writePrefsWithBudget(daily_budget_usd) {
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
    daily_budget_usd: ${daily_budget_usd}
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
  if (Date.now() - t0 > 15_000) {
    proc.kill();
    throw new Error('server did not become ready in 15s');
  }
  await new Promise((r) => setTimeout(r, 100));
}

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(LLM_COSTS, costsBack);
  await restore(PREFS, prefsBack);
}

try {
  // ── Empty cost log + default budget ──────────────────────────────────
  await test('GET /budget on empty cost log → today_total=0, paused=false, default budget=10', async () => {
    await fs.unlink(LLM_COSTS).catch(() => {});
    await fs.unlink(PREFS).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.today_total_usd, 0);
    assert.equal(data.daily_budget_usd, 10);
    assert.equal(data.paused, false);
    assert.equal(data.warning, false);
    assert.deepEqual(data.by_caller, {});
    assert.equal(typeof data.day_start, 'string');
  });

  // ── Below warning threshold ──────────────────────────────────────────
  await test('GET /budget with $5 stage-b spend → warning=false (50% of $10)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 5.0 }]);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.today_total_usd, 5);
    assert.equal(data.warning, false);
    assert.equal(data.paused, false);
  });

  // ── Warning threshold (≥80%) ─────────────────────────────────────────
  await test('GET /budget with $8 spend → warning=true (80% of $10)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 8.0 }]);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.today_total_usd, 8);
    assert.equal(data.warning, true);
    assert.equal(data.paused, false);
  });

  // ── Paused (≥100%) ───────────────────────────────────────────────────
  await test('GET /budget with $10+ spend → paused=true', async () => {
    await writeCostsToday([
      { caller: 'evaluator:stage-b', cost_usd: 10.5 },
    ]);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.ok(data.today_total_usd >= 10);
    assert.equal(data.paused, true);
    // warning is mutually exclusive with paused (paused supersedes)
    assert.equal(data.warning, false);
  });

  // ── by_caller breakdown across Stage A + Stage B + Tailor ────────────
  await test('GET /budget by_caller shows Stage A + Stage B + Tailor separately', async () => {
    await writeCostsToday([
      { caller: 'evaluator:stage-a', cost_usd: 0.05 },
      { caller: 'evaluator:stage-a', cost_usd: 0.07 },
      { caller: 'evaluator:stage-b', cost_usd: 0.18 },
      { caller: 'cv-tailor',         cost_usd: 0.22 },
    ]);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.ok(data.by_caller['evaluator:stage-a']);
    assert.equal(data.by_caller['evaluator:stage-a'].record_count, 2);
    assert.ok(Math.abs(data.by_caller['evaluator:stage-a'].total_cost - 0.12) < 1e-9);
    assert.ok(data.by_caller['evaluator:stage-b']);
    assert.equal(data.by_caller['evaluator:stage-b'].record_count, 1);
    assert.ok(data.by_caller['cv-tailor']);
    assert.equal(data.by_caller['cv-tailor'].record_count, 1);
  });

  // ── day_start is local-tz today 00:00 ────────────────────────────────
  await test('GET /budget day_start is today\'s local 00:00 ISO', async () => {
    await fs.unlink(LLM_COSTS).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    const ds = new Date(data.day_start);
    const now = new Date();
    // Expect day_start to represent local midnight: same Y/M/D as now,
    // local hours/minutes/seconds=0. (Server constructed via
    // `new Date(now.year, now.month, now.date)`.)
    assert.equal(ds.getFullYear(), now.getFullYear());
    assert.equal(ds.getMonth(), now.getMonth());
    assert.equal(ds.getDate(), now.getDate());
    assert.equal(ds.getHours(), 0);
    assert.equal(ds.getMinutes(), 0);
    assert.equal(ds.getSeconds(), 0);
  });

  // ── prefs.daily_budget_usd is read live (constraint #4 implied) ──────
  await test('GET /budget honors prefs.daily_budget_usd live (not cached)', async () => {
    await writeCostsToday([{ caller: 'evaluator:stage-b', cost_usd: 6.0 }]);
    await writePrefsWithBudget(5);
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.daily_budget_usd, 5);
    assert.equal(data.today_total_usd, 6);
    assert.equal(data.paused, true, '$6 > $5 budget should pause');

    // Bump budget; next GET should immediately reflect new threshold (no cache)
    await writePrefsWithBudget(20);
    const r2 = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data2 = await r2.json();
    assert.equal(data2.daily_budget_usd, 20);
    assert.equal(data2.paused, false, '$6 < $20 budget should unpause');
  });

  // ── Corrupt prefs.yml → graceful default $10 ─────────────────────────
  await test('GET /budget when prefs.yml is corrupt → falls back to $10 default', async () => {
    await writeCostsToday([]);
    await fs.writeFile(PREFS, 'this is: not\n  - valid yaml: [unbalanced');
    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.daily_budget_usd, 10);
  });

  // ── PreferencesSchema accepts daily_budget_usd ───────────────────────
  await test('PUT /preferences accepts daily_budget_usd field', async () => {
    // Restore prefs to known-good state first (the previous "Corrupt
    // prefs" test left unparseable YAML on disk, which makes GET return
    // a partial shape).
    await writePrefsWithBudget(10);
    const getR = await fetch(`${BASE}/api/career/preferences`);
    const current = await getR.json();
    const updated = {
      ...current,
      evaluator_strategy: {
        ...current.evaluator_strategy,
        stage_b: {
          ...current.evaluator_strategy.stage_b,
          daily_budget_usd: 25.5,
        },
      },
    };
    const r = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    assert.equal(r.status, 200);

    const verify = await fetch(`${BASE}/api/career/evaluate/budget`).then((x) => x.json());
    assert.equal(verify.daily_budget_usd, 25.5);
  });

  // ── PreferencesSchema rejects negative daily_budget_usd ──────────────
  await test('PUT /preferences rejects negative daily_budget_usd', async () => {
    await writePrefsWithBudget(10);
    const getR = await fetch(`${BASE}/api/career/preferences`);
    const current = await getR.json();
    const bad = {
      ...current,
      evaluator_strategy: {
        ...current.evaluator_strategy,
        stage_b: {
          ...current.evaluator_strategy.stage_b,
          daily_budget_usd: -1,
        },
      },
    };
    const r = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    assert.equal(r.status, 400);
  });

  // ── Records BEFORE today's day-start are excluded ────────────────────
  await test('GET /budget excludes records dated before today\'s local 00:00', async () => {
    // Write one record dated to YESTERDAY (subtract 25h to be safe across DST)
    const yesterdayTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const todayTs = new Date().toISOString();
    const lines = [
      JSON.stringify({ ts: yesterdayTs, caller: 'evaluator:stage-b', model: 'x', input_tokens: 0, output_tokens: 0, cost_usd: 100 }),
      JSON.stringify({ ts: todayTs,     caller: 'evaluator:stage-b', model: 'x', input_tokens: 0, output_tokens: 0, cost_usd: 1 }),
    ];
    await fs.writeFile(LLM_COSTS, lines.join('\n') + '\n');
    // Reset prefs so daily_budget_usd is the default 10
    await fs.unlink(PREFS).catch(() => {});

    const r = await fetch(`${BASE}/api/career/evaluate/budget`);
    const data = await r.json();
    assert.equal(data.today_total_usd, 1, 'only today\'s $1 should count, not yesterday\'s $100');
    assert.equal(data.paused, false);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
