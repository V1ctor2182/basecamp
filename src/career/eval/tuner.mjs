// Deterministic auto-tuner for snapshot.mjs INTERACTIVE_ROLES.
//
// 07-applier/self-iteration/01-code-calibration m3.
//
// Algorithm (greedy 1-candidate-per-iteration, Q3 simple-only):
//
//   loop until convergence OR max_iterations (=20):
//     1. eval current allowlist → baseline scores
//     2. generate candidates from baseline (add/remove role)
//     3. for each candidate (in deterministic order):
//          a. apply → new allowlist
//          b. eval all fixtures with new allowlist
//          c. per-fixture delta = new.aggregate - old.aggregate
//          d. regression_failures = fixtures with delta < -regressionThreshold
//          e. improvement = new.aggregate_min - old.aggregate_min
//     4. accept candidate iff:
//          - regression_failures is empty (EH2: ≤5% per-fixture)
//          - improvement > 0
//          - improvement is the maximum over all candidates (tie-break
//            via (kind, role) alpha — same order generateCandidates
//            returns)
//     5. if none accepted → converged, break
//     6. commit candidate, append iteration log, repeat
//
// EH1 deterministic: no Math.random, Set iteration order is insertion
// order (preserved by Plan A), candidate generation is alpha-sorted.
// Same fixtures + same initialAllowlist → same iterations + same
// final allowlist.
//
// EH2: per-fixture regression gate (default 0.05) is hard-required.
// A candidate that improves the aggregate min by 10% but tanks one
// fixture by 6% is rejected.
//
// EH5: tuner returns the log + diff; caller writes to disk. Never
// mutates snapshot.mjs itself.

import { INTERACTIVE_ROLES } from '../applier/runtime/snapshot.mjs';
import { loadFixtures, DEFAULT_FIXTURES_DIR } from './fixtures/loader.mjs';
import { evalRegistry } from './runner.mjs';
import { generateCandidates, applyCandidate, candidateKey } from './candidates.mjs';
import {
  newLog,
  appendIteration,
  finalize,
  perFixtureDeltas,
  formatAllowlistDiff,
} from './iterationLog.mjs';

export const DEFAULT_MAX_ITERATIONS = 20;     // acceptance (d)
export const DEFAULT_REGRESSION_THRESHOLD = 0.05; // EH2 ≤5% per-fixture
// REVIEW M1 (adv) fix: cap candidates per iteration so an adversarial
// truth.yml listing 200 distinct out-of-allowlist roles can't drag the
// tuner into 200 × 20 = 4000 full Playwright evals. 50 is comfortably
// above realistic ATS allowlist diff sizes (3-10 candidates per iter
// in practice).
export const MAX_CANDIDATES_PER_ITER = 50;

/**
 * @typedef {object} TuneResult
 * @property {Set<string>} finalAllowlist
 * @property {object}      log           — IterationLog (see iterationLog.mjs)
 * @property {string}      diff          — unified-diff string (EH5)
 * @property {boolean}     converged
 */

/**
 * @param {object} opts
 * @param {string} [opts.fixturesDir=DEFAULT_FIXTURES_DIR]
 * @param {Iterable<string>} [opts.initialAllowlist=INTERACTIVE_ROLES]
 * @param {number} [opts.maxIterations=20]
 * @param {number} [opts.regressionThreshold=0.05]
 * @param {(allowlist: Set<string>) => Promise<{results: any[], summary: any}>} [opts.evaluator]
 *   — DI seam for smoke tests. Default: evalRegistry over fixturesDir.
 *     Smoke replaces it with a synthetic deterministic scorer so the
 *     full tuner loop is testable without Playwright.
 * @returns {Promise<TuneResult>}
 */
