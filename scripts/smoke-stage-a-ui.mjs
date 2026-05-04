#!/usr/bin/env node
// Smoke for GET /api/career/evaluate/stage-a/results — the read endpoint
// that drives the StageABatch UI panel. UI itself is tested via manual
// browser verification (m4 plan).

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

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
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
let pipelineBack = false;
try {
  await fs.copyFile(PIPELINE, PIPELINE + SUFFIX);
  pipelineBack = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
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
    scraped_at: '2026-05-03T00:00:00Z',
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: null,
    ...over,
  };
}

function withStageA(over, score, status = 'evaluated') {
  return makeJob({
    ...over,
    evaluation: {
      stage_a: {
        score,
        reason: `mock reason for score ${score}`,
        model: 'claude-haiku-4-5-20251001',
        evaluated_at: '2026-05-03T01:00:00Z',
        cost_usd: 0.001,
        status,
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
}

try {
  await test('missing pipeline.json → {pending:0, total:0, results:[]}', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a/results`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.pending, 0);
    assert.equal(data.total, 0);
    assert.deepEqual(data.results, []);
  });

  await test('pending count: jobs without evaluation.stage_a', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        last_scan_at: '2026-05-03T00:00:00Z',
        jobs: [
          makeJob({ id: 'aaaaaaaaaaa1' }),
          makeJob({ id: 'aaaaaaaaaaa2' }),
          withStageA({ id: 'aaaaaaaaaaa3' }, 4.0),
        ],
        scan_summary: [],
        totals: {},
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a/results`);
    const data = await r.json();
    assert.equal(data.total, 3);
    assert.equal(data.pending, 2);
    assert.equal(data.evaluated_count, 1);
    assert.equal(data.results.length, 1);
  });

  await test('results sorted by score desc; archived/error fall to bottom', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        last_scan_at: '2026-05-03T00:00:00Z',
        jobs: [
          withStageA({ id: 'bbbbbbbbbbb1' }, 3.0, 'archived'),
          withStageA({ id: 'bbbbbbbbbbb2' }, 4.5),
          withStageA({ id: 'bbbbbbbbbbb3' }, 4.0),
          withStageA({ id: 'bbbbbbbbbbb4' }, null, 'error'),
        ],
        scan_summary: [],
        totals: {},
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a/results`);
    const data = await r.json();
    assert.equal(data.results.length, 4);
    const scores = data.results.map((row) => row.score);
    // 4.5 > 4.0 > 3.0 > null (error)
    assert.deepEqual(scores, [4.5, 4.0, 3.0, null]);
  });

  await test('results projection: includes id/company/role/score/reason/status; excludes raw/description/tags', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify({
        jobs: [withStageA({ id: 'ccccccccccc1' }, 4.0)],
      })
    );
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a/results`);
    const data = await r.json();
    const row = data.results[0];
    assert.ok(row.id);
    assert.ok(row.company);
    assert.ok(row.role);
    assert.equal(row.score, 4.0);
    assert.match(row.reason, /mock reason/);
    assert.equal(row.status, 'evaluated');
    assert.ok('evaluated_at' in row);
    assert.ok('cost_usd' in row);
    assert.equal(row.description, undefined);
    assert.equal(row.raw, undefined);
    assert.equal(row.tags, undefined);
  });

  await test('top-50 cap: only first 50 returned even with 60 evaluated', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) =>
      withStageA({ id: 'd'.repeat(11) + (i % 10) }, 4.0 - i * 0.01)
    );
    // ids must be unique 12-char hex; quick patch
    jobs.forEach((j, i) => {
      j.id = (i.toString(16).padStart(2, '0') + 'a'.repeat(10)).slice(0, 12);
    });
    await fs.writeFile(PIPELINE, JSON.stringify({ jobs }));
    const r = await fetch(`${BASE}/api/career/evaluate/stage-a/results`);
    const data = await r.json();
    assert.equal(data.total, 60);
    assert.equal(data.evaluated_count, 60);
    assert.equal(data.results.length, 50);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
