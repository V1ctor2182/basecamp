// Site-adapter activation — pushes a compiled adapter's hints into the
// live control-router + classifier so they affect ongoing classification.
//
// 07-applier/06-site-adapters m2.
//
// Two side effects per activation:
//
//   1. adapter.controls.{date_picker | address_autocomplete |
//      custom_dropdown | file_upload} → 05's DETECTION_RULES
//      (controlRouter.mjs). Each control hint becomes a rule that, when
//      sniff info matches the hint's detect criteria (class_contains /
//      tag_name / aria_role), returns the hint's ControlType.
//
//   2. adapter.known_fields → 03-classifier's regexRules.mjs extra-rule
//      seam. Each known_field becomes a prepended rule that tries
//      before HARD_PATTERNS.
//
// activateAdapter returns a DeactivationToken whose `revert()` removes
// EXACTLY the rules this activation added. Double-revert panics. The
// `_activeTokens` Set tracks live tokens so `isAdapterActive(adapterId)`
// can answer truthfully (multiple activations of the same id are
// allowed but each requires its own revert).
//
// Per OQ2 + OQ3 (locked at planning):
//   - augment, not override (extra rules try first; standard sweep
//     still runs on no match)
//   - never throws on adapters with empty controls / known_fields — a
//     valid adapter with neither still produces a (no-op) token.

import { DETECTION_RULES } from '../nonstandard/controlRouter.mjs';
import { registerExtraRules, clearExtraRules } from '../classifier/regexRules.mjs';

/** @typedef {object} DeactivationToken
 *  @property {string} adapterId
 *  @property {() => void} revert
 *  @property {boolean} reverted — false until revert() runs
 */

/** @type {Set<DeactivationToken>} */
const _activeTokens = new Set();

/**
 * Activate a compiled adapter. Returns a DeactivationToken whose revert()
 * cleanly removes the rules this activation added (no impact on rules
 * added by other activations of the same or different adapter).
 *
 * @param {import('./schema.mjs').CompiledAdapter} adapter
 * @returns {DeactivationToken}
 */
export function activateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !adapter.id) {
    throw new TypeError('activateAdapter: adapter must be a CompiledAdapter (got id=' + String(adapter && adapter.id) + ')');
  }

  // ── 1. Push controls.{} → DETECTION_RULES ─────────────────────────
  //
  // REVIEW C3 fix (CRITICAL): use unshift, not push. controlRouter.mjs's
  // detectControlType iterates DETECTION_RULES in registration order and
  // returns on first match. Baseline rules from m1/m2/m3 register at
  // module-import time, so they sit at the FRONT of the array. If we
  // appended, baseline rules would claim matches first and adapter
  // overrides would never fire — silently breaking the entire point of
  // site adapters. Prepending puts adapter rules FIRST so they win the
  // priority race.
  const pushedRules = [];
  const controls = adapter.controls || {};
  for (const [category, hint] of Object.entries(controls)) {
    if (!hint || typeof hint !== 'object') continue;
    if (!hint.control_type) continue;
    // No detect criteria → the hint can't fire (would force-route every
    // field of this category to a single ControlType regardless of DOM).
    // Skip with no-op rather than crash — adapter author may have wanted
    // a hint comment only.
    if (!hint.detect || typeof hint.detect !== 'object') continue;
    const rule = _makeControlRule(category, hint);
    pushedRules.push(rule);
    DETECTION_RULES.unshift(rule);
  }

  // ── 2. Push known_fields → classifier extra rules (one batch) ────
  //
  // REVIEW H2 fix (CRITICAL): if step 2 throws after step 1 already
  // mutated DETECTION_RULES, undo step 1 so we don't leak rules forever.
  /** @type {string|null} */
  let extraRulesToken = null;
  try {
    if (Array.isArray(adapter.known_fields) && adapter.known_fields.length > 0) {
      const extraRules = adapter.known_fields.map((kf) => ({
        labelRegex: kf.labelRegex,
        class: kf.class,
        lookupKey: kf.maps_to || null,
        subclass: kf.maps_to ? `adapter:${adapter.id}:${kf.maps_to}` : `adapter:${adapter.id}`,
        confidenceHint: kf.confidence || 'medium',
      }));
      extraRulesToken = registerExtraRules(extraRules);
    }
  } catch (err) {
    // Roll back step 1 — controls rules already in DETECTION_RULES.
    for (const r of pushedRules) {
      const idx = DETECTION_RULES.indexOf(r);
      if (idx >= 0) DETECTION_RULES.splice(idx, 1);
    }
    throw err;
  }

  // REVIEW C2 fix (CRITICAL): make `reverted` non-writable so a caller
  // can't bypass double-revert protection via `token.reverted = false`.
  // Authority lives in `_activeTokens.has(token)`, not on the token.
  const token = {
    adapterId: adapter.id,
    revert() {
      // REVIEW C1 fix (CRITICAL): rely on _activeTokens membership as
      // single source of truth for liveness. If we're not in the set,
      // we've been reverted (or never registered). Throw exactly once
      // on double-revert; subsequent calls just no-op (defensive — in
      // production try/finally chains, double-call shouldn't poison).
      if (!_activeTokens.has(token)) {
        throw new Error(`deactivateAdapter: token for "${adapter.id}" already reverted`);
      }
      // REVIEW C1 fix (CRITICAL): atomic revert. Remove from active
      // tokens FIRST so even if subsequent cleanup throws, isAdapterActive
      // reflects reality. Use try/finally to ensure DETECTION_RULES
      // cleanup runs even if extra-rules clear throws.
      _activeTokens.delete(token);
      try {
        if (extraRulesToken) clearExtraRules(extraRulesToken);
      } finally {
        for (const r of pushedRules) {
          const idx = DETECTION_RULES.indexOf(r);
          if (idx >= 0) DETECTION_RULES.splice(idx, 1);
        }
      }
    },
  };
  // Lock `revert` so accidental shadowing (`token.revert = noop`) is
  // caught at write-time rather than producing silent leaks.
  Object.defineProperty(token, 'revert', { writable: false, configurable: false });

  _activeTokens.add(token);
  return token;
}