export async function tune(opts = {}) {
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const regressionThreshold = opts.regressionThreshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const initialAllowlist = new Set(opts.initialAllowlist ?? INTERACTIVE_ROLES);

  // Default evaluator: load fixtures once, eval against given allowlist.
  // Keep browser warm across iterations (closeBrowserOnFinish:false) —
  // closed once at the end.
  let registry = null;
  const defaultEvaluator = async (allowlist) => {
    if (!registry) registry = await loadFixtures(fixturesDir);
    return evalRegistry(registry, {
      roleAllowlist: allowlist,
      closeBrowserOnFinish: false,
    });
  };
  const evaluator = opts.evaluator ?? defaultEvaluator;

  const log = newLog(initialAllowlist);
  // REVIEW H3 (Plan) fix: distinguish "genuinely converged" (no signals
  // to act on, allowlist optimal under current evidence) from "stalled"
  // (signals exist but every candidate failed the EH2 gate or has no
  // positive improvement). Operator reading the log needs both bits.
  let stalled = false;
  let currentAllowlist = new Set(initialAllowlist);
  let converged = false;
  let maxReached = false;

  try {
    // Iter 0: record baseline as the first iteration with decision='baseline'
    const baselineResult = await evaluator(currentAllowlist);
    let baselineMin = baselineResult.summary?.min ?? 0;
    appendIteration(log, {
      iter: 0,
      candidate: null,
      decision: 'baseline',
      aggregate_before: baselineMin,
      aggregate_after: baselineMin,
      aggregate_delta: 0,
      per_fixture_deltas: baselineResult.results.map((r) => ({
        id: r.id,
        before: r.score.aggregate,
        after: r.score.aggregate,
        delta: 0,
      })),
      regression_failures: [],
      reason: 'baseline scores with initial allowlist',
    });

    /** REVIEW H4 (Plan) + M3 (adv) fix: track BOTH accepted and rejected
     *  candidates so each unique (kind, role) is evaluated at most once
     *  per tune() run. Pre-fix rejected candidates were re-evaluated
     *  every iteration (same signals → same rejection → wasted Playwright
     *  evals), and the search could only terminate via the !best branch.
     *  EH1 holds either way; this is purely an efficiency + clarity fix.
     */
    const triedKeys = new Set();
    let baselineResults = baselineResult.results;

    for (let iter = 1; iter <= maxIterations; iter++) {
      const allCandidates = generateCandidates(baselineResults, currentAllowlist).filter(
        (c) => !triedKeys.has(candidateKey(c)),
      );
      // REVIEW M1 (adv) fix: cap candidates per iteration.
      const candidates = allCandidates.slice(0, MAX_CANDIDATES_PER_ITER);
      const truncatedCount = allCandidates.length - candidates.length;
      if (candidates.length === 0) {
        appendIteration(log, {
          iter,
          candidate: null,
          decision: 'no_candidates',
          aggregate_before: baselineMin,
          aggregate_after: baselineMin,
          aggregate_delta: 0,
          per_fixture_deltas: [],
          regression_failures: [],
          reason:
            truncatedCount > 0
              ? `no new candidates after trying ${triedKeys.size} (+${truncatedCount} truncated by cap last iter)`
              : 'no new (add/remove) candidates from signals',
          rejected_candidates: [],
        });
        converged = true;
        break;
      }

      // Evaluate every candidate this iteration. Stash the best one
      // and the supporting deltas; commit at end of iteration.
      // REVIEW H3 (Plan) fix: keep the full rejected[] list so the
      // iteration record can surface every rejection (not just one).
      let best = null;
      const rejected = [];
      for (const cand of candidates) {
        const nextAllowlist = applyCandidate(currentAllowlist, cand);
        let candResult;
        try {
          candResult = await evaluator(nextAllowlist);
        } catch (err) {
          rejected.push({
            cand,
            reason: `evaluator threw: ${err.message || err}`,
            regression_failures: [],
          });
          continue;
        }
        const candMin = candResult.summary?.min ?? 0;
        const improvement = round4(candMin - baselineMin);
        const deltas = perFixtureDeltas(baselineResults, candResult.results);
        const regression_failures = deltas
          .filter((d) => d.delta < -regressionThreshold)
          .map((d) => ({ id: d.id, delta: d.delta }));
        if (regression_failures.length > 0) {
          rejected.push({
            cand,
            reason: `regression >${regressionThreshold} on ${regression_failures.length} fixture(s)`,
            regression_failures,
            deltas,
            improvement,
          });
          continue;
        }
        if (improvement <= 0) {
          rejected.push({
            cand,
            reason: improvement === 0 ? 'no improvement (Δ=0)' : 'negative improvement on min',
            regression_failures: [],
            deltas,
            improvement,
          });
          continue;
        }
        // Candidate passes both gates. Track the best by improvement
        // DESC; tie-break by candidate sort order (already deterministic
        // from generateCandidates).
        if (!best || improvement > best.improvement) {
          best = {
            cand,
            improvement,
            candResult,
            deltas,
          };
        }
      }

      // Mark every rejected candidate as tried so we don't re-evaluate
      // it in subsequent iterations.
      for (const r of rejected) {
        triedKeys.add(candidateKey(r.cand));
      }

      if (!best) {
        // REVIEW H3 (Plan) fix: log the FULL list of rejected candidates
        // (with reason + regression details for each). Pre-fix only one
        // example was stored — 80% information loss with 5 candidates.
        // Pick the "headline" example for the decision label (one that
        // improved aggregate but failed the gate, if any).
        const rejWithImprovement = rejected
          .filter((r) => Number.isFinite(r.improvement) && r.improvement > 0)
          .sort((a, b) => b.improvement - a.improvement)[0];
        const example = rejWithImprovement ?? rejected[0];
        appendIteration(log, {
          iter,
          candidate: example?.cand ?? null,
          decision: example?.regression_failures?.length
            ? 'rejected_regression'
            : 'rejected_no_improvement',
          aggregate_before: baselineMin,
          aggregate_after: baselineMin,
          aggregate_delta: 0,
          per_fixture_deltas: example?.deltas ?? [],
          regression_failures: example?.regression_failures ?? [],
          reason:
            'no candidate satisfied EH2 gate + improvement; ' +
            `${rejected.length} candidate(s) rejected this iter` +
            (truncatedCount > 0 ? ` (+${truncatedCount} truncated by cap)` : '') +
            (example ? `; headline: ${candidateKey(example.cand)} (${example.reason})` : ''),
          rejected_candidates: rejected.map((r) => ({
            candidate: r.cand,
            reason: r.reason,
            improvement: Number.isFinite(r.improvement) ? r.improvement : null,
            regression_failures: r.regression_failures || [],
          })),
        });
        stalled = true; // signals exist; gate blocked them all
        converged = false;
        break;
      }

      // Commit best candidate.
      const acceptedAllowlist = applyCandidate(currentAllowlist, best.cand);
      const candMin = best.candResult.summary?.min ?? 0;
      appendIteration(log, {
        iter,
        candidate: best.cand,
        decision: 'accepted',
        aggregate_before: baselineMin,
        aggregate_after: round4(candMin),
        aggregate_delta: best.improvement,
        per_fixture_deltas: best.deltas,
        regression_failures: [],
        reason: `Δ=+${best.improvement} on aggregate min; no fixture regressed >${regressionThreshold}`,
      });
      currentAllowlist = acceptedAllowlist;
      baselineMin = round4(candMin);
      baselineResults = best.candResult.results;
      triedKeys.add(candidateKey(best.cand));

      if (iter === maxIterations) {
        maxReached = true;
      }
    }
  } finally {
    // Close the browser singleton once the search is done.
    try {
      const { closeBrowser } = await import('../applier/runtime/browser.mjs');
      await closeBrowser();
    } catch {
      /* best-effort */
    }
  }

  finalize(log, currentAllowlist, { converged, maxReached, stalled });
  const diff = formatAllowlistDiff(initialAllowlist, currentAllowlist);
  return {
    finalAllowlist: currentAllowlist,
    log,
    diff,
    converged,
    stalled,
  };
}

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}
