#!/usr/bin/env node
// Smoke for 03-block-toggles m3: PUT /api/career/preferences with the new
// sub-toggle keys round-trips cleanly via Preferences UI's save path. Also
// validates Zod range guards (story_count out-of-range → 400).
//
// The UI itself (Preferences.tsx cost badges + sub-controls + projection
// card) is verified manually via dev server. This smoke locks the
// schema-side contract that the UI consumes.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const prefsBack = await backup(PREFS);

function makePrefsBody(over = {}) {
  return {
    targets: [{ title: 'Backend Engineer', seniority: 'Senior' }],
    comp_target: { currency: 'USD' },
    location: {
      accept_any: false, remote_only: false, preferred_cities: [], acceptable_countries: [],
    },
    hard_filters: {
      source_filter: { blocked_sources: [] },
      company_blocklist: [], title_blocklist: [], title_allowlist: [],
      location: { allowed_countries: [], allowed_cities: [], disallowed_countries: [] },
      seniority: { allowed: [] },
      posted_within_days: 0,
      comp_floor: { currency: 'USD' },
      jd_text_blocklist: [],
    },
    soft_preferences: {
      company_types: [], remote_culture: [], tech_stack_preferred: [],
      tech_stack_avoid: [], industries_preferred: [], industries_avoid: [],
    },
    scoring_weights: {
      tech_match: 0.2, comp_match: 0.2, location_match: 0.2, company_match: 0.2, growth_signal: 0.2,
    },
    thresholds: { strong: 4.5, worth: 4.0, consider: 3.5, skip_below: 3.0 },
    evaluator_strategy: {
      stage_a: { enabled: true, model: 'claude-haiku-4-5', threshold: 3.5 },
      stage_b: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        daily_budget_usd: 10,
        blocks: {
          block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
          block_d_websearch: false,
          block_f_story_count: 12,
          block_g_playwright: false,
          ...over,
        },
      },
    },
  };
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
  await restore(PREFS, prefsBack);
}

try {
  // ── 1. PUT /preferences with all 3 sub-toggle keys round-trips ──────
  await test('PUT /preferences with new sub-toggle keys round-trips via GET', async () => {
    const body = makePrefsBody();
    const put = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(put.status, 200, `PUT failed: ${await put.text()}`);

    const get = await fetch(`${BASE}/api/career/preferences`);
    const saved = await get.json();
    const blocks = saved.evaluator_strategy.stage_b.blocks;
    assert.equal(blocks.block_d_websearch, false, 'block_d_websearch persisted');
    assert.equal(blocks.block_f_story_count, 12, 'block_f_story_count persisted');
    assert.equal(blocks.block_g_playwright, false, 'block_g_playwright persisted');
  });

  // ── 2. story_count out-of-range → 400 from Zod ──────────────────────
  await test('PUT /preferences with block_f_story_count=25 → 400', async () => {
    const body = makePrefsBody({ block_f_story_count: 25 });
    const r = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, 'should reject above-max story_count');
    const data = await r.json();
    assert.match(JSON.stringify(data), /story_count|max|less than/i);
  });

  // ── 3. Missing sub-toggle keys → defaults filled in via Zod .default()
  await test('PUT prefs missing the 3 new keys → Zod fills defaults on GET', async () => {
    const body = makePrefsBody();
    // Strip the 3 new keys to simulate a stale preferences.yml load
    delete body.evaluator_strategy.stage_b.blocks.block_d_websearch;
    delete body.evaluator_strategy.stage_b.blocks.block_f_story_count;
    delete body.evaluator_strategy.stage_b.blocks.block_g_playwright;

    const put = await fetch(`${BASE}/api/career/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(put.status, 200, 'missing keys should not 400 — Zod fills defaults');

    const get = await fetch(`${BASE}/api/career/preferences`);
    const saved = await get.json();
    const blocks = saved.evaluator_strategy.stage_b.blocks;
    // Defaults: websearch true, story_count 8, playwright true
    assert.equal(blocks.block_d_websearch, true, 'default block_d_websearch=true');
    assert.equal(blocks.block_f_story_count, 8, 'default block_f_story_count=8');
    assert.equal(blocks.block_g_playwright, true, 'default block_g_playwright=true');
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
