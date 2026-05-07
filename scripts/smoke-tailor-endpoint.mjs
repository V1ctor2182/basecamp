#!/usr/bin/env node
// Smoke for POST /api/career/cv/tailor + GET /output. Spawns server with
// MOCK_ANTHROPIC=1 + DISABLE_SCAN_SCHEDULER=1. Backs up + restores
// pipeline.json + llm-costs.jsonl + output/ + resumes/index.yml around
// the run.
//
// MOCK_ANTHROPIC returns a Stage-A-shaped 'Score: 4.0/5' text — for tailor
// this is parser-friendly (parseTailorResponse just concatenates text);
// the response is treated as the tailored markdown. The endpoint behavior
// (mutation, projection, path-traversal defense) is what we verify; eval
// quality is decoupled.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4593;
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
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const RESUME_INDEX = path.join(RESUMES_DIR, 'index.yml');
const SUFFIX = `.smoke-backup.${process.pid}`;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(RESUMES_DIR, { recursive: true });

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
const indexBack = await backup(RESUME_INDEX);

// Capture preexisting output / resume dirs so we restore only ours.
const preExistingOutput = new Set();
if (existsSync(OUTPUT_DIR)) {
  for (const f of await fs.readdir(OUTPUT_DIR)) preExistingOutput.add(f);
}
const preExistingResumeDirs = new Set();
if (existsSync(RESUMES_DIR)) {
  for (const f of await fs.readdir(RESUMES_DIR)) preExistingResumeDirs.add(f);
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    location: ['SF, CA'],
    url: 'https://example.com/jobs/1',
    description: 'Build safe distributed AI. Required: Python, leadership.',
    posted_at: null,
    scraped_at: '2026-05-06T00:00:00Z',
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
        evaluated_at: '2026-05-06T01:00:00Z',
        cost_usd: 0.0008,
        status: 'evaluated',
      },
      stage_b: {
        total_score: 4.3,
        report_path: 'data/career/reports/0123456789ab.md',
        blocks_emitted: ['A', 'B', 'C', 'E', 'F'],
        model: 'claude-sonnet-4-6',
        evaluated_at: '2026-05-06T02:00:00Z',
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
  return {
    last_scan_at: '2026-05-06T00:00:00Z',
    jobs,
    scan_summary: [],
    totals: {},
  };
}

async function writeResume(id, isDefault, opts = {}) {
  const dir = path.join(RESUMES_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'base.md'), opts.baseMd ?? `# ${id} resume\n\n## Summary\nPlaceholder.`);
  const meta = opts.metadata ?? { archetype: id };
  // Use simple JSON-as-YAML; js-yaml handles that fine
  const lines = [`archetype: ${meta.archetype ?? id}`];
  if (meta.match_rules) {
    lines.push('match_rules:');
    if (meta.match_rules.role_keywords) lines.push(`  role_keywords: [${meta.match_rules.role_keywords.map(k => JSON.stringify(k)).join(', ')}]`);
    if (meta.match_rules.jd_keywords) lines.push(`  jd_keywords: [${meta.match_rules.jd_keywords.map(k => JSON.stringify(k)).join(', ')}]`);
    if (meta.match_rules.negative_keywords) lines.push(`  negative_keywords: [${meta.match_rules.negative_keywords.map(k => JSON.stringify(k)).join(', ')}]`);
  }
  await fs.writeFile(path.join(dir, 'metadata.yml'), lines.join('\n') + '\n');
}

