// recovery.mjs
//
// 07-applier/04-multi-step/m11 — Pure helpers for Phase 4 recovery
// flows. Same .mjs pattern as triage.mjs / submitGate.mjs so smoke
// can drive transforms with fixtures.
//
// Exports:
//   shouldShowResumeCompress(field, errors)
//   shouldShowAltFormats(field, errors)
//   shouldShowIdentifyAts(session)
//   shouldShowUserHint(field)
//   altFormatLadder(fieldClass)
//   parseUserHint(hint)
//   RECOVERY_ATSES   — the 4 buttons + 2 fallbacks per P4-OQ3
//
// Locked OQs (per plan-milestones 2026-05-27):
//   P4-OQ3 — 4 + 2 buttons: Greenhouse / Lever / Workday / iCIMS +
//            "I don't know" + Skip
//   P4-OQ4 — user_hints: store envelope; parseable → strategy try;
//            unparseable → recorded_only
//   P4-OQ5 — Recovery buttons only render when error_code/state matches

/** Identification choices the operator can make in Recovery 3. */
export const RECOVERY_ATSES = Object.freeze([
  'greenhouse',
  'lever',
  'workday',
  'icims',
  'unknown',  // "I don't know" — record but don't change adapter
  'skip',     // pass through; continue with generic
]);

/** Phone format ladder for Recovery 2. The classifier emits the first
 *  variant; if that lands an `invalid_format` error from the ATS, we
 *  walk the ladder. Source: Recovery 2 design block. */
const PHONE_LADDER = Object.freeze([
  '9292353841',
  '(929) 235-3841',
  '+19292353841',
  '1-929-235-3841',
]);

const DATE_LADDER = Object.freeze([
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
]);

/** Adapter names we know about. Other site_adapter values are also
 *  effectively "unknown" in the eyes of the operator since the loader
 *  falls back to generic for unrecognized strings — but for the UI
 *  trigger we use the literal generic. */
const UNKNOWN_ADAPTER_SIGNALS = new Set(['generic']);

/**
 * Recovery 1: Re-render resume at compressed quality.
 * Trigger: error_code='too_large' attached to a file-class field.
 */
export function shouldShowResumeCompress(field, errors) {
  if (!field || field.class !== 'file') return false;
  if (!Array.isArray(errors)) return false;
  // [review H2] An unattributed "Resume too large" error should only
  // match the actual resume slot — not a passport upload that shares
  // the file class. Convention: __file_0 is the resume slot
  // (machine.mjs:237) OR subclass === 'resume' when the classifier
  // populated it.
  const isResumeSlot =
    field.refId === '__file_0' || field.subclass === 'resume';
  return errors.some((e) => {
    if (!e) return false;
    const isTooLarge =
      e.error_code === 'too_large' || /too\s*large/i.test(e.error_msg ?? '');
    if (!isTooLarge) return false;
    if (e.field === field.refId) return true;
    // Unattributed errors only resolve against the resume slot.
    if (!e.field && isResumeSlot) return true;
    return false;
  });
}

/**
 * Recovery 2: Try alternative formats.
 * Trigger: error_code='invalid_format' AND we have a hardcoded ladder
 * for the field's classifier class.
 */
export function shouldShowAltFormats(field, errors) {
  if (!field) return false;
  const ladder = altFormatLadder(field.class) ?? altFormatLadder(field.subclass);
  if (!ladder || ladder.length === 0) return false;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) =>
    e && (e.error_code === 'invalid_format' || /(invalid|format|must match)/i.test(e.error_msg ?? ''))
    && (!e.field || e.field === field.refId),
  );
}

/**
 * Recovery 3: Identify ATS. Renders the 6-button row in the status
 * board when the loaded adapter is generic / unrecognized.
 *
 * @param {object} session - ApplySession
 * @returns {boolean}
 */
export function shouldShowIdentifyAts(session) {
  if (!session || typeof session !== 'object') return false;
  const adapter = session.site_adapter;
  return UNKNOWN_ADAPTER_SIGNALS.has(adapter);
}

