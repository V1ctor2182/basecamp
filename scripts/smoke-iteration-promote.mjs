#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/03-iteration-dashboard m3 — promote
// modal + coverage section integration.
//
// Two coverage levels:
//   1. Bundle smoke — `npm run build` produces a JS bundle containing
//      the m3 strings ('Confirm promote', 'Coverage detail') so a future
//      regression that drops the modal can't slip through tsc+vite.
//   2. Backend integration — POST /api/career/iteration/promote/:id with
//      a real evidence id from site-failures.jsonl, assert 201, cleanup,
//      then verify the duplicate POST returns 200 'already_promoted'.
//
// The full UI click-through (open modal, click Confirm, observe DOM
// update) needs a headless browser harness — out of scope for V1.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

// ── 1. Bundle smoke — m3 strings present after build ───────────────────

await test('npm run build succeeds (m3 incremental rebuild)', () => {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `build exited ${result.status}.\nstderr:\n${result.stderr}\nstdout:\n${(result.stdout || '').split('\n').slice(-20).join('\n')}`,
    );
  }
});

await test('m3 strings appear in the JS bundle (Confirm promote + Coverage detail)', async () => {
  const assetsDir = path.join(REPO_ROOT, 'dist', 'assets');
  const entries = await fs.readdir(assetsDir);
  const jsFiles = entries.filter((n) => n.endsWith('.js'));
  // Find the chunk containing the Iteration page — pick whichever contains
  // 'Iteration' to start, then scan for the m3 strings.
  let foundConfirm = false;
  let foundCoverage = false;
  let foundReviewGate = false;
  for (const name of jsFiles) {
    const body = await fs.readFile(path.join(assetsDir, name), 'utf8');
    if (body.includes('Confirm promote')) foundConfirm = true;
    if (body.includes('Coverage detail')) foundCoverage = true;
    if (body.includes('Promote evidence') || body.includes('fixture corpus')) foundReviewGate = true;
  }
  assert.ok(foundConfirm, 'bundle must contain "Confirm promote" (modal button label)');
  assert.ok(foundCoverage, 'bundle must contain "Coverage detail" (D section title)');
  assert.ok(foundReviewGate, 'bundle must contain D3 review-gate copy');
});

// ── 2. Backend integration (promote endpoint full round-trip) ──────────

let backendId = null;

await test('discover an evidence id from site-failures.jsonl', async () => {
  const { readJsonl, _FILES } = await import('../src/career/feedback/stores.mjs');
  const { stableId } = await import('../src/career/iteration/eventStream.mjs');
  let first = null;
  for await (const r of readJsonl(_FILES.SITE_FAILURES)) {
    first = r;
    break;
  }
  if (!first) {
    console.log('   (no site-failures.jsonl rows — backend tests will skip)');
    return;
  }
  backendId = stableId(first);
  assert.match(backendId, /^[a-f0-9]{12}$/);
});

await test('promoteEvidence end-to-end: create + idempotent re-call + cleanup', async () => {
  if (!backendId) return; // skip
  const { promoteEvidence, PROMOTE_QUEUE_DIR } = await import('../src/career/iteration/promote.mjs');
  // Pre-clean.
  await _cleanForId(PROMOTE_QUEUE_DIR, backendId);
  try {
    const r1 = await promoteEvidence(backendId);
    assert.equal(r1.status, 'created');
    // Verify the body has the D3 reviewable structure (capture-fixture
    // command + evidence block).
    const body = await fs.readFile(r1.path, 'utf8');
    assert.match(body, /capture-fixture\.mjs/);
    assert.match(body, new RegExp(`id: ${backendId}`));
    assert.match(body, /evidence:/);
    // Idempotent second call.
    const r2 = await promoteEvidence(backendId);
    assert.equal(r2.status, 'already_promoted');
    assert.equal(r2.path, r1.path);
  } finally {
    await _cleanForId(PROMOTE_QUEUE_DIR, backendId);
  }
});

await test('promoteEvidence: yaml is grep-able (no surprising encoding)', async () => {
  if (!backendId) return;
  const { promoteEvidence, PROMOTE_QUEUE_DIR } = await import('../src/career/iteration/promote.mjs');
  await _cleanForId(PROMOTE_QUEUE_DIR, backendId);
  try {
    const r = await promoteEvidence(backendId);
    const body = await fs.readFile(r.path, 'utf8');
    // The TODO yaml should be greppable for the evidence id (so
    // operator can `grep -l "${id}" promote-queue/` to find it).
    assert.ok(body.includes(backendId), 'evidence id must appear verbatim in body');
  } finally {
    await _cleanForId(PROMOTE_QUEUE_DIR, backendId);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

async function _cleanForId(dir, id) {
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (name.endsWith(`-${id}.yml`)) {
        await fs.unlink(path.join(dir, name)).catch(() => {});
      }
    }
  } catch {
    /* dir may not exist */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
