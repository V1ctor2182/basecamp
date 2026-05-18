// Tuner candidate generator — read m2 eval signals, propose simple
// allowlist edits (add-role / remove-role) per Q3 (simple-only V1).
//
// 07-applier/self-iteration/01-code-calibration m3.
//
// Candidate kinds (locked Q3):
//   - { kind: 'add', role: string }      — add to INTERACTIVE_ROLES
//   - { kind: 'remove', role: string }   — drop from INTERACTIVE_ROLES
//
// Compound rules (heading where level > N, etc.) are deferred to V2
// when real fixture data drives the need.
//
// Sources of evidence:
//   - add candidates:
//     · truth roles in `detail.out_of_allowlist` (annotator marked role
//       that snapshot pipeline can't emit today — adding the role is
//       the obvious fix)
//   - remove candidates:
//     · observed roles for `detail.leaked` rows (banlist entry that
//       did surface — its role(s) are the carrier)
//
// Dedup: roles are unique across the candidate list. We never propose
// the same role twice in one iteration even if multiple fixtures
// surface it.
//
// Ordering: deterministic alpha-by-(kind, role). EH1 requires same
// inputs → same final allowlist; same candidate ORDER is the cheapest
// way to make tie-breaking reproducible.

/**
 * @typedef {object} Candidate
 * @property {'add' | 'remove'} kind
 * @property {string} role
 * @property {string[]} evidence_fixture_ids — fixtures where this signal fired
 */

/**
 * Generate add/remove candidates from a set of FixtureResult records.
 *
 * @param {Array<import('./runner.mjs').FixtureResult>} results — from evalRegistry
 * @param {Iterable<string>} currentAllowlist — current INTERACTIVE_ROLES values
 * @returns {Candidate[]} — sorted (kind, role) alpha
 */
export function generateCandidates(results, currentAllowlist) {
  const currentSet = new Set(currentAllowlist);

  /** Map<role, Set<fixtureId>> for both kinds. */
  const addEvidence = new Map();
  const removeEvidence = new Map();

  for (const r of results) {
    const d = r.score?.detail;
    if (!d) continue;
    // ── add candidates: out_of_allowlist truth roles ─────────────────
    for (const item of d.out_of_allowlist || []) {
      const role = item.role;
      if (!role) continue;
      if (currentSet.has(role)) continue; // already in; not an "add" candidate
      if (!addEvidence.has(role)) addEvidence.set(role, new Set());
      addEvidence.get(role).add(r.id);
    }
    // ── remove candidates: observed_roles on leaked entries ──────────
    for (const item of d.leaked || []) {
      const roles = item.observed_roles || [];
      for (const role of roles) {
        if (!currentSet.has(role)) continue; // not in allowlist → can't remove
        if (!removeEvidence.has(role)) removeEvidence.set(role, new Set());
        removeEvidence.get(role).add(r.id);
      }
    }
  }

  const out = [];
  for (const [role, fixtures] of addEvidence) {
    out.push({
      kind: 'add',
      role,
      evidence_fixture_ids: [...fixtures].sort(),
    });
  }
  for (const [role, fixtures] of removeEvidence) {
    out.push({
      kind: 'remove',
      role,
      evidence_fixture_ids: [...fixtures].sort(),
    });
  }
  // Deterministic order (EH1): add-before-remove by kind, role-alpha
  // within each kind. Tuner's "pick best" tie-break inherits this.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
  });
  return out;
}

/**
 * Apply a candidate to an allowlist Set/Array and return a NEW Set
 * (current allowlist remains untouched — caller decides whether to
 * commit). Throws on invalid op (add when already present, remove
 * when not present) so the search loop catches generator bugs early.
 *
 * @param {Iterable<string>} currentAllowlist
 * @param {Candidate} candidate
 * @returns {Set<string>}
 */
export function applyCandidate(currentAllowlist, candidate) {
  const next = new Set(currentAllowlist);
  if (candidate.kind === 'add') {
    if (next.has(candidate.role)) {
      throw new Error(`applyCandidate: add ${JSON.stringify(candidate.role)} but already in allowlist`);
    }
    next.add(candidate.role);
  } else if (candidate.kind === 'remove') {
    if (!next.has(candidate.role)) {
      throw new Error(`applyCandidate: remove ${JSON.stringify(candidate.role)} but not in allowlist`);
    }
    next.delete(candidate.role);
  } else {
    throw new TypeError(`applyCandidate: unknown kind ${JSON.stringify(candidate.kind)}`);
  }
  return next;
}

/**
 * Hashable string for a candidate — used by tuner to skip candidates
 * already tried this iteration (or to flag oscillation: add X then
 * remove X next iteration).
 */
export function candidateKey(candidate) {
  return `${candidate.kind}:${candidate.role}`;
}
