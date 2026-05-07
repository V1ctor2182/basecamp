#!/usr/bin/env node
// Smoke for the GET endpoints that drive the TailorPanel UI:
//   - GET /api/career/resumes (resume picker)
//   - POST /api/career/cv/tailor (Run Tailor)
//   - POST /api/career/render/pdf (Approve → PDF)
//   - GET /api/career/cv/tailor/output/:jobId/:resumeId (recover-on-reopen)
//
// UI itself is verified manually via the dev server (matches Stage B m5
// smoke pattern). Here we lock the wire-shape contracts the UI consumes.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 4591;
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
  return {
    last_scan_at: '2026-05-07T00:00:00Z',
    jobs,
    scan_summary: [],
    totals: {},
  };
}
async function writeResume(id, isDefault, opts = {}) {
  const dir = path.join(RESUMES_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'base.md'),
    opts.baseMd ?? `# ${id} resume\n\n## Summary\nPlaceholder.`
  );
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
  if (existsSync(OUTPUT_DIR)) {
    for (const f of await fs.readdir(OUTPUT_DIR)) {
      if (preExistingOutput.has(f)) continue;
      await fs.unlink(path.join(OUTPUT_DIR, f)).catch(() => {});
    }
  }
  if (existsSync(RESUMES_DIR)) {
    for (const f of await fs.readdir(RESUMES_DIR)) {
      if (preExistingResumeDirs.has(f)) continue;
      await fs.rm(path.join(RESUMES_DIR, f), { recursive: true, force: true }).catch(() => {});
    }
  }
}

try {
  // ── GET /api/career/resumes shape (used by resume picker dropdown) ───
  await test('GET /api/career/resumes: returns {resumes: [{id,title,is_default}]} shape', async () => {
    await writeResume('default', true);
    await writeResume('backend', false);
    await writeIndex([
      { id: 'default', title: 'Default resume', is_default: true, created_at: '2026-04-01' },
      { id: 'backend', title: 'Backend resume', is_default: false, created_at: '2026-04-01' },
    ]);
    const r = await fetch(`${BASE}/api/career/resumes`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(Array.isArray(data.resumes), '{resumes: []} shape');
    assert.equal(data.resumes.length, 2);
    const def = data.resumes.find((x) => x.id === 'default');
    assert.equal(def.is_default, true);
    assert.equal(def.title, 'Default resume');
  });

  // ── POST /tailor: response shape consumed by TailorPanel + DiffViewer
  await test('POST /tailor: response includes tailored_markdown + base_markdown + picked_*', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1' })])));
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'aaaaaaaaaaa1' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    // UI consumes ALL of these fields — lock them
    assert.equal(typeof data.tailored_markdown, 'string', 'tailored_markdown is string');
    assert.equal(typeof data.base_markdown, 'string', 'base_markdown is string');
    assert.match(data.base_markdown, /default resume/);
    assert.equal(typeof data.output_path, 'string');
    assert.equal(typeof data.cost_usd, 'number');
    assert.equal(data.model, 'claude-sonnet-4-6');
    assert.equal(data.picked_resume_id, 'default');
    assert.ok(['explicit', 'auto-select'].includes(data.picked_via));
    assert.equal(typeof data.picked_reason, 'string');
    assert.equal(data.status, 'tailored');
  });

  // ── POST /tailor: userHint propagation (Reject + Re-run path) ────────
  await test('POST /tailor: userHint accepted (Re-run flow)', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'bbbbbbbbbbb1' })])));
    await writeResume('default', true);
    await writeIndex([{ id: 'default', is_default: true, created_at: '2026-04-01' }]);

    const r = await fetch(`${BASE}/api/career/cv/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: 'bbbbbbbbbbb1',
        resumeId: 'default',
        userHint: 'Do not modify the Summary section.',
      }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.status, 'tailored');
  });

  // ── POST /render/pdf: accepts tailored_markdown, returns PDF ─────────
  await test('POST /render/pdf: accepts tailored_markdown body, returns application/pdf', async () => {
    const r = await fetch(`${BASE}/api/career/render/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resume_markdown: '# Tailored Resume\n\n## Summary\nApproved.',
      }),
    });
    // PDF render uses Playwright; if browser unavailable in CI, accept 503
    // (real-money smoke runs locally with chromium). Either way the wire
    // contract is fixed.
    assert.ok(r.status === 200 || r.status === 503, `expected 200 or 503, got ${r.status}`);
    if (r.status === 200) {
      assert.match(r.headers.get('content-type') ?? '', /application\/pdf/);
    }
  });

  // ── GET /tailor/output/:jobId/:resumeId: endpoint exists for future ──
  // recover-on-reopen support (current TailorPanel always re-runs Tailor
  // on open; this endpoint is the contract a future UI revision OR
  // external consumer can rely on). Lock the wire shape now so the
  // ts/wire contract doesn't drift.
  await test('GET /tailor/output/:jobId/:resumeId: round-trips written content', async () => {
    await fs.writeFile(
      path.join(OUTPUT_DIR, '0123456789ab-default.md'),
      '# Tailored\n\n## Summary\nRecovered.'
    );
    const r = await fetch(`${BASE}/api/career/cv/tailor/output/0123456789ab/default`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.match(data.content, /Recovered/);
    assert.equal(data.jobId, '0123456789ab');
    assert.equal(data.resumeId, 'default');
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
