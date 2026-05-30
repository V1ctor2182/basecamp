// cardActions.mjs
//
// 07-applier/04-multi-step/m9 — Pure helpers for the per-field card.
//
// Same pattern as triage.mjs: keep transforms outside the React
// component so smoke can exercise them with fixtures.
//
// Two main exports:
//   - deriveTriedLadder(field, submitAttempts) → ladder rows
//   - applySseEvent(field, eventName, payload) → next verify_status
//
// Plus shared constants for the UI:
//   - DEFAULT_LADDER_NAMES — the 5 strategy names from Phase 2/m4
//   - LADDER_STATE_VALUES — possible per-strategy states

/** The 5 strategies in Phase 2/m4 DEFAULT_LADDER, in ladder order.
 *  Kept locally instead of importing from runtime so the dashboard
 *  bundle doesn't pull in Playwright types. */
export const DEFAULT_LADDER_NAMES = Object.freeze([
  'selectOption',
  'react_select_click',
  'keyboard_input',
  'role_locator_click',
  'aria_combobox',
]);

export const LADDER_STATE_VALUES = Object.freeze([
  'fail',      // ✗ — tried, didn't land
  'verified',  // ✓ — tried, value matched expected
  'pending',   // ⏸ — not tried yet (later in ladder, or not attempted)
  'unknown',   // ? — no signal — caller fell back to a non-ladder path
]);

/**
 * Build the "Tried row" cells from a field's verify state + the
 * session's submit_attempts log. The log records strategies the
 * machine actually tried for each field across submit rounds; we
 * project that onto the static 5-slot ladder for the UI.
 *
 * @param {object} field - aggregated field (output of triage.mjs)
 * @param {Array<{ fixes_tried?: Array<{ field: string, fix_name: string, result: string }> }>} submitAttempts
 * @returns {Array<{ name: string, state: 'fail'|'verified'|'pending'|'unknown' }>}
 */
export function deriveTriedLadder(field, submitAttempts) {
  // Default — everything pending.
  const slots = new Map();
  for (const name of DEFAULT_LADDER_NAMES) {
    slots.set(name, 'pending');
  }

  if (!field || !Array.isArray(submitAttempts)) {
    return [...slots.entries()].map(([name, state]) => ({ name, state }));
  }

  // Match by DraftField.refId === FixTried.field (m6's adapter
  // preserves this mapping).
  const fieldKey = field.refId;
  for (const attempt of submitAttempts) {
    const fixes = attempt?.fixes_tried;
    if (!Array.isArray(fixes)) continue;
    for (const fix of fixes) {
      if (!fix || fix.field !== fieldKey) continue;
      const name = fix.fix_name;
      if (!slots.has(name)) continue;  // skip unknown / Phase 6 strategies
      // Result enum from Phase 2/m4: 'verified', 'fill_ok_verify_mismatch',
      // 'no_effect', 'no_effect_timeout', 'option_not_found', etc.
      const state = fix.result === 'verified' ? 'verified' : 'fail';
      // Later attempts override earlier ones — last write wins so the
      // ladder reflects the latest known per-strategy outcome.
      slots.set(name, state);
    }
  }

  return [...slots.entries()].map(([name, state]) => ({ name, state }));
}

/**
 * Reduce an incoming SSE event onto a single field's verify_status.
 * Used by Apply.tsx's onMessage handler to update local card state
 * before the next poll picks up the persisted truth.
 *
 * Event kinds we react to:
 *   - 'field_input' / 'field_change' (from Phase 2/m6 observer)
 *     payload = { field_ref, value, event_type }
 *       — if value === expected → 'verified' (matched)
 *       — non-empty mismatch → 'stale' (UI yellow)
 *       — empty → null (no change)
 *   - 'field_skip' (from our own /skip-field broadcast)
 *     payload = { ref, new_status='skipped_by_user' }
 *       — verify_status = 'skipped_by_user'
 *   - other events → null (no change)
 *
 * @param {object} field - aggregated field
 * @param {string} eventName
 * @param {object} payload
 * @returns {{ verify_status: string | null } | null}
 */
export function applySseEvent(field, eventName, payload) {
  if (!field || !payload) return null;
  if (typeof eventName !== 'string') return null;

  // Field-action broadcasts from our own endpoints. The `ref` key
  // matches DraftField.refId.
  if (eventName === 'field_skip' && payload.ref === field.refId) {
    return { verify_status: 'skipped_by_user' };
  }

  // Observer events fire on raw form interaction. The browser-side
  // observer reports the field by its NAME attribute (or id, or
  // aria-label) — call that `field_ref` to disambiguate from our
  // DraftField.refId. Matching is best-effort string equality;
  // mismatches are silently dropped (typical for unlabeled fields).
  if (eventName === 'field_input' || eventName === 'field_change') {
    if (payload.field_ref !== field.refId) return null;
    const value = String(payload.value ?? '');
    const expected = String(field.suggested_value ?? '');
    if (value.length === 0) return null;
    // [P3 design §4.4]: matched value flips to 'verified' (green);
    // non-empty mismatch flips to 'stale' (yellow — the operator
    // typed something but it doesn't match the classifier's expected).
    if (normalize(value) === normalize(expected)) {
      return { verify_status: 'verified' };
    }
    return { verify_status: 'stale' };
  }

  return null;
}

/** verifyValue's compare semantics (Phase 2/m4 shared.mjs).
 *  Local copy to avoid pulling in the runtime module. */
function normalize(s) {
  return String(s ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

/**
 * Aggregate all SSE-driven updates into a fresh verify_status map.
 * Apply.tsx feeds this back into a setState({field_ref: verify_status})
 * cache that overlays the polled session.
 *
 * @param {Array<object>} fields - aggregated fields
 * @param {Array<{ event: string, payload: object }>} eventLog
 * @returns {Record<string, string>}  refId → verify_status
 */
export function buildSseOverlay(fields, eventLog) {
  const overlay = {};
  if (!Array.isArray(fields) || !Array.isArray(eventLog)) return overlay;
  for (const evt of eventLog) {
    if (!evt || typeof evt.event !== 'string') continue;
    for (const f of fields) {
      const r = applySseEvent(f, evt.event, evt.payload);
      if (r && r.verify_status) overlay[f.refId] = r.verify_status;
    }
  }
  return overlay;
}
