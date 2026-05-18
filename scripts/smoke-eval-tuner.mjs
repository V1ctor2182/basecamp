#!/usr/bin/env node
// Pure-function + DI-evaluator smoke for the auto-tuner.
//
// 07-applier/self-iteration/01-code-calibration m3.
//
// No Playwright — uses tune()'s opts.evaluator DI seam to inject a
// deterministic synthetic scorer that drives every code path:
//   - normal convergence
//   - EH2 regression gate firing
//   - EH1 determinism (same input → same output)
//   - max-iterations cutoff
//   - no-candidates terminator
//   - oscillation avoidance (tried-keys)
//
// The candidates.mjs + iterationLog.mjs pure functions get their own
// targeted asserts. CLI behavior + writeFile paths are covered by
// the m4 CI smoke (which runs the real Playwright tuner end-to-end).

import assert from 'node:assert/strict';

import {
  generateCandidates,
  applyCandidate,
  candidateKey,
} from '../src/career/eval/candidates.mjs';
import {
  newLog,
  appendIteration,
  finalize,
  perFixtureDeltas,
  formatAllowlistDiff,
} from '../src/career/eval/iterationLog.mjs';
import { tune } from '../src/career/eval/tuner.mjs';

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

// ── 1. candidates.mjs ──────────────────────────────────────────────────

function mkResult(id, { out_of_allowlist = [], leaked = [] } = {}) {
  return {
    id,
    score: {
      aggregate: 0,
      detail: { out_of_allowlist, leaked },
    },
  };
}

await test('generateCandidates: out_of_allowlist → add candidates', () => {
  const results = [mkResult('a', { out_of_allowlist: [{ role: 'spinbutton', name: 'Age' }] })];
  const cands = generateCandidates(results, new Set(['textbox', 'button']));
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0], {
    kind: 'add',
    role: 'spinbutton',
    evidence_fixture_ids: ['a'],
  });
});

await test('generateCandidates: leaked observed_roles → remove candidates', () => {
  const results = [
    mkResult('a', { leaked: [{ name: 'Privacy', reason: 'footer', observed_roles: ['link'] }] }),
  ];
  const cands = generateCandidates(results, new Set(['textbox', 'link', 'button']));
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0], {
    kind: 'remove',
    role: 'link',
    evidence_fixture_ids: ['a'],
  });
});

await test('generateCandidates: dedup across fixtures', () => {
  const results = [
    mkResult('a', { out_of_allowlist: [{ role: 'spinbutton', name: 'X' }] }),
    mkResult('b', { out_of_allowlist: [{ role: 'spinbutton', name: 'Y' }] }),
  ];
  const cands = generateCandidates(results, new Set(['textbox']));
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0].evidence_fixture_ids, ['a', 'b']);
});

await test('generateCandidates: skip add when role already in allowlist', () => {
  const results = [mkResult('a', { out_of_allowlist: [{ role: 'textbox', name: 'A' }] })];
  // Pathological: out_of_allowlist contains a role that IS in the allowlist
  // (shouldn't happen from runner but defensive). Skip — already in.
  const cands = generateCandidates(results, new Set(['textbox']));
  assert.equal(cands.length, 0);
});

await test('generateCandidates: skip remove when role not in allowlist', () => {
  const results = [
    mkResult('a', { leaked: [{ name: 'X', reason: 'y', observed_roles: ['heading'] }] }),
  ];
  const cands = generateCandidates(results, new Set(['textbox', 'button']));
  // heading not in allowlist → no remove candidate
  assert.equal(cands.length, 0);
});

