#!/usr/bin/env node
// Smoke for POST /api/career/evaluate/stage-b + GET /results + GET /report/:jobId.
// Spawns server with MOCK_ANTHROPIC=1 + DISABLE_SCAN_SCHEDULER=1. Backs up
// + restores pipeline.json + llm-costs.jsonl + reports/ around the run.
//
// MOCK_ANTHROPIC produces a Stage-A-shaped "Score: 4.0/5" response which
// fails Stage B's 7-block parser as a degenerate response. That's actually
// the right shape for endpoint testing: we verify the endpoint persists the
// status:'error' mutation, records cost, and the projection/report endpoints
// behave correctly. Endpoint correctness is decoupled from eval quality.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4597;
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
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(REPORTS_DIR, { recursive: true });

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

// Capture the report files that existed BEFORE the test so we can clean
// up only the ones we created.
const preExistingReports = new Set();
if (existsSync(REPORTS_DIR)) {
  for (const f of await fs.readdir(REPORTS_DIR)) preExistingReports.add(f);
}

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
    scraped_at: '2026-05-04T00:00:00Z',
    comp_hint: { min: 200000, max: 300000, currency: 'USD', period: 'yr' },
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: {
      stage_a: {
        score: 4.2,
        reason: 'strong fit',
        model: 'claude-haiku-4-5-20251001',
        evaluated_at: '2026-05-04T01:00:00Z',
        cost_usd: 0.0008,
        status: 'evaluated',
      },
      stage_b: null,
    },
    ...over,
  };
}

