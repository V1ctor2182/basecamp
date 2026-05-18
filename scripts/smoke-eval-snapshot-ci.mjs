#!/usr/bin/env node
// CI smoke for the full eval pipeline (m1 fixtures + m2 runner + m3
// tuner DI seams).
//
// 07-applier/self-iteration/01-code-calibration m4.
//
// Acceptance criterion (f): "全部 fixture < 60s". This smoke runs the
// actual Playwright snapshot pipeline against every shipped fixture
// and asserts:
//   1. Process completes within 60s wall time
//   2. eval-snapshot --json produces parseable JSON with the expected
//      summary + per-fixture shape (schema_version=1)
//   3. Every fixture emits >0 nodes (snapshot pipeline produced output)
//   4. Score components are finite + in [0,1]
//   5. No fixture-count drift vs the registry on disk
//   6. tune-snapshot --json with a synthetic 1-iter cap runs deterministically
//
// This is the "did the pipeline regress?" gate, NOT a "did the scores
// improve?" gate. The latter is what `tune-snapshot` itself is for —
// see src/career/eval/README.md.
//
// Wall-time budget: ~5-10s expected on macOS local (3 fixtures × ~1.5s
// Playwright snapshot + tuner DI eval). The 60s ceiling is the spec
// acceptance target — well-padded for Linux CI runners.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WALL_TIME_BUDGET_MS = 60_000; // acceptance (f)

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

/**
 * Spawn a child Node process running the given script with SMOKE=1.
 * Returns { stdout, stderr, status, elapsedMs }.
 */
function runScript(scriptPath, args = []) {
  const t0 = Date.now();
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SMOKE: '1' },
    encoding: 'utf8',
    timeout: WALL_TIME_BUDGET_MS,
  });
  const elapsedMs = Date.now() - t0;
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    elapsedMs,
    signal: result.signal,
  };
}

// ── 1. eval-snapshot CLI end-to-end ────────────────────────────────────

let evalResult;
let evalJson;

await test('eval-snapshot: runs to completion within 60s budget', () => {
  evalResult = runScript('scripts/eval-snapshot.mjs', ['--json']);
  if (evalResult.signal === 'SIGTERM') {
    throw new Error(`eval-snapshot exceeded ${WALL_TIME_BUDGET_MS}ms wall-time budget`);
  }
  assert.ok(evalResult.elapsedMs < WALL_TIME_BUDGET_MS, `wall time ${evalResult.elapsedMs}ms exceeded ${WALL_TIME_BUDGET_MS}ms`);
  // status === 0 OR 2 — exit 2 = aggregate below threshold (no threshold passed,
  // so default 0 means we should get 0). Crashes → status === 1 → fail.
  if (evalResult.status !== 0 && evalResult.status !== 2) {
    throw new Error(`eval-snapshot exited ${evalResult.status}. stderr:\n${evalResult.stderr}`);
  }
});