await test('generateCandidates: deterministic alpha order (add-then-remove, alpha within)', () => {
  const results = [
    mkResult('a', {
      out_of_allowlist: [
        { role: 'tab', name: 'X' },
        { role: 'searchbox', name: 'Y' },
        { role: 'spinbutton', name: 'Z' },
      ],
      leaked: [
        { name: 'F1', reason: 'r', observed_roles: ['link'] },
        { name: 'F2', reason: 'r', observed_roles: ['button'] },
      ],
    }),
  ];
  const cands = generateCandidates(results, new Set(['textbox', 'link', 'button']));
  const keys = cands.map(candidateKey);
  // add candidates first (alpha), then remove (alpha)
  assert.deepEqual(keys, [
    'add:searchbox',
    'add:spinbutton',
    'add:tab',
    'remove:button',
    'remove:link',
  ]);
});

await test('applyCandidate: add returns new Set with role', () => {
  const next = applyCandidate(['a', 'b'], { kind: 'add', role: 'c' });
  assert.deepEqual([...next].sort(), ['a', 'b', 'c']);
});

await test('applyCandidate: remove returns new Set without role', () => {
  const next = applyCandidate(['a', 'b', 'c'], { kind: 'remove', role: 'b' });
  assert.deepEqual([...next].sort(), ['a', 'c']);
});

await test('applyCandidate: add duplicate throws', () => {
  assert.throws(
    () => applyCandidate(['a'], { kind: 'add', role: 'a' }),
    /already in allowlist/,
  );
});

await test('applyCandidate: remove missing throws', () => {
  assert.throws(
    () => applyCandidate(['a'], { kind: 'remove', role: 'b' }),
    /not in allowlist/,
  );
});

await test('applyCandidate: unknown kind throws', () => {
  assert.throws(
    () => applyCandidate(['a'], { kind: 'frobnicate', role: 'a' }),
    /unknown kind/,
  );
});

await test('applyCandidate: does NOT mutate input', () => {
  const orig = new Set(['a', 'b']);
  applyCandidate(orig, { kind: 'add', role: 'c' });
  assert.deepEqual([...orig].sort(), ['a', 'b']);
});

// ── 2. iterationLog.mjs ────────────────────────────────────────────────

await test('newLog: initialAllowlist sorted alpha', () => {
  const log = newLog(['z', 'a', 'm']);
  assert.deepEqual(log.initial_allowlist, ['a', 'm', 'z']);
  assert.equal(log.iterations.length, 0);
  assert.equal(log.converged, false);
  assert.equal(log.final_allowlist, null);
});

await test('finalize: sets final_allowlist + converged + max_reached flags', () => {
  const log = newLog(['a']);
  finalize(log, new Set(['a', 'b']), { converged: true, maxReached: false });
  assert.deepEqual(log.final_allowlist, ['a', 'b']);
  assert.equal(log.converged, true);
  assert.equal(log.max_iterations_reached, false);
});

await test('perFixtureDeltas: zip + compute delta per id', () => {
  const baseline = [
    { id: 'a', score: { aggregate: 0.5 } },
    { id: 'b', score: { aggregate: 0.3 } },
  ];
  const candidate = [
    { id: 'a', score: { aggregate: 0.7 } },
    { id: 'b', score: { aggregate: 0.25 } },
  ];
  const deltas = perFixtureDeltas(baseline, candidate);
  assert.equal(deltas[0].delta, 0.2);
  assert.equal(deltas[1].delta, -0.05);
});

await test('perFixtureDeltas: missing candidate row → after=null + delta=-Infinity (REVIEW C1)', () => {
  // Pre-fix: missing → after=0, delta=-0.5 (incorrect: bypassed gate
  // when before was also 0). Post-fix: missing → after=null, delta=
  // -Infinity (always flagged as regression).
  const baseline = [{ id: 'a', score: { aggregate: 0.5 } }];
  const candidate = []; // candidate run produced nothing for this fixture
  const deltas = perFixtureDeltas(baseline, candidate);
  assert.equal(deltas[0].after, null);
  assert.equal(deltas[0].delta, -Infinity);
});

await test('formatAllowlistDiff: + lines for adds, - lines for removes', () => {
  const diff = formatAllowlistDiff(['button', 'textbox'], ['button', 'combobox', 'textbox']);
  assert.match(diff, /\+ {2}'combobox'/);
  assert.match(diff, /Summary: \+1 added/);
});