/**
 * Recovery 4: User hint inline input. Triggers when the strategy
 * ladder is fully exhausted OR a fill_error landed and we have no
 * other recovery option.
 */
export function shouldShowUserHint(field) {
  if (!field) return false;
  const vs = field.verify_status;
  return vs === 'fill_error' || vs === 'all_strategies_failed';
}

/**
 * Hardcoded ladder per classifier class. Returns null when we have no
 * alt-format playbook (most classes — the operator's better off
 * Skipping or hinting).
 *
 * @param {string} classOrSubclass
 * @returns {string[] | null}
 */
export function altFormatLadder(classOrSubclass) {
  if (!classOrSubclass) return null;
  const k = String(classOrSubclass).toLowerCase();
  if (k === 'phone' || k === 'phone_number' || k === 'tel') return [...PHONE_LADDER];
  if (k === 'date' || k === 'birthdate' || k === 'date_of_birth') return [...DATE_LADDER];
  return null;
}

/**
 * Parse an operator-supplied free-text hint into a strategy guess.
 * Per Recovery 4 design + P4-OQ4:
 *
 *   "scroll/dropdown"     → keyboardInput with scroll preamble
 *   "click first"         → role_locator_click (first match)
 *   "open then type"      → react_select_click  (open + filter)
 *   "ARIA combobox" /     → aria_combobox
 *     "use the popup"
 *   anything else         → recorded_only (Phase 6 classifier evidence)
 *
 * Returns the parsed strategy name OR null when the hint is unparseable.
 *
 * @param {string} hint
 * @returns {{ strategy: string, confidence: 'high' | 'medium' } | null}
 */
export function parseUserHint(hint) {
  if (!hint || typeof hint !== 'string') return null;
  const h = hint.toLowerCase();
  // [review M1] Tightened "click first" to require an option-noun
  // context so "click somewhere first" doesn't false-positive into
  // role_locator_click. Also explicitly NULL-out double-click and
  // right-click — they need their own ladder slot when one exists.
  if (/\b(double|right)[- ]click\b/.test(h)) {
    return null;
  }
  // Strong patterns — high confidence.
  if (/\bscroll\b.*\bdropdown\b|\bdropdown\b.*\bscroll\b/.test(h)) {
    return { strategy: 'keyboard_input', confidence: 'high' };
  }
  if (/\bclick\s+(?:the\s+)?first\s+(?:option|match|item|result|entry|one)\b/.test(h)) {
    return { strategy: 'role_locator_click', confidence: 'high' };
  }
  if (/\b(open|click)\b.*\b(then|and)\b.*\btype\b/.test(h)) {
    return { strategy: 'react_select_click', confidence: 'high' };
  }
  if (/\b(aria\s*combobox|popup)\b/.test(h)) {
    return { strategy: 'aria_combobox', confidence: 'high' };
  }
  // Medium-confidence single keywords — still parseable.
  if (/\btype\b/.test(h)) {
    return { strategy: 'keyboard_input', confidence: 'medium' };
  }
  if (/\bclick\b/.test(h)) {
    return { strategy: 'role_locator_click', confidence: 'medium' };
  }
  return null;
}

/** Group recovery-button visibility hints for a single field card
 *  given the latest submit attempts (form_errors). Returns an object
 *  the FieldCard can spread into action enables. */
export function fieldRecoveryAffordances(field, submitAttempts) {
  const lastErrors = lastAttemptErrors(submitAttempts);
  return {
    resumeCompress: shouldShowResumeCompress(field, lastErrors),
    altFormats: shouldShowAltFormats(field, lastErrors),
    altLadder: shouldShowAltFormats(field, lastErrors)
      ? (altFormatLadder(field?.class) ?? altFormatLadder(field?.subclass))
      : null,
    userHint: shouldShowUserHint(field),
  };
}

/** Pull form_errors from the most recent submit_attempts entry. */
function lastAttemptErrors(submitAttempts) {
  if (!Array.isArray(submitAttempts) || submitAttempts.length === 0) return [];
  const last = submitAttempts[submitAttempts.length - 1];
  return Array.isArray(last?.form_errors) ? last.form_errors : [];
}