/**
 * Convenience: revert by token. Equivalent to `token.revert()` but
 * matches the m4 wiring shape (`activateAdapter` followed by
 * `deactivateAdapter(token)` in a try/finally).
 *
 * @param {DeactivationToken} token
 */
export function deactivateAdapter(token) {
  if (!token || typeof token.revert !== 'function') {
    throw new TypeError('deactivateAdapter: invalid token');
  }
  token.revert();
}

/**
 * Is any token currently active for this adapter id? Diagnostic for
 * smoke + future dashboard ("which adapter is in effect right now").
 *
 * @param {string} adapterId
 * @returns {boolean}
 */
export function isAdapterActive(adapterId) {
  // REVIEW C3 fix (CRITICAL): Set membership IS liveness — `_activeTokens.delete`
  // is called atomically inside revert() before any cleanup that might throw.
  // No need to also check a separate `reverted` flag (which the previous
  // implementation could diverge from on partial revert).
  for (const t of _activeTokens) {
    if (t.adapterId === adapterId) return true;
  }
  return false;
}

/** Test-only: wipe all active tokens. Does NOT revert (leaks rules). */
export function _clearActiveTokensForTesting() {
  _activeTokens.clear();
}

/** Diagnostic: count of live tokens. */
export function _activeTokenCount() {
  return _activeTokens.size;
}

/**
 * Build a DETECTION_RULE function from a control hint. The function
 * matches the controlRouter `DETECTION_RULES` contract:
 *   (entry, info, classifiedField) → ControlType | null
 *
 * Matching: every field in hint.detect that is provided must match.
 * Missing info → no match (controlRouter passes null when sniff fails;
 * we don't want to force a ControlType without DOM signal).
 */
function _makeControlRule(_category, hint) {
  const detect = hint.detect;
  // Pre-normalize for hot-path efficiency: every fill goes through this.
  const wantTag = detect.tag_name ? String(detect.tag_name).toUpperCase() : null;
  const wantRole = detect.aria_role ? String(detect.aria_role) : null;
  const wantClass = detect.class_contains ? String(detect.class_contains).toLowerCase() : null;

  return function adapterControlRule(entry, info /* , _classifiedField */) {
    // REVIEW C1 fix (CRITICAL): null-guard entry. controlRouter wraps
    // rule invocations in try/catch (controlRouter.mjs:378) so a crash
    // here would silently swallow the rule and the adapter would
    // never fire — invisibly broken in production.
    if (!entry || !info) return null;
    if (wantTag && info.tagName !== wantTag) return null;
    // REVIEW H2 fix: explicit `entry.role` null-check separate from the
    // role comparison (`undefined !== 'textbox'` is true, but expressing
    // intent — missing role can't satisfy a positive constraint).
    if (wantRole && (!entry.role || entry.role !== wantRole)) return null;
    if (wantClass) {
      const cn = typeof info.className === 'string' ? info.className : '';
      // REVIEW H1 fix (HIGH, m2): token-aware match, not substring.
      // REVIEW H3 fix (HIGH, m3 adv): the bare `startsWith(wantClass)`
      // was too greedy — `Mui` matched `MuiAccordion`. Keep only the
      // hyphen-prefixed startsWith (CSS class family pattern: 'Mui-Foo'
      // class belongs to the 'Mui' family) plus exact-token equality.
      const tokens = cn.toLowerCase().split(/\s+/).filter(Boolean);
      const matched = tokens.some((t) => t === wantClass || t.startsWith(wantClass + '-'));
      if (!matched) return null;
    }
    return hint.control_type;
  };
}