await test('formatAllowlistDiff: union sorted, unchanged rows prefixed by space', () => {
  const diff = formatAllowlistDiff(['a', 'b'], ['a', 'c']);
  const lines = diff.split('\n');
  // Look for the prefixed roles
  assert.ok(lines.some((l) => l === "   'a',"));
  assert.ok(lines.some((l) => l === "-  'b',"));
  assert.ok(lines.some((l) => l === "+  'c',"));
});

// ── 3. tune() with synthetic evaluator ─────────────────────────────────

/** Build a synthetic evaluator that returns deterministic scores
 *  driven by simple rules on the allowlist contents. */
function makeSyntheticEvaluator(scoreFn, signalFn = () => ({ out_of_allowlist: [], leaked: [] })) {
  return async (allowlist) => {
    const allowlistArr = [...allowlist].sort();
    const fixtureIds = ['fxA', 'fxB', 'fxC'];
    const results = fixtureIds.map((id) => ({
      id,
      vendor: 'synth',
      page_type: null,
      nodes_emitted: 0,
      skipped_frames: 0,
      score: {
        aggregate: scoreFn(id, allowlistArr),
        coverage: scoreFn(id, allowlistArr),
        noise_rate: 0,
        aria_accuracy: 1,
        counts: {},
        detail: signalFn(id, allowlistArr),
      },
    }));
    const aggs = results.map((r) => r.score.aggregate);
    return {
      results,
      summary: {
        min: aggs.reduce((a, b) => Math.min(a, b), Infinity),
        mean: aggs.reduce((a, b) => a + b, 0) / aggs.length,
        n: results.length,
      },
    };
  };
}

await test('tune: normal convergence — accepts candidate that improves min, stops when no more', async () => {
  // Scoring: each fixture's score = 0.5 if allowlist contains 'spinbutton'
  // else 0.0 for fxA, 0.5 for fxB, 0.5 for fxC. Adding spinbutton lifts
  // fxA from 0 → 0.5; min goes 0 → 0.5. Then no more signal → converge.
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      if (id === 'fxA') return allowlist.includes('spinbutton') ? 0.5 : 0;
      return 0.5;
    },
    (id, allowlist) =>
      allowlist.includes('spinbutton')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'spinbutton', name: 'Age' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox', 'button'],
    evaluator,
    maxIterations: 5,
  });
  assert.equal(result.converged, true);
  assert.ok(result.finalAllowlist.has('spinbutton'));
  const accepted = result.log.iterations.filter((i) => i.decision === 'accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].candidate.role, 'spinbutton');
});

await test('tune: EH2 — rejects candidate that improves min but regresses another fixture >5%', async () => {
  // 'link' add: improves fxA from 0 → 0.8 but tanks fxB from 0.5 → 0.4 (Δ=-0.1, fails 5%).
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      const hasLink = allowlist.includes('link');
      if (id === 'fxA') return hasLink ? 0.8 : 0.0;
      if (id === 'fxB') return hasLink ? 0.4 : 0.5; // regresses 0.1 > 0.05 threshold
      return 0.7;
    },
    (id, allowlist) =>
      allowlist.includes('link')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'link', name: 'Nav' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 5,
  });
  // Candidate should be rejected → no spinbutton added → final allowlist same as initial.
  assert.equal(result.finalAllowlist.has('link'), false);
  // The rejection should be logged with decision='rejected_regression'.
  const rej = result.log.iterations.find((i) => i.decision === 'rejected_regression');
  assert.ok(rej, 'expected an iteration with rejected_regression decision');
  assert.equal(rej.regression_failures[0].id, 'fxB');
  assert.ok(rej.regression_failures[0].delta < -0.05);
});