await test('eval-snapshot: stdout is valid JSON with stable schema_version', () => {
  evalJson = JSON.parse(evalResult.stdout);
  assert.equal(evalJson.schema_version, 1);
  assert.match(evalJson.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(evalJson.summary);
  assert.ok(Array.isArray(evalJson.fixtures));
});

await test('eval-snapshot: every shipped fixture appears in the report', () => {
  // 3 seed fixtures shipped in m1: greenhouse-anthropic, lever-stripe, custom-acme.
  // The smoke validates COUNT, not specific ids — new fixtures landing later
  // shouldn't break this gate.
  assert.ok(evalJson.fixtures.length >= 3, `expected ≥ 3 fixtures, got ${evalJson.fixtures.length}`);
  assert.equal(evalJson.summary.n, evalJson.fixtures.length);
});

await test('eval-snapshot: every fixture emitted snapshot nodes (pipeline produced output)', () => {
  for (const fx of evalJson.fixtures) {
    assert.ok(
      fx.nodes_emitted > 0,
      `${fx.id} emitted 0 nodes — snapshot pipeline regressed`,
    );
  }
});

await test('eval-snapshot: score components finite + in [0,1]', () => {
  for (const fx of evalJson.fixtures) {
    const s = fx.score;
    for (const key of ['coverage', 'noise_rate', 'aria_accuracy', 'aggregate']) {
      assert.ok(Number.isFinite(s[key]), `${fx.id}.${key} not finite: ${s[key]}`);
      assert.ok(s[key] >= 0 && s[key] <= 1, `${fx.id}.${key} = ${s[key]} out of [0,1]`);
    }
  }
});

await test('eval-snapshot: counts partition holds (matched + role_mismatch + out_of_allowlist + uncategorized = total)', () => {
  for (const fx of evalJson.fixtures) {
    const c = fx.score.counts;
    const partition = c.matched + c.role_mismatch + c.out_of_allowlist + c.uncategorized_missing;
    assert.equal(
      partition,
      c.total_must_detect,
      `${fx.id} partition ${partition} ≠ total ${c.total_must_detect}`,
    );
  }
});

await test('eval-snapshot: summary.min equals min over per_fixture.aggregate (Q2 pessimistic)', () => {
  const computed = Math.min(...evalJson.summary.per_fixture.map((p) => p.aggregate));
  // round to same precision as buildJsonReport (4 dp)
  const rounded = Math.round(computed * 10000) / 10000;
  assert.equal(evalJson.summary.aggregate_min, rounded);
});

// ── 2. eval-snapshot --threshold gate behavior ─────────────────────────

await test('eval-snapshot: --threshold above current min → exit 2', () => {
  // Current baseline aggregate min is 0% (noise=100% — calibration signal).
  // Threshold 0.99 should fail.
  const r = runScript('scripts/eval-snapshot.mjs', ['--threshold', '0.99']);
  assert.equal(r.status, 2, `expected exit 2 (below threshold), got ${r.status}`);
});

await test('eval-snapshot: --threshold 0 → exit 0 (pipeline-only gate)', () => {
  const r = runScript('scripts/eval-snapshot.mjs', ['--threshold', '0']);
  assert.equal(r.status, 0, `expected exit 0 (threshold met), got ${r.status}. stderr:\n${r.stderr}`);
});

// ── 3. tune-snapshot CLI end-to-end ────────────────────────────────────

let tuneResult;
let tuneJson;

await test('tune-snapshot: --json runs and produces a parseable iteration log', () => {
  tuneResult = runScript('scripts/tune-snapshot.mjs', ['--json', '--max-iter', '5']);
  if (tuneResult.signal === 'SIGTERM') {
    throw new Error(`tune-snapshot exceeded budget`);
  }
  if (tuneResult.status !== 0 && tuneResult.status !== 2) {
    throw new Error(`tune-snapshot exited ${tuneResult.status}. stderr:\n${tuneResult.stderr}`);
  }
  tuneJson = JSON.parse(tuneResult.stdout);
});

await test('tune-snapshot: log carries initial + final allowlists + iteration list', () => {
  assert.equal(tuneJson.schema_version, 1);
  assert.ok(Array.isArray(tuneJson.initial_allowlist));
  assert.ok(Array.isArray(tuneJson.final_allowlist));
  assert.ok(Array.isArray(tuneJson.iterations));
  // baseline iter exists.
  assert.equal(tuneJson.iterations[0].decision, 'baseline');
  assert.equal(tuneJson.iterations[0].iter, 0);
});

await test('tune-snapshot: --json doesnt write proposed-allowlist.txt to disk', async () => {
  // Per CLI contract: --json prints to stdout AND skips the file writes.
  // EH5 reinforced: file outputs are opt-in.
  const { promises: fs } = await import('node:fs');
  const tunerOut = path.join(REPO_ROOT, 'data/career/eval-fixtures/proposed-allowlist.txt');
  const tunerLog = path.join(REPO_ROOT, 'data/career/eval-fixtures/tuner-log.json');
  // Remove any pre-existing artifact from manual runs so we can detect writes.
  await fs.unlink(tunerOut).catch(() => {});
  await fs.unlink(tunerLog).catch(() => {});
  // Re-run with --json
  runScript('scripts/tune-snapshot.mjs', ['--json', '--max-iter', '1']);
  await assert.rejects(fs.access(tunerOut), { code: 'ENOENT' });
  await assert.rejects(fs.access(tunerLog), { code: 'ENOENT' });
});

await test('tune-snapshot: rejects --out path outside data/career/eval-fixtures (EH5 enforcement)', () => {
  const r = runScript('scripts/tune-snapshot.mjs', [
    '--out',
    'src/career/applier/runtime/snapshot.mjs',
  ]);
  // Should refuse to overwrite snapshot.mjs.
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /resolves outside|EH5|allow-external-out/i);
});

await test('tune-snapshot: --max-iter validation rejects out-of-range', () => {
  const r = runScript('scripts/tune-snapshot.mjs', ['--max-iter', '0']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /max-iter must be 1..100/);
});

await test('tune-snapshot: --regression validation rejects out-of-range', () => {
  const r = runScript('scripts/tune-snapshot.mjs', ['--regression', '1.5']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /regression must be 0..1/);
});

// ── 4. EH1 determinism — cross-process ─────────────────────────────────

await test('EH1 determinism: two tune-snapshot runs produce byte-identical log iteration array', () => {
  const a = runScript('scripts/tune-snapshot.mjs', ['--json', '--max-iter', '3']);
  const b = runScript('scripts/tune-snapshot.mjs', ['--json', '--max-iter', '3']);
  assert.equal(a.status, b.status, 'exit codes must match');
  const logA = JSON.parse(a.stdout);
  const logB = JSON.parse(b.stdout);
  // generated_at is now-stamped → expected to differ across runs unless
  // SOURCE_DATE_EPOCH is set. The iteration log itself has no timestamps
  // and MUST be byte-identical.
  assert.deepEqual(
    logA.iterations,
    logB.iterations,
    'EH1 violation: same inputs produced different iteration logs',
  );
  assert.deepEqual(logA.initial_allowlist, logB.initial_allowlist);
  assert.deepEqual(logA.final_allowlist, logB.final_allowlist);
});

// ── Wrap-up ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
