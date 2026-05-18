// Iteration log + unified-diff formatter for the auto-tuner.
//
// 07-applier/self-iteration/01-code-calibration m3.
//
// EH5: tuner output MUST be a reviewable diff (not direct mutation
// of snapshot.mjs). This module owns:
//   1. The append-only iteration log structure (EH1 reproducibility:
//      same fixtures + same initial allowlist → same log byte-for-byte).
//   2. The unified diff between initial INTERACTIVE_ROLES and the
//      tuner's converged allowlist, ready for human review.

/**
 * @typedef {object} IterationRecord
 * @property {number} iter                  — 1-indexed
 * @property {import('./candidates.mjs').Candidate | null} candidate — null at iter 0 / no-candidates
 * @property {'accepted' | 'rejected_no_improvement' | 'rejected_regression' | 'no_candidates'} decision
 * @property {number} aggregate_before
 * @property {number} aggregate_after       — post-candidate-eval (or same as before if rejected_no_improvement)
 * @property {number} aggregate_delta
 * @property {Array<{ id: string, before: number, after: number, delta: number }>} per_fixture_deltas
 * @property {Array<{ id: string, delta: number }>} regression_failures — fixtures regressing >threshold (only when decision=rejected_regression)
 * @property {string} reason                — human-readable
 */

/**
 * Build a new empty log object. Caller appends IterationRecords as
 * the search progresses; finalize() seals it.
 */
export function newLog(initialAllowlist) {
  return {
    schema_version: 1,
    initial_allowlist: [...initialAllowlist].sort(),
    final_allowlist: null, // set by finalize()
    converged: false, // set by finalize()
    stalled: false, // set by finalize() — signals existed but EH2 gate blocked all
    max_iterations_reached: false,
    iterations: [],
  };
}

export function appendIteration(log, record) {
  log.iterations.push(record);
}

export function finalize(log, finalAllowlist, { converged, maxReached, stalled = false }) {
  log.final_allowlist = [...finalAllowlist].sort();
  log.converged = !!converged;
  log.stalled = !!stalled;
  log.max_iterations_reached = !!maxReached;
  return log;
}

/**
 * Build a per-fixture delta row by zipping baseline + candidate scores.
 * Exported for tuner.mjs to use when deciding accept/reject.
 *
 * @param {Array<{id: string, score: {aggregate: number}}>} baseline
 * @param {Array<{id: string, score: {aggregate: number}}>} candidate
 * @returns {Array<{id: string, before: number, after: number, delta: number}>}
 */
export function perFixtureDeltas(baseline, candidate) {
  const byId = new Map(candidate.map((r) => [r.id, r]));
  return baseline.map((b) => {
    const rawAfter = byId.get(b.id)?.score.aggregate;
    const rawBefore = b?.score?.aggregate;
    // REVIEW C1 (adv) / M1 (Plan) fix [CRITICAL EH2 enforcement]: if
    // either side is NaN/undefined, the naive `after - before` returns
    // NaN, and `NaN < -threshold` is FALSE — silently bypassing the
    // regression gate. Force a sentinel -Infinity delta so the tuner
    // marks it as a regression. Same applies to fixture-renamed cases
    // where byId.get returns undefined.
    const beforeFinite = Number.isFinite(rawBefore);
    const afterFinite = Number.isFinite(rawAfter);
    if (!beforeFinite || !afterFinite) {
      return {
        id: b.id,
        before: beforeFinite ? rawBefore : null,
        after: afterFinite ? rawAfter : null,
        delta: -Infinity,
      };
    }
    return { id: b.id, before: rawBefore, after: rawAfter, delta: round4(rawAfter - rawBefore) };
  });
}

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/**
 * Format a unified diff between initial and final allowlists. Suitable
 * for writing to `proposed-allowlist.diff` (EH5: reviewable, never
 * auto-committed).
 *
 * Output format mimics `diff -u` on the INTERACTIVE_ROLES export so
 * a reviewer can mentally paste it back into snapshot.mjs.
 *
 * @param {Iterable<string>} initial
 * @param {Iterable<string>} final
 * @returns {string}
 */
export function formatAllowlistDiff(initial, final) {
  const i = [...initial].sort();
  const f = [...final].sort();
  const iSet = new Set(i);
  const fSet = new Set(f);
  const added = f.filter((r) => !iSet.has(r));
  const removed = i.filter((r) => !fSet.has(r));

  const lines = [];
  lines.push('--- a/src/career/applier/runtime/snapshot.mjs (INTERACTIVE_ROLES, initial)');
  lines.push('+++ b/src/career/applier/runtime/snapshot.mjs (INTERACTIVE_ROLES, tuner-proposed)');
  lines.push('@@ INTERACTIVE_ROLES @@');
  // Show union with +/-/space prefixes, alpha-sorted for stable review.
  const union = [...new Set([...i, ...f])].sort();
  for (const role of union) {
    if (!iSet.has(role) && fSet.has(role)) {
      lines.push(`+  '${role}',`);
    } else if (iSet.has(role) && !fSet.has(role)) {
      lines.push(`-  '${role}',`);
    } else {
      lines.push(`   '${role}',`);
    }
  }
  lines.push('');
  lines.push(`# Summary: +${added.length} added [${added.join(', ')}] -${removed.length} removed [${removed.join(', ')}]`);
  lines.push('# REVIEW EH5: never auto-committed. Run smoke + verify scores before editing snapshot.mjs.');
  return lines.join('\n');
}