await test('tune: EH2 — candidate within 5% regression IS accepted (boundary)', async () => {
  // 'link' add: improves min from 0 → 0.45 with at-most -0.05 on fxB.
  // -0.05 is NOT strictly < -0.05, so passes.
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      const hasLink = allowlist.includes('link');
      if (id === 'fxA') return hasLink ? 0.5 : 0.0;
      if (id === 'fxB') return hasLink ? 0.45 : 0.5; // exactly -0.05 — boundary
      return 0.7;
    },
    (id, allowlist) =>
      allowlist.includes('link')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'link', name: 'Nav' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 5,
  });
  assert.ok(result.finalAllowlist.has('link'), 'boundary regression should pass');
});

await test('tune: EH1 — deterministic (same input → same final allowlist + iteration log)', async () => {
  let callCount = 0;
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      callCount++;
      if (id === 'fxA') return allowlist.includes('spinbutton') ? 0.8 : 0.2;
      return 0.6;
    },
    (id, allowlist) =>
      allowlist.includes('spinbutton')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'spinbutton', name: 'Age' }], leaked: [] },
  );
  const r1 = await tune({
    initialAllowlist: ['textbox', 'button'],
    evaluator,
    maxIterations: 5,
  });
  callCount = 0;
  const r2 = await tune({
    initialAllowlist: ['textbox', 'button'],
    evaluator,
    maxIterations: 5,
  });
  assert.deepEqual([...r1.finalAllowlist].sort(), [...r2.finalAllowlist].sort());
  assert.equal(r1.log.iterations.length, r2.log.iterations.length);
  assert.equal(JSON.stringify(r1.log.iterations), JSON.stringify(r2.log.iterations));
});

await test('tune: max_iterations — stops at limit, flags max_iterations_reached', async () => {
  // Endless-improvement evaluator: every iteration the next candidate
  // role yields a tiny improvement. With maxIterations=2 and 5 candidate
  // roles available, we stop at 2 with max_reached=true.
  const candidatePool = ['searchbox', 'spinbutton', 'tab', 'tooltip', 'switch'];
  let acceptedCount = 0;
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      // Every added role from the pool adds 0.1 to fxA, leaving fxB/fxC at 0.5.
      let s = 0;
      for (const role of allowlist) {
        if (candidatePool.includes(role)) s += 0.1;
      }
      if (id === 'fxA') return Math.min(s, 0.9);
      return 0.5;
    },
    (id, allowlist) => {
      // Always offer the next role not yet added.
      const next = candidatePool.find((r) => !allowlist.includes(r));
      if (!next) return { out_of_allowlist: [], leaked: [] };
      return { out_of_allowlist: [{ role: next, name: 'X' }], leaked: [] };
    },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 2,
  });
  acceptedCount = result.log.iterations.filter((i) => i.decision === 'accepted').length;
  assert.equal(acceptedCount, 2, 'expected exactly maxIterations acceptances');
  assert.equal(result.log.max_iterations_reached, true);
  assert.equal(result.converged, false, 'should not flag converged when hit max');
});

await test('tune: no_candidates → terminates with converged=true', async () => {
  const evaluator = makeSyntheticEvaluator(
    () => 0.5,
    () => ({ out_of_allowlist: [], leaked: [] }), // no signals ever
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 5,
  });
  assert.equal(result.converged, true);
  assert.equal(result.log.iterations.length, 2); // baseline + no_candidates
  assert.equal(result.log.iterations[1].decision, 'no_candidates');
});

await test('tune: triedKeys — same accepted candidate is not re-proposed in later iterations', async () => {
  // Add 'spinbutton' improves min 0→0.5. After acceptance, a buggy
  // signal source keeps proposing add:spinbutton; triedKeys must suppress
  // it so we don't infinite-loop on the same op.
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      if (id === 'fxA') return allowlist.includes('spinbutton') ? 0.7 : 0.0;
      return 0.5;
    },
    // Bug simulation: always proposes spinbutton even after it's added
    () => ({ out_of_allowlist: [{ role: 'spinbutton', name: 'X' }], leaked: [] }),
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 5,
  });
  // Exactly ONE accepted add:spinbutton then converge (no_candidates because
  // the only candidate is filtered out by triedKeys).
  const accepted = result.log.iterations.filter((i) => i.decision === 'accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].candidate.role, 'spinbutton');
  assert.ok(result.converged);
  // After acceptance, the next iteration sees the same candidate signal
  // but triedKeys suppresses it → no_candidates terminator fires.
  const terminator = result.log.iterations[result.log.iterations.length - 1];
  assert.equal(terminator.decision, 'no_candidates');
});

