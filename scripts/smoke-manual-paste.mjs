#!/usr/bin/env node
// Smoke for GET /api/career/finder/needs-manual + PATCH /api/career/pipeline/job/:id/description.
// Spawns the server on a non-default port, points it at a temp data directory
// (clean state per test run), runs HTTP assertions, then tears down.

import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PORT = 4577;
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

// Use the live data/career dir but write our own pipeline.json. To avoid
// clobbering the user's pipeline, back it up first and restore at exit.
const DATA_DIR = path.resolve('data', 'career');
const PIPELINE = path.join(DATA_DIR, 'pipeline.json');
const BACKUP = path.join(DATA_DIR, `pipeline.json.smoke-backup.${process.pid}`);

await fs.mkdir(DATA_DIR, { recursive: true });
let hadOriginal = false;
try {
  await fs.copyFile(PIPELINE, BACKUP);
  hadOriginal = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

function makeFixture(jobs) {
  return {
    last_scan_at: '2026-05-01T00:00:00Z',
    jobs,
    scan_summary: [],
    totals: {},
  };
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'SWE',
    location: ['SF, CA'],
    url: 'https://boards.greenhouse.io/anthropic/jobs/4012345',
    description: null,
    posted_at: null,
    scraped_at: '2026-05-01T00:00:00Z',
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: true,
    ...over,
  };
}

// Spawn server.
const proc = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverReady = false;
proc.stdout.on('data', (b) => {
  const s = b.toString();
  if (s.includes(`API server on :${PORT}`)) serverReady = true;
});
proc.stderr.on('data', () => {}); // keep stderr quiet during smoke

// Wait for ready.
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
  if (hadOriginal) await fs.rename(BACKUP, PIPELINE).catch(() => {});
  else await fs.unlink(PIPELINE).catch(() => {});
}

try {
  // ── GET empty (no needs_manual) ──────────────────────────────────────
  await test('GET needs-manual with empty pipeline → []', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([])));
    const r = await fetch(`${BASE}/api/career/finder/needs-manual`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(data.jobs, []);
  });

  // ── GET with mixed jobs ──────────────────────────────────────────────
  await test('GET needs-manual filters needs_manual_enrich===true; projects view shape', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([
          makeJob({ id: 'aaaaaaaaaaa1', needs_manual_enrich: true }),
          makeJob({ id: 'aaaaaaaaaaa2', needs_manual_enrich: false, description: 'OK' }),
          makeJob({ id: 'aaaaaaaaaaa3', needs_manual_enrich: true, role: 'Backend Engineer' }),
        ])
      )
    );
    const r = await fetch(`${BASE}/api/career/finder/needs-manual`);
    const data = await r.json();
    assert.equal(data.jobs.length, 2);
    assert.deepEqual(
      data.jobs.map((j) => j.id),
      ['aaaaaaaaaaa1', 'aaaaaaaaaaa3']
    );
    // View shape: no `raw`, `description`, `tags`, `schema_version`
    const j = data.jobs[0];
    assert.ok(j.id && j.company && j.role && j.url);
    assert.equal(j.description, undefined);
    assert.equal(j.raw, undefined);
    assert.equal(j.tags, undefined);
  });

  // ── PATCH valid → 200 + flag cleared ─────────────────────────────────
  await test('PATCH valid description → 200, sets description, clears needs_manual_enrich', async () => {
    await fs.writeFile(
      PIPELINE,
      JSON.stringify(
        makeFixture([makeJob({ id: 'aaaaaaaaaaa1', needs_manual_enrich: true })])
      )
    );
    const r = await fetch(`${BASE}/api/career/pipeline/job/aaaaaaaaaaa1/description`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Pasted JD body — ten chars min.' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.ok, true);
    assert.equal(data.job.id, 'aaaaaaaaaaa1');
    assert.equal(data.job.needs_manual_enrich, false);
    assert.match(data.job.description, /^Pasted JD body/);
    // Verify pipeline.json on disk has the change too
    const persisted = JSON.parse(await fs.readFile(PIPELINE, 'utf-8'));
    const job = persisted.jobs.find((j) => j.id === 'aaaaaaaaaaa1');
    assert.equal(job.needs_manual_enrich, false);
    assert.match(job.description, /^Pasted JD body/);
  });

  // ── PATCH non-existent id → 404 ──────────────────────────────────────
  await test('PATCH non-existent job id → 404', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1' })])));
    const r = await fetch(`${BASE}/api/career/pipeline/job/zzzzzzzzzzzz/description`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Pasted JD body, ten chars.' }),
    });
    assert.equal(r.status, 404);
  });

  // ── PATCH zod-invalid (too short) → 400 ─────────────────────────────
  await test('PATCH description shorter than 10 chars → 400', async () => {
    await fs.writeFile(PIPELINE, JSON.stringify(makeFixture([makeJob({ id: 'aaaaaaaaaaa1' })])));
    const r = await fetch(`${BASE}/api/career/pipeline/job/aaaaaaaaaaa1/description`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'too short' }),
    });
    assert.equal(r.status, 400);
    const data = await r.json();
    assert.match(data.error, /Invalid description/);
  });

  // ── PATCH missing field → 400 ───────────────────────────────────────
  await test('PATCH missing description field → 400', async () => {
    const r = await fetch(`${BASE}/api/career/pipeline/job/aaaaaaaaaaa1/description`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  // ── PATCH while pipeline.json missing → 404 ──────────────────────────
  await test('PATCH against missing pipeline.json → 404', async () => {
    await fs.unlink(PIPELINE).catch(() => {});
    const r = await fetch(`${BASE}/api/career/pipeline/job/aaaaaaaaaaa1/description`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Pasted JD body, ten chars.' }),
    });
    assert.equal(r.status, 404);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
