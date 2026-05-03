#!/usr/bin/env node
// Smoke for POST /api/career/evaluate/stage-a. Spawns server with
// MOCK_ANTHROPIC=1 + DISABLE_SCAN_SCHEDULER=1. Backs up + restores
// pipeline.json + scan-cadence-state.json + llm-costs.jsonl around the run.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
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
const PIPELINE = path.join(DATA_DIR, 'pipeline.json');
const LLM_COSTS = path.join(DATA_DIR, 'llm-costs.jsonl');
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
const pipelineBack = await backup(PIPELINE);
const llmCostsBack = await backup(LLM_COSTS);

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Software Engineer',
    location: ['SF, CA'],
    url: 'https://example.com/jobs/1',
    description: 'Build safe AI. 5+ years required.',
    posted_at: null,
    scraped_at: '2026-05-03T00:00:00Z',
    comp_hint: { min: 200000, max: 300000, currency: 'USD', period: 'yr' },
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: null,
    ...over,
  };
}

function makeFixture(jobs) {
  return {
    last_scan_at: '2026-05-03T00:00:00Z',
    jobs,
    scan_summary: [],
    totals: {},
  };
}

const proc = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MOCK_ANTHROPIC: '1',
    DISABLE_SCAN_SCHEDULER: '1',
  },
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
  await restore(PIPELINE, pipelineBack);
  await restore(LLM_COSTS, llmCostsBack);
}

try {
  // ── Happy path: 3 mock jobs all evaluated + persisted ──────────────
  await test('POST /evaluate/stage-a → mock client returns Score: 4.0/5 → all evaluated', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({ id: 'aaaaaaaaaaa1' }),
          makeJob({ id: 'aaaaaaaaaaa2' }),
          makeJob({ id: 'aaaaaaaaaaa3' }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 3);
    assert.equal(data.evaluated, 3);
    assert.equal(data.archived, 0);
    assert.equal(data.errors, 0);
    assert.ok(data.total_cost_usd > 0, 'cost should be > 0');

    // Verify mutation persisted to pipeline.json
    const pipeline = JSON.parse(await fs.readFile(PIPELINE, 'utf-8'));
    for (const job of pipeline.jobs) {
      assert.ok(job.evaluation?.stage_a, `job ${job.id} should have stage_a`);
      assert.equal(job.evaluation.stage_a.status, 'evaluated');
      assert.equal(job.evaluation.stage_a.score, 4);
      assert.equal(job.evaluation.stage_a.model, 'claude-haiku-4-5-20251001');
      assert.ok(typeof job.evaluation.stage_a.evaluated_at === 'string');
    }
  });

  // ── Idempotent re-run: 0 newly evaluated ────────────────────────────
  await test('idempotent re-run → 0 newly evaluated (skip-if-evaluated)', async () => {
    // pipeline.json from previous test has 3 jobs all evaluated
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0, 'no candidates because all jobs are evaluated');
    assert.equal(data.evaluated, 0);
  });

  // ── jobIds filter (force re-run on specific jobs) ───────────────────
  await test('jobIds filter: only specified ids evaluated', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({ id: 'bbbbbbbbbbb1' }),
          makeJob({ id: 'bbbbbbbbbbb2' }),
          makeJob({ id: 'bbbbbbbbbbb3' }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds: ['bbbbbbbbbbb1', 'bbbbbbbbbbb3'] }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 2);
    const pipeline = JSON.parse(await fs.readFile(PIPELINE, 'utf-8'));
    const e1 = pipeline.jobs.find((j) => j.id === 'bbbbbbbbbbb1').evaluation;
    const e2 = pipeline.jobs.find((j) => j.id === 'bbbbbbbbbbb2').evaluation;
    const e3 = pipeline.jobs.find((j) => j.id === 'bbbbbbbbbbb3').evaluation;
    assert.ok(e1?.stage_a, 'job 1 evaluated');
    assert.equal(e2, null, 'job 2 NOT evaluated (not in jobIds)');
    assert.ok(e3?.stage_a, 'job 3 evaluated');
  });

  // ── 400 on malformed body ───────────────────────────────────────────
  await test('400 on invalid body shape (jobIds is not array)', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds: 'not-an-array' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /Invalid body/);
  });

  // ── 404 when pipeline.json missing ──────────────────────────────────
  await test('404 when pipeline.json does not exist', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 404);
  });

  // ── Empty pipeline → 0 candidates 200 OK ────────────────────────────
  await test('empty pipeline.json (jobs:[]) → 200 with all-zero counters', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0);
    assert.equal(data.evaluated, 0);
  });

  // ── 409 when scan running ───────────────────────────────────────────
  await test('409 when scan in progress (mutex contention)', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(makeFixture([makeJob({ id: 'cccccccccccc1' })]))
    );
    // Kick a real scan first (full /scan endpoint). It runs all 12 portals
    // sources w/ rate limit, takes ≥11s. Race it with our /evaluate call.
    const scanResp = await fetch(`${BASE}/api/career/finder/scan`, {
      method: 'POST',
    });
    assert.equal(scanResp.status, 202);
    const evalResp = await fetch(`${BASE}/api/career/evaluate/stage-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(evalResp.status, 409);
    const evalData = await evalResp.json();
    assert.match(evalData.error, /scan in progress/);
    // Drain scan
    let attempts = 0;
    while (attempts < 200) {
      const s = await fetch(`${BASE}/api/career/finder/scan/status`).then((x) => x.json());
      if (!s.running) break;
      await new Promise((res) => setTimeout(res, 200));
      attempts++;
    }
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
