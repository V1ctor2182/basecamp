#!/usr/bin/env node
// Smoke for GET /api/career/shortlist (06-evaluator/05-pipeline-ui m2).
// Locks the projection contract that Shortlist.tsx consumes:
//   {total, score_floor, results: [{id, company, role, url, location,
//     total_score, blocks_emitted, report_path, evaluated_at, cost_usd,
//     stage_a_score, has_tailor_output}]}
//
// Read-only endpoint over pipeline.json + a single readdir on
// data/career/output/ to derive has_tailor_output.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const PIPELINE = path.join(DATA_DIR, 'pipeline.json');
const PREFS = path.join(DATA_DIR, 'preferences.yml');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
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
const prefsBack = await backup(PREFS);

const preExistingOutputs = new Set();
if (existsSync(OUTPUT_DIR)) {
  for (const f of await fs.readdir(OUTPUT_DIR)) preExistingOutputs.add(f);
}

async function writePrefsWithFloor(worth) {
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
  worth: ${worth}
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
    daily_budget_usd: 10
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

function makeJob({ id, company, role, total_score, evaluated_at, status = 'evaluated', stage_a_score = 4.2, blocks = ['A', 'B', 'E'], report_path = null, location = ['SF, CA'], url = 'https://example.com/jobs/x' } = {}) {
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
      stage_a: { score: stage_a_score, reason: '', model: 'haiku', evaluated_at: '2026-05-08T01:00:00Z', cost_usd: 0.001, status: 'evaluated' },
      stage_b: status === null ? null : {
        total_score,
        report_path: report_path ?? `data/career/reports/${id}.md`,
        blocks_emitted: blocks,
        model: 'claude-sonnet-4-6',
        evaluated_at,
        cost_usd: 0.18,
        web_search_requests: 0,
        tool_rounds_used: 1,
        status,
        ...(status === 'error' ? { reason: 'mocked failure' } : {}),
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

// Files we create during the run for cleanup tracking
const createdOutputs = [];

async function cleanup() {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await restore(PIPELINE, pipelineBack);
  await restore(PREFS, prefsBack);
  for (const f of createdOutputs) {
    if (preExistingOutputs.has(f)) continue;
    await fs.unlink(path.join(OUTPUT_DIR, f)).catch(() => {});
  }
}

try {
  // ── 1. Empty pipeline → empty results ───────────────────────────────
  await test('Empty pipeline → {total:0, results:[]}', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0);
    assert.deepEqual(data.results, []);
    assert.equal(data.score_floor, 4.0);
  });

  // ── 2. 3 jobs, 2 above floor, sorted by score desc ──────────────────
  await test('Score filter + sort by total_score desc', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: 'aaaaaaaaaaa1', company: 'A', role: 'r1', total_score: 3.9, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: 'aaaaaaaaaaa2', company: 'B', role: 'r2', total_score: 4.8, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: 'aaaaaaaaaaa3', company: 'C', role: 'r3', total_score: 4.2, evaluated_at: '2026-05-08T05:00:00Z' }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.total, 2, 'only the 2 jobs >= 4.0 qualify');
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].id, 'aaaaaaaaaaa2', 'first = highest score');
    assert.equal(data.results[1].id, 'aaaaaaaaaaa3');
  });

  // ── 3. Sort tiebreaker: same score → evaluated_at desc ──────────────
  await test('Tiebreaker: evaluated_at desc when total_score ties', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: 'bbbbbbbbbbb1', company: 'X', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T01:00:00Z' }),
      makeJob({ id: 'bbbbbbbbbbb2', company: 'Y', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z' }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.results[0].id, 'bbbbbbbbbbb2', 'newer evaluated_at wins tie');
  });

  // ── 4. score_floor reflects prefs.thresholds.worth (live read) ──────
  await test('score_floor live-read from prefs.thresholds.worth', async () => {
    await writePrefsWithFloor(4.5);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: 'ccccccccccc1', company: 'A', role: 'r', total_score: 4.2, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: 'ccccccccccc2', company: 'B', role: 'r', total_score: 4.7, evaluated_at: '2026-05-08T05:00:00Z' }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.score_floor, 4.5);
    assert.equal(data.total, 1, 'only the 4.7 qualifies under floor=4.5');
    assert.equal(data.results[0].id, 'ccccccccccc2');
  });

  // ── 5. Top-100 cap ──────────────────────────────────────────────────
  await test('Top-100 cap: 110 jobs above floor → results.length=100, total=110', async () => {
    await writePrefsWithFloor(4.0);
    const jobs = [];
    for (let i = 0; i < 110; i++) {
      // 12-hex id: pad index into the last 4 chars
      const hexI = i.toString(16).padStart(4, '0');
      jobs.push(makeJob({
        id: `dddddddd${hexI}`,
        company: `co${i}`,
        role: 'r',
        // Vary scores: first job highest, descending
        total_score: 4.0 + (109 - i) * 0.001,
        evaluated_at: '2026-05-08T05:00:00Z',
      }));
    }
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture(jobs)));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.total, 110, 'total reflects ALL qualifying, not cap');
    assert.equal(data.results.length, 100, 'results capped at 100');
  });

  // ── 6. has_tailor_output flag accurate when output file exists ──────
  await test('has_tailor_output: true when output/{jobId}-{resumeId}.md exists', async () => {
    await writePrefsWithFloor(4.0);
    // Create a tailor output for one of the jobs
    const tailorFile = 'eeeeeeeeeeee-resume-eng.md';
    await fs.writeFile(path.join(OUTPUT_DIR, tailorFile), '# tailor');
    createdOutputs.push(tailorFile);

    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: 'eeeeeeeeeeee', company: 'T', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: 'ffffffffffff', company: 'U', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z' }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    const eRow = data.results.find((x) => x.id === 'eeeeeeeeeeee');
    const fRow = data.results.find((x) => x.id === 'ffffffffffff');
    assert.equal(eRow.has_tailor_output, true, 'job with output file → flag true');
    assert.equal(fRow.has_tailor_output, false, 'job without output → flag false');
  });

  // ── 7. status:'error' rows excluded ─────────────────────────────────
  await test("Stage_b status='error' rows are excluded", async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: '111111111111', company: 'A', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: '222222222222', company: 'B', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z', status: 'error' }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.total, 1);
    assert.equal(data.results[0].id, '111111111111');
  });

  // ── 8. Field-level contract: all expected fields round-trip ─────────
  await test('Per-row fields: id/company/role/url/location/blocks/cost/stage_a/evaluated_at', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({
        id: '333333333333',
        company: 'Anthropic',
        role: 'Senior Backend Engineer',
        total_score: 4.6,
        evaluated_at: '2026-05-08T05:00:00Z',
        location: ['San Francisco', 'Remote (US)'],
        url: 'https://example.com/jobs/abc',
        blocks: ['A', 'B', 'C', 'E'],
        stage_a_score: 4.3,
        report_path: 'data/career/reports/333333333333.md',
      }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    const row = data.results[0];
    assert.equal(row.id, '333333333333');
    assert.equal(row.company, 'Anthropic');
    assert.equal(row.role, 'Senior Backend Engineer');
    assert.equal(row.url, 'https://example.com/jobs/abc');
    assert.deepEqual(row.location, ['San Francisco', 'Remote (US)']);
    assert.equal(row.total_score, 4.6);
    assert.deepEqual(row.blocks_emitted, ['A', 'B', 'C', 'E']);
    assert.equal(row.report_path, 'data/career/reports/333333333333.md');
    assert.equal(row.evaluated_at, '2026-05-08T05:00:00Z');
    assert.equal(typeof row.cost_usd, 'number');
    assert.equal(row.stage_a_score, 4.3);
    assert.equal(row.has_tailor_output, false);
  });

  // ── 9. Unparseable pipeline.json → 500 ───────────────────────────────
  await test('Unparseable pipeline.json → 500', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, '{not-json{{');
    const r = await fetch(`${BASE}/api/career/shortlist`);
    assert.equal(r.status, 500);
    const data = await r.json();
    assert.match(data.error ?? '', /unparseable|JSON|parse/i);
  });

  // ── 10. stage_b===null (only stage_a evaluated) excluded ────────────
  await test('Pending stage_b (stage_b:null) rows excluded from shortlist', async () => {
    await writePrefsWithFloor(4.0);
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([
      makeJob({ id: '444444444444', company: 'A', role: 'r', total_score: 4.5, evaluated_at: '2026-05-08T05:00:00Z' }),
      makeJob({ id: '555555555555', company: 'B', role: 'r', total_score: 0, evaluated_at: '', status: null }),
    ])));
    const r = await fetch(`${BASE}/api/career/shortlist`);
    const data = await r.json();
    assert.equal(data.total, 1);
    assert.equal(data.results[0].id, '444444444444');
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