function makeFixture(jobs) {
  return {
    last_scan_at: '2026-05-04T00:00:00Z',
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
  // Remove any reports/{jobId}.md created during this run.
  if (existsSync(REPORTS_DIR)) {
    for (const f of await fs.readdir(REPORTS_DIR)) {
      if (preExistingReports.has(f)) continue;
      await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
    }
  }
}

try {
  // ── Happy path: 3 stage-A-passing jobs all run through Stage B ────────
  await test(
    'POST /evaluate/stage-b → MOCK returns degenerate parse, 3 jobs persisted as error',
    async () => {
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
      const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.total, 3);
      // MOCK_ANTHROPIC returns Stage-A-shaped response → m1 parser flags
      // degenerate (no Block headers, no Total line) → STATUS.ERROR. Cost
      // still recorded.
      assert.equal(data.evaluated, 0);
      assert.equal(data.errors, 3);
      assert.ok(data.total_cost_usd > 0, 'cost recorded even on parse error');
      assert.equal(data.threshold, 3.5);

      // Verify mutation persisted to pipeline.json (stage_a preserved)
      const pipeline = JSON.parse(await fs.readFile(PIPELINE, 'utf-8'));
      for (const job of pipeline.jobs) {
        assert.ok(job.evaluation?.stage_a, 'stage_a preserved');
        assert.equal(job.evaluation.stage_a.score, 4.2);
        assert.ok(job.evaluation?.stage_b, 'stage_b mutated');
        assert.equal(job.evaluation.stage_b.status, 'error');
        assert.match(job.evaluation.stage_b.error, /degenerate|parse/);
        assert.equal(job.evaluation.stage_b.model, 'claude-sonnet-4-6');
        assert.equal(typeof job.evaluation.stage_b.evaluated_at, 'string');
        assert.equal(job.evaluation.stage_b.report_path, null);
      }
    }
  );

  // ── Idempotent re-run ──────────────────────────────────────────────────
  await test('idempotent re-run → 0 newly evaluated (skip-if-stage_b-set)', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0);
    assert.equal(data.evaluated, 0);
  });

  // ── Threshold gate: stage_a.score < threshold → not candidate ─────────
  await test('threshold gate: stage_a.score < consider → NOT candidate', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          // High score → candidate
          makeJob({
            id: 'bbbbbbbbbbb1',
            evaluation: {
              stage_a: {
                score: 4.0,
                reason: 'good',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: null,
            },
          }),
          // Low score → NOT candidate
          makeJob({
            id: 'bbbbbbbbbbb2',
            evaluation: {
              stage_a: {
                score: 2.5,
                reason: 'weak',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: null,
            },
          }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 1, 'only the score=4.0 job should be candidate');

    const pipeline = JSON.parse(await fs.readFile(PIPELINE, 'utf-8'));
    const high = pipeline.jobs.find((j) => j.id === 'bbbbbbbbbbb1');
    const low = pipeline.jobs.find((j) => j.id === 'bbbbbbbbbbb2');
    assert.ok(high.evaluation.stage_b, 'high-score job evaluated');
    assert.equal(low.evaluation.stage_b, null, 'low-score job NOT evaluated');
  });

  // ── No stage_a → not candidate ────────────────────────────────────────
  await test('jobs without stage_a → NOT candidate (only stage-A passers)', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({
            id: 'cccccccccccc1',
            evaluation: null, // no stage_a at all
          }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0);
  });

  // ── jobIds bypass: caller-supplied list skips threshold gate ──────────
  await test('jobIds: caller list bypasses threshold gate (force-eval)', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          // Low stage_a but caller explicitly asks for it
          makeJob({
            id: 'dddddddddddd1',
            evaluation: {
              stage_a: {
                score: 2.5,
                reason: 'weak',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: null,
            },
          }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds: ['dddddddddddd1'] }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 1, 'jobIds bypasses threshold gate');
  });

  // ── 400 invalid body ───────────────────────────────────────────────────
  await test('400 on invalid body shape (jobIds is not array)', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds: 'not-an-array' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /Invalid body/);
  });

  // ── 404 missing pipeline ──────────────────────────────────────────────
  await test('404 when pipeline.json does not exist', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 404);
  });

  // ── Empty pipeline → 0 candidates ─────────────────────────────────────
  await test('empty pipeline → 200 with zero counters + threshold echo', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([])));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 0);
    assert.equal(data.threshold, 3.5);
  });

  // ── GET /results projection shape ─────────────────────────────────────
  await test('GET /evaluate/stage-b/results: projection shape + threshold echo', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({
            id: 'eeeeeeeeeee1',
            evaluation: {
              stage_a: {
                score: 4.5,
                reason: '',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: {
                total_score: 4.3,
                report_path: 'data/career/reports/eeeeeeeeeee1.md',
                blocks_emitted: ['A', 'B', 'C', 'E', 'F'],
                model: 'claude-sonnet-4-6',
                evaluated_at: '2026-05-04T02:00:00Z',
                cost_usd: 0.18,
                web_search_requests: 1,
                tool_rounds_used: 2,
                status: 'evaluated',
              },
            },
          }),
          // stage_a passer with no stage_b (pending)
          makeJob({ id: 'eeeeeeeeeee2' }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 2);
    assert.equal(data.pending, 1);
    assert.equal(data.evaluated_count, 1);
    assert.equal(data.threshold, 3.5);
    assert.equal(data.results.length, 1);
    const row = data.results[0];
    assert.equal(row.id, 'eeeeeeeeeee1');
    assert.equal(row.total_score, 4.3);
    assert.deepEqual(row.blocks_emitted, ['A', 'B', 'C', 'E', 'F']);
    assert.equal(row.web_search_requests, 1);
    assert.equal(row.tool_rounds_used, 2);
    assert.equal(row.report_path, 'data/career/reports/eeeeeeeeeee1.md');
  });

  // ── GET /report/:jobId reads file from disk ───────────────────────────
  await test('GET /report/:jobId returns markdown content', async () => {
    // Write a fake report file matching the pipeline mutation above
    const reportFile = path.join(REPORTS_DIR, 'eeeeeeeeeee1.md');
    await fs.writeFile(reportFile, '# Report\n\n## Block A — Role Summary\nGreat fit.');

    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/eeeeeeeeeee1`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.match(data.content, /Block A.*Role Summary/);
    assert.equal(data.total_score, 4.3);
    assert.deepEqual(data.blocks_emitted, ['A', 'B', 'C', 'E', 'F']);
    assert.equal(typeof data.evaluated_at, 'string');
  });

  // ── GET /report/:jobId rejects malformed jobId (path traversal) ───────
  await test('GET /report/:jobId rejects malformed jobId (400)', async () => {
    for (const bad of ['../etc/passwd', 'not-hex', 'abc', 'AB-12-34-56-78']) {
      const r = await fetch(
        `${BASE}/api/career/evaluate/stage-b/report/${encodeURIComponent(bad)}`
      );
      assert.equal(r.status, 400, `should 400 for ${bad}`);
    }
  });

  // ── GET /report/:jobId 404 when job has no stage_b ────────────────────
  await test('GET /report/:jobId 404 when job has no stage_b', async () => {
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/eeeeeeeeeee2`);
    assert.equal(r.status, 404);
  });

  // ── GET /report/:jobId 404 when file missing on disk ──────────────────
  await test('GET /report/:jobId 404 when report file missing on disk', async () => {
    // pipeline says report exists but actual file does not
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({
            id: 'fffffffffff1',
            evaluation: {
              stage_a: {
                score: 4.5,
                reason: '',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: {
                total_score: 4.0,
                report_path: 'data/career/reports/fffffffffff1.md',
                blocks_emitted: ['A', 'B', 'E'],
                model: 'claude-sonnet-4-6',
                evaluated_at: '2026-05-04T02:00:00Z',
                cost_usd: 0.18,
                web_search_requests: 0,
                tool_rounds_used: 1,
                status: 'evaluated',
              },
            },
          }),
        ])
      )
    );
    // Don't write the report file.
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/fffffffffff1`);
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /report file missing/);
  });

  // ── Path traversal defense: pipeline.json with malicious report_path ──
  await test(
    'GET /report/:jobId ignores stored report_path; reads only from REPORTS_DIR',
    async () => {
      // Even if pipeline.json has been tampered to point report_path at
      // /etc/passwd or ../../secret, the endpoint must read ONLY from
      // data/career/reports/{jobId}.md (built from validated jobId).
      const malicious = '/etc/passwd';
      await fs.writeFile(
        PIPELINE,
        JSON.stringify(
          makeFixture([
            makeJob({
              id: 'aaaabbbbcccc',
              evaluation: {
                stage_a: {
                  score: 4.5,
                  reason: '',
                  model: 'claude-haiku-4-5-20251001',
                  evaluated_at: '2026-05-04T01:00:00Z',
                  cost_usd: 0.0008,
                  status: 'evaluated',
                },
                stage_b: {
                  total_score: 4.0,
                  report_path: malicious, // ATTACK: should be ignored
                  blocks_emitted: ['A', 'B', 'E'],
                  model: 'claude-sonnet-4-6',
                  evaluated_at: '2026-05-04T02:00:00Z',
                  cost_usd: 0.18,
                  web_search_requests: 0,
                  tool_rounds_used: 1,
                  status: 'evaluated',
                },
              },
            }),
          ])
        )
      );
      // Don't write any file at REPORTS_DIR/aaaabbbbcccc.md
      // (Defensively unlink in case a prior failed run left a stale file.)
      await fs.unlink(path.join(REPORTS_DIR, 'aaaabbbbcccc.md')).catch(() => {});
      const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/aaaabbbbcccc`);
      const body = await r.json();
      // Must 404 because the legitimate path doesn't exist — NOT 200 with
      // /etc/passwd content. The malicious report_path is ignored entirely.
      assert.equal(r.status, 404, `expected 404 got ${r.status} body=${JSON.stringify(body)}`);
      assert.match(body.error, /report file missing/);

      // Now write the legitimate file and re-test that we read THAT, not
      // the malicious one.
      await fs.writeFile(
        path.join(REPORTS_DIR, 'aaaabbbbcccc.md'),
        '# Legitimate report content'
      );
      const r2 = await fetch(`${BASE}/api/career/evaluate/stage-b/report/aaaabbbbcccc`);
      assert.equal(r2.status, 200);
      const data2 = await r2.json();
      assert.match(data2.content, /Legitimate report content/);
      assert.doesNotMatch(data2.content, /root:/); // sanity check vs /etc/passwd
    }
  );

  // ── 409 mutex contention with scan running ───────────────────────────
  await test('409 when scan in progress (6-way mutex)', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'gggggggggggg1' })])));
    const scanResp = await fetch(`${BASE}/api/career/finder/scan`, { method: 'POST' });
    assert.equal(scanResp.status, 202);
    const evalResp = await fetch(`${BASE}/api/career/evaluate/stage-b`, {
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