await test('REVIEW C1 (adv) / M1 (Plan): NaN baseline aggregate → delta=-Infinity → EH2 gate rejects', () => {
  // Direct test of perFixtureDeltas — the bypass vector. Without the
  // fix, NaN baseline + 0 candidate → delta=NaN, gate passes silently.
  const baseline = [{ id: 'fxA', score: { aggregate: NaN } }];
  const candidate = [{ id: 'fxA', score: { aggregate: 0 } }];
  const deltas = perFixtureDeltas(baseline, candidate);
  assert.equal(deltas[0].delta, -Infinity, 'NaN baseline must produce -Infinity delta');
});

await test('REVIEW C1 (adv): undefined after (fixture renamed) → delta=-Infinity', () => {
  const baseline = [{ id: 'old-name', score: { aggregate: 0.5 } }];
  const candidate = [{ id: 'new-name', score: { aggregate: 0.5 } }];
  const deltas = perFixtureDeltas(baseline, candidate);
  assert.equal(deltas[0].delta, -Infinity, 'missing candidate row must produce -Infinity delta');
});

await test('REVIEW M5 (Plan): rejected_no_improvement decision when candidate passes gate but Δ=0', async () => {
  // Add 'spinbutton' produces signal but score doesn't budge — should
  // hit the rejected_no_improvement branch, not rejected_regression.
  const evaluator = makeSyntheticEvaluator(
    () => 0.5, // every allowlist scores identically → Δ=0
    (id, allowlist) =>
      allowlist.includes('spinbutton')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'spinbutton', name: 'X' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 3,
  });
  // Should NOT accept (no improvement) but the iteration should be
  // logged with decision='rejected_no_improvement' as the headline.
  const rejected = result.log.iterations.find(
    (i) => i.decision === 'rejected_no_improvement',
  );
  assert.ok(rejected, 'expected rejected_no_improvement iteration');
  // Verify the new stalled flag fires (signals existed, gate blocked all).
  assert.equal(result.stalled, true);
  assert.equal(result.converged, false);
});

await test('REVIEW H3 (Plan): iteration record carries full rejected_candidates list', async () => {
  // Three candidates, all rejected for different reasons:
  //   add:spinbutton → no improvement (Δ=0)
  //   add:searchbox  → regression on fxC (-0.2 < -0.05)
  //   remove:link    → no improvement
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      // searchbox tanks fxC. nothing else moves min.
      if (id === 'fxC' && allowlist.includes('searchbox')) return 0.3;
      return 0.5;
    },
    (id, allowlist) => {
      const out_of_allowlist = [];
      if (!allowlist.includes('spinbutton')) out_of_allowlist.push({ role: 'spinbutton', name: 'A' });
      if (!allowlist.includes('searchbox')) out_of_allowlist.push({ role: 'searchbox', name: 'B' });
      const leaked = allowlist.includes('link')
        ? [{ name: 'Privacy', reason: 'footer', observed_roles: ['link'] }]
        : [];
      return { out_of_allowlist, leaked };
    },
  );
  const result = await tune({
    initialAllowlist: ['textbox', 'link'],
    evaluator,
    maxIterations: 2,
  });
  // First non-baseline iter should have rejected_candidates with 3 entries.
  const iter1 = result.log.iterations.find((i) => i.iter === 1);
  assert.ok(iter1, 'expected iter=1 in log');
  assert.ok(iter1.rejected_candidates, 'iteration record must include rejected_candidates');
  assert.equal(iter1.rejected_candidates.length, 3);
  // Determinism: rejected_candidates entries in deterministic candidate order
  const keys = iter1.rejected_candidates.map((r) => `${r.candidate.kind}:${r.candidate.role}`);
  assert.deepEqual(keys, ['add:searchbox', 'add:spinbutton', 'remove:link']);
});