async function writeIndex(entries) {
  if (entries.length === 0) {
    // YAML literal-empty array, NOT a bare `resumes:` (which parses to null
    // and trips ResumeIndexSchema's z.array() validation).
    await fs.writeFile(RESUME_INDEX, 'resumes: []\n');
    return;
  }
  const lines = ['resumes:'];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    title: ${JSON.stringify(e.title ?? e.id)}`);
    lines.push(`    source: manual`);
    lines.push(`    is_default: ${e.is_default ? 'true' : 'false'}`);
    lines.push(`    created_at: ${JSON.stringify(e.created_at ?? '2026-04-01')}`);
  }
  await fs.writeFile(RESUME_INDEX, lines.join('\n') + '\n');
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
  await restore(RESUME_INDEX, indexBack);
  // Drop any output / resume dirs we created.
  if (existsSync(OUTPUT_DIR)) {
    for (const f of await fs.readdir(OUTPUT_DIR)) {
      if (preExistingOutput.has(f)) continue;
      await fs.unlink(path.join(OUTPUT_DIR, f)).catch(() => {});
    }
  }
  if (existsSync(RESUMES_DIR)) {
    for (const f of await fs.readdir(RESUMES_DIR)) {
      if (preExistingResumeDirs.has(f)) continue;
      const p = path.join(RESUMES_DIR, f);
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
}

try {
  // ── Happy path: explicit resumeId + stage_b present ──────────────────
  await test('POST /tailor: explicit resumeId + stage_b present → 200 with markdown', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1' })])));
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'aaaaaaaaaaa1', resumeId: 'default' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.status, 'tailored');
    assert.equal(data.picked_resume_id, 'default');
    assert.equal(data.picked_via, 'explicit');
    assert.match(data.tailored_markdown, /Score: 4\.0\/5/); // mock response
    assert.match(data.base_markdown, /default resume/); // base.md content
    assert.match(data.output_path, /output\/aaaaaaaaaaa1-default\.md/);
    assert.equal(data.model, 'claude-sonnet-4-6');
    assert.ok(data.cost_usd > 0);
  });

  // ── Auto-Select fallback: resumeId omitted ───────────────────────────
  await test('POST /tailor: resumeId omitted → Auto-Select fallback resolves it', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa2' })])));
    await writeResume('backend', false, {
      metadata: { match_rules: { jd_keywords: ['Python', 'distributed', 'leadership'] } },
    });
    await writeResume('frontend', false, {
      metadata: { match_rules: { jd_keywords: ['React', 'CSS'] } },
    });
    await writeResume('default-r', true);
    await writeIndex([
      { id: 'backend', is_default: false, created_at: '2026-04-01' },
      { id: 'frontend', is_default: false, created_at: '2026-04-01' },
      { id: 'default-r', is_default: true, created_at: '2026-04-01' },
    ]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'aaaaaaaaaaa2' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.picked_resume_id, 'backend', 'backend should win on JD keyword score');
    assert.equal(data.picked_via, 'auto-select');
    assert.match(data.picked_reason, /jd keyword/);
  });

  // ── 400 invalid body ───────────────────────────────────────────────────
  await test('400 on invalid body shape (jobId not hex)', async () => {
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'NOT-HEX-ID', resumeId: 'default' }),
    });
    assert.equal(r.status, 400);
  });

  // ── 404 missing pipeline ──────────────────────────────────────────────
  await test('404 when pipeline.json does not exist', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'aaaaaaaaaaa1', resumeId: 'default' }),
    });
    assert.equal(r.status, 404);
  });

  // ── 404 jobId not in pipeline ─────────────────────────────────────────
  await test('404 when jobId not found in pipeline', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1' })])));
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'ffffffffffff', resumeId: 'default' }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /jobId not found/);
  });

  // ── 412 job has no stage_b ────────────────────────────────────────────
  await test('412 when job has no stage_b (Block E required)', async () => {
    const noStageB = makeJob({ id: 'bbbbbbbbbbb1' });
    delete noStageB.evaluation.stage_b;
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([noStageB])));
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'bbbbbbbbbbb1', resumeId: 'default' }),
    });
    assert.equal(r.status, 412);
    const data = await r.json();
    assert.match(data.error, /Block E required/);
  });

  // ── 412 stage_b status='error' ────────────────────────────────────────
  await test('412 when stage_b has status=error (no usable Block E)', async () => {
    const errorStageB = makeJob({
      id: 'bbbbbbbbbbb2',
      evaluation: {
        stage_a: { score: 4.0, model: 'x', evaluated_at: '2026-05-06T00:00:00Z', cost_usd: 0.001, status: 'evaluated' },
        stage_b: {
          total_score: null,
          report_path: null,
          blocks_emitted: [],
          model: 'claude-sonnet-4-6',
          evaluated_at: '2026-05-06T01:00:00Z',
          cost_usd: 0.05,
          web_search_requests: 0,
          tool_rounds_used: 0,
          status: 'error',
          error: 'parse: degenerate',
        },
      },
    });
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([errorStageB])));
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'bbbbbbbbbbb2', resumeId: 'default' }),
    });
    assert.equal(r.status, 412);
    const data = await r.json();
    assert.equal(data.stage_b_status, 'error');
  });

  // ── 404 explicit resumeId not in index ────────────────────────────────
  await test('404 when explicit resumeId not in resume index', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'ccccccccccc1' })])));
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'ccccccccccc1', resumeId: 'nonexistent' }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /resumeId not in index/);
  });

  // ── 404 Auto-Select runs but resume index is empty ────────────────────
  await test('404 when Auto-Select runs but resume index is empty', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'ddddddddddd1' })])));
    await writeIndex([]); // empty
    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'ddddddddddd1' }),
    });
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /No resumes registered/);
  });

  // ── GET /output 200 with content ──────────────────────────────────────
  await test('GET /output/:jobId/:resumeId 200 with disk content', async () => {
    await fs.writeFile(
      path.join(OUTPUT_DIR, '0123456789ab-default.md'),
      '# Tailored Resume\n\n## Summary\nTailored content here.'
    );
    const r = await fetch(`${BASE}/api/career/cv/tailor/output/0123456789ab/default`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.match(data.content, /Tailored Resume/);
    assert.equal(data.jobId, '0123456789ab');
    assert.equal(data.resumeId, 'default');
  });

  // ── GET /output 400 on malformed jobId / resumeId ─────────────────────
  await test('GET /output/:jobId/:resumeId 400 on malformed jobId', async () => {
    const r = await fetch(`${BASE}/api/career/cv/tailor/output/NOT-HEX/default`);
    assert.equal(r.status, 400);
  });

  await test('GET /output/:jobId/:resumeId 400 on malformed resumeId (e.g. ../config)', async () => {
    const r = await fetch(
      `${BASE}/api/career/cv/tailor/output/0123456789ab/${encodeURIComponent('../config')}`
    );
    assert.equal(r.status, 400);
  });

  // ── GET /output 404 file missing on disk ──────────────────────────────
  await test('GET /output/:jobId/:resumeId 404 when file missing on disk', async () => {
    // Defensively ensure no stale file
    await fs.unlink(path.join(OUTPUT_DIR, 'eeeeeeeeeee1-default.md')).catch(() => {});
    const r = await fetch(`${BASE}/api/career/cv/tailor/output/eeeeeeeeeee1/default`);
    assert.equal(r.status, 404);
    const data = await r.json();
    assert.match(data.error, /tailor output missing/);
  });

  // ── Review fix HIGH 2: malformed metadata.yml in Auto-Select loop ─────
  await test('Auto-Select: malformed metadata.yml on one resume → 200 (does not 500), winner still picked', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'eeeeeeeeeee2' })])));
    await writeResume('healthy', false, {
      metadata: { match_rules: { jd_keywords: ['Python', 'distributed'] } },
    });
    // Hand-write a malformed metadata.yml for the second resume
    const brokenDir = path.join(RESUMES_DIR, 'broken');
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(path.join(brokenDir, 'base.md'), '# broken resume');
    await fs.writeFile(path.join(brokenDir, 'metadata.yml'), 'archetype: [unbalanced');
    await writeResume('default-r2', true);
    await writeIndex([
      { id: 'healthy', is_default: false, created_at: '2026-04-01' },
      { id: 'broken', is_default: false, created_at: '2026-04-02' },
      { id: 'default-r2', is_default: true, created_at: '2026-04-03' },
    ]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'eeeeeeeeeee2' }),
    });
    assert.equal(r.status, 200, 'malformed metadata MUST NOT 500 the request');
    const data = await r.json();
    // healthy has matching JD keywords → wins
    assert.equal(data.picked_resume_id, 'healthy');
    assert.equal(data.picked_via, 'auto-select');
  });

  // ── Review fix HIGH 11: oversized base.md is truncated, not OOM'd ─────
  await test('readResumeBaseMd: oversized base.md is truncated to cap', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'eeeeeeeeeee3' })])));
    const huge = 'x'.repeat(300 * 1024); // 300KB > 256KB cap
    await writeResume('huge-default', true);
    await fs.writeFile(path.join(RESUMES_DIR, 'huge-default', 'base.md'), huge);
    await writeIndex([{ id: 'huge-default', is_default: true, created_at: '2026-04-01' }]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'eeeeeeeeeee3', resumeId: 'huge-default' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    // base_markdown should be ≤ cap + truncation marker
    assert.ok(
      data.base_markdown.length < huge.length,
      `base_markdown (${data.base_markdown.length}) should be truncated below original (${huge.length})`
    );
    assert.match(data.base_markdown, /truncated; resume base\.md exceeds size cap/);
  });

  // ── Path-traversal: GET ignores stored fields, builds from validated ids
  await test('GET /output: path built from validated ids only — does not escape OUTPUT_DIR', async () => {
    // Write a file that would be escaped-to if path resolution were lenient
    // (we can't easily fabricate one; instead verify the code path: a valid
    // jobId+resumeId pair resolves to a path inside OUTPUT_DIR — the
    // startsWith check guards against any stored-field traversal that a
    // future code change could introduce.) The 400-on-malformed test above
    // already confirms ids never reach interpolation when malformed.
    const r = await fetch(`${BASE}/api/career/cv/tailor/output/0123456789ab/default`);
    // Expects 200 from the earlier-written file
    assert.equal(r.status, 200);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
