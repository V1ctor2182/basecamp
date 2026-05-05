#!/usr/bin/env node
// Smoke for the GET endpoints that drive the StageBBatch / ReportViewer UI.
// The UI itself is verified manually via the dev server. Here we lock the
// projection shape, threshold echo, top-50 sort, pending-count semantics,
// and the report-fetch path consumed by ReportViewer.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4594;
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

let pipelineBack = false;
try {
  await fs.copyFile(PIPELINE, PIPELINE + SUFFIX);
  pipelineBack = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

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
    description: 'Build safe AI.',
    posted_at: null,
    scraped_at: '2026-05-04T00:00:00Z',
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
        evaluated_at: '2026-05-04T01:00:00Z',
        cost_usd: 0.0008,
        status: 'evaluated',
      },
      stage_b: null,
    },
    ...over,
  };
}

function withStageB(over, totalScore, status = 'evaluated', extras = {}) {
  return makeJob({
    ...over,
    evaluation: {
      stage_a: over.evaluation?.stage_a ?? {
        score: 4.2,
        reason: 'strong fit',
        model: 'claude-haiku-4-5-20251001',
        evaluated_at: '2026-05-04T01:00:00Z',
        cost_usd: 0.0008,
        status: 'evaluated',
      },
      stage_b: {
        total_score: totalScore,
        report_path: status === 'evaluated' ? `data/career/reports/${over.id}.md` : null,
        blocks_emitted: status === 'evaluated' ? ['A', 'B', 'C', 'E', 'F'] : [],
        model: 'claude-sonnet-4-6',
        evaluated_at: '2026-05-04T02:00:00Z',
        cost_usd: 0.18,
        web_search_requests: 0,
        tool_rounds_used: 1,
        status,
        ...extras,
      },
    },
  });
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
  if (pipelineBack) await fs.rename(PIPELINE + SUFFIX, PIPELINE).catch(() => {});
  else await fs.unlink(PIPELINE).catch(() => {});
  if (existsSync(REPORTS_DIR)) {
    for (const f of await fs.readdir(REPORTS_DIR)) {
      if (preExistingReports.has(f)) continue;
      await fs.unlink(path.join(REPORTS_DIR, f)).catch(() => {});
    }
  }
}

try {
  await test('missing pipeline.json → empty projection with threshold absent', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.pending, 0);
    assert.equal(data.total, 0);
    assert.equal(data.evaluated_count, 0);
    assert.deepEqual(data.results, []);
  });

  await test('pending count: stage_a passers without stage_b', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        jobs: [
          // pending: stage_a evaluated + score >= threshold + stage_b == null
          makeJob({ id: 'aaaaaaaaaaa1' }),
          makeJob({ id: 'aaaaaaaaaaa2' }),
          // stage_b done — counts as evaluated, NOT pending
          withStageB({ id: 'aaaaaaaaaaa3' }, 4.3),
          // low stage_a score → NOT pending (excluded by threshold)
          makeJob({
            id: 'aaaaaaaaaaa4',
            evaluation: {
              stage_a: {
                score: 2.0,
                reason: '',
                model: 'claude-haiku-4-5-20251001',
                evaluated_at: '2026-05-04T01:00:00Z',
                cost_usd: 0.0008,
                status: 'evaluated',
              },
              stage_b: null,
            },
          }),
        ],
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    const data = await r.json();
    assert.equal(data.total, 4);
    assert.equal(data.pending, 2, 'two stage_a passers without stage_b');
    assert.equal(data.evaluated_count, 1);
    assert.equal(data.threshold, 3.5);
  });

  await test('results sorted by total_score desc; null/error fall to bottom', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        jobs: [
          withStageB({ id: 'bbbbbbbbbbb1' }, 3.6),
          withStageB({ id: 'bbbbbbbbbbb2' }, 4.5),
          withStageB({ id: 'bbbbbbbbbbb3' }, 4.0),
          withStageB({ id: 'bbbbbbbbbbb4' }, null, 'error', { error: 'parse fail' }),
        ],
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    const data = await r.json();
    assert.equal(data.results.length, 4);
    const scores = data.results.map((x) => x.total_score);
    assert.deepEqual(scores, [4.5, 4.0, 3.6, null]);
  });

  await test('projection includes UI fields (blocks_emitted, web_search_requests, tool_rounds_used)', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        jobs: [
          withStageB({ id: 'ccccccccccc1' }, 4.4, 'evaluated', {
            web_search_requests: 2,
            tool_rounds_used: 3,
          }),
        ],
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    const data = await r.json();
    const row = data.results[0];
    assert.ok(row.id);
    assert.ok(row.company);
    assert.ok(row.role);
    assert.ok(Array.isArray(row.location));
    assert.equal(row.total_score, 4.4);
    assert.deepEqual(row.blocks_emitted, ['A', 'B', 'C', 'E', 'F']);
    assert.match(row.report_path, /reports\/ccccccccccc1\.md$/);
    assert.equal(row.status, 'evaluated');
    assert.equal(row.web_search_requests, 2);
    assert.equal(row.tool_rounds_used, 3);
    // Excluded fields
    assert.equal(row.description, undefined);
    assert.equal(row.raw, undefined);
    assert.equal(row.tags, undefined);
  });

  await test('GET /report/:jobId integration: ReportViewer-shaped response', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        jobs: [withStageB({ id: 'ddddddddddd1' }, 4.1)],
      })
    );
    const md = `## Block A — Role Summary
Senior backend at Foo.

## Block B — CV Match
Strong match.

**Total: 4.1/5**`;
    await fs.writeFile(path.join(REPORTS_DIR, 'ddddddddddd1.md'), md);

    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/report/ddddddddddd1`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.match(data.content, /Block A.*Role Summary/);
    assert.equal(data.total_score, 4.1);
    assert.deepEqual(data.blocks_emitted, ['A', 'B', 'C', 'E', 'F']);
    assert.equal(typeof data.evaluated_at, 'string');
  });

  await test('top-50 cap on /results', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) => {
      const idHex = i.toString(16).padStart(2, '0');
      return withStageB({ id: idHex + 'a'.repeat(10) }, 4.0 - i * 0.01);
    });
    await fs.writeFile(PIPELINE, JSON.stringify({ jobs }));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-b/results`);
    const data = await r.json();
    assert.equal(data.total, 60);
    assert.equal(data.evaluated_count, 60);
    assert.equal(data.results.length, 50);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