await test('REVIEW H4 (Plan) + M3 (adv): rejected candidate is NOT re-evaluated next iter (triedKeys tracks rejected)', async () => {
  // add:link regresses fxB → rejected. The next iteration should
  // observe link's signal again (still leaked) but the tuner must
  // suppress it via triedKeys → no_candidates terminator.
  let evaluatorCallCount = 0;
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => {
      evaluatorCallCount++;
      if (id === 'fxA') return allowlist.includes('link') ? 0.8 : 0.3;
      if (id === 'fxB') return allowlist.includes('link') ? 0.4 : 0.5; // 0.1 regression > 0.05
      return 0.6;
    },
    (id, allowlist) =>
      allowlist.includes('link')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'link', name: 'Nav' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 5,
  });
  // Expect: baseline + iter1 rejected (link), break (stalled).
  // Should NOT see iter2 re-trying link.
  const iterNumbers = result.log.iterations.map((i) => i.iter);
  // baseline=0, then stall at iter=1 (no improvement / regression). At most 2 records.
  assert.equal(result.log.iterations.length, 2);
  assert.equal(iterNumbers[0], 0);
  assert.equal(iterNumbers[1], 1);
  // The evaluator should be called: 1 baseline (3 fixtures) + 1 candidate (3 fixtures)
  // through the synthetic — meaning at most 6 calls. Without the fix it
  // would loop until maxIter=5 → 1+5=6 candidate evals × 3 fixtures = far more.
  assert.ok(evaluatorCallCount < 30, `evaluator called ${evaluatorCallCount} times — too many`);
});

await test('tune: log records baseline iteration as iter=0', async () => {
  const evaluator = makeSyntheticEvaluator(
    () => 0.5,
    () => ({ out_of_allowlist: [], leaked: [] }),
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 1,
  });
  assert.equal(result.log.iterations[0].iter, 0);
  assert.equal(result.log.iterations[0].decision, 'baseline');
  assert.equal(result.log.iterations[0].aggregate_before, 0.5);
});

await test('tune: diff string is non-empty + identifies snapshot.mjs target', async () => {
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => (allowlist.includes('spinbutton') ? 0.5 : 0.2),
    (id, allowlist) =>
      allowlist.includes('spinbutton')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'spinbutton', name: 'Age' }], leaked: [] },
  );
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator,
    maxIterations: 2,
  });
  assert.match(result.diff, /snapshot\.mjs/);
  assert.match(result.diff, /INTERACTIVE_ROLES/);
  assert.match(result.diff, /\+ {2}'spinbutton'/);
  assert.match(result.diff, /EH5/);
});

await test('tune: evaluator throw on a candidate → that candidate skipped, search continues', async () => {
  const evaluator = makeSyntheticEvaluator(
    (id, allowlist) => (allowlist.includes('spinbutton') ? 0.7 : 0.3),
    (id, allowlist) =>
      allowlist.includes('spinbutton')
        ? { out_of_allowlist: [], leaked: [] }
        : { out_of_allowlist: [{ role: 'spinbutton', name: 'X' }], leaked: [] },
  );
  // Wrap evaluator to throw on a SPECIFIC candidate
  const wrapped = async (allowlist) => {
    // throw on the "remove:textbox" attempt — should never be proposed,
    // but the safety net should still catch it if it were
    if (!allowlist.has('textbox')) throw new Error('synthetic crash');
    return evaluator(allowlist);
  };
  const result = await tune({
    initialAllowlist: ['textbox'],
    evaluator: wrapped,
    maxIterations: 3,
  });
  // Should still converge (spinbutton add succeeds, no rebroken state)
  assert.ok(result.finalAllowlist.has('spinbutton'));
});

// ── Wrap-up ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
