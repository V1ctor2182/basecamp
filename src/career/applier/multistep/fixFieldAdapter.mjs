// fixFieldAdapter.mjs
//
// 07-applier/04-multi-step/m12 (Phase 6 wiring) — bridge from m6
// submitLoop's `_fixField(page, fieldRef, errorRecord)` shape to
// 02-playwright-runtime/m4 fillWithFallback's
// `(page, locator, expected)` shape.
//
// The submit-first loop's `_fixField` is invoked when parseFormErrors
// reports an inline error on a field the machine already filled. The
// adapter:
//
//   1. Resolves the form field to a Playwright Locator via several
//      best-effort strategies — fieldRef may be a DraftField.refId
//      (synthetic like '__file_0') OR the form's own internal name
//      attribute (what parseFormErrors emits as errorRecord.field).
//   2. Looks up the expected value from the active session's
//      per_step_draft + field_memory. Without an expected value
//      fillWithFallback has nothing to compare against.
//   3. Calls fillWithFallback. Translates the nested result shape
//      (`{strategies_tried, final}`) into the flat shape m6 expects
//      (`{field, fix_name, result, success}`).
//
// strategies_tried[] preservation — included on the return so callers
// (m6 submitLoop, future Phase 5/m5 flywheel) can persist the full
// ladder trace per fix. m6's FixTriedSchema currently drops it; future
// schema bump will accept.

import { fillWithFallback } from '../runtime/fillWithFallback.mjs';
import { SnapshotError } from '../runtime/errors.mjs';

/**
 * Build a `_fixField` adapter closed over the session.
 *
 * @param {object} session — the ApplySession (mutable reference; the
 *   adapter only READS from it).
 * @returns {(page: object, fieldRef: string, errorRecord: object) => Promise<object>}
 */
export function buildFixFieldAdapter(session) {
  return async function fixFieldAdapter(page, fieldRef, errorRecord) {
    if (!page) {
      return {
        field: fieldRef ?? errorRecord?.field ?? '(unknown)',
        fix_name: 'no_page',
        result: 'no_effect',
        success: false,
      };
    }
    const effectiveRef = fieldRef ?? errorRecord?.field ?? null;
    if (!effectiveRef) {
      return {
        field: '(unknown)',
        fix_name: 'no_field_ref',
        result: 'no_effect',
        success: false,
      };
    }

    // ── 1. Look up expected value via session lookup ──────────────
    const expected = lookupExpectedValue(session, effectiveRef, errorRecord);
    if (expected == null || expected === '') {
      return {
        field: effectiveRef,
        fix_name: 'no_expected_value',
        result: 'no_effect',
        success: false,
      };
    }

    // ── 2. Resolve to a Playwright Locator ────────────────────────
    let locator;
    try {
      locator = await resolveFieldLocator(page, effectiveRef, errorRecord);
    } catch (err) {
      return {
        field: effectiveRef,
        fix_name: 'locator_resolve_threw',
        result: 'no_effect',
        success: false,
        error_msg: String(err?.message ?? err).slice(0, 200),
      };
    }
    if (!locator) {
      return {
        field: effectiveRef,
        fix_name: 'field_not_found_on_page',
        result: 'no_effect',
        success: false,
      };
    }

    // ── 3. Call fillWithFallback ──────────────────────────────────
    let result;
    try {
      result = await fillWithFallback(page, locator, String(expected));
    } catch (err) {
      // [review H4] Phase 2/m4 hard-rethrows SnapshotError for
      // ELEMENT_GONE / STALE_REF / IFRAME_DETACHED — the loop MUST
      // re-snapshot before any more attempts. Rather than swallowing
      // into a fix record (which lets submitLoop burn the next 2
      // attempts on the same dead element), RE-THROW so submitLoop's
      // catch chain at line 344 routes to 'fixer_threw' with the
      // SnapshotError detail — same-error-twice guard then halts
      // immediately on the next round.
      if (err instanceof SnapshotError) {
        // Tag so submitLoop's catch can recognize the propagation
        // without importing the class.
        err.fromFixField = true;
        throw err;
      }
      return {
        field: effectiveRef,
        fix_name: 'fillWithFallback_threw',
        result: 'no_effect',
        success: false,
        error_msg: String(err?.message ?? err).slice(0, 200),
      };
    }

    // ── 4. Translate nested shape → flat m6 shape ─────────────────
    const success = result.final.success === true;
    // [review L1] When the ladder is exhausted without success, both
    // fix_name AND result use the 'all_strategies_failed' sentinel so
    // the m6 allStrategiesFailed guard (per guards/allStrategiesFailed.mjs)
    // and Phase 5/m5 flywheel bucket on the same string.
    const fix_name = success
      ? result.final.strategy
      : (result.final.strategy ?? 'all_strategies_failed');
    const flat_result = success
      ? 'verified'
      : (result.strategies_tried[result.strategies_tried.length - 1]?.result ?? 'all_strategies_failed');

    return {
      field: effectiveRef,
      fix_name,
      result: flat_result,
      success,
      // Phase 5/m5 flywheel signal A — preserve the full ladder so
      // it can rank strategies per fingerprint_class once the
      // FixTriedSchema accepts this field.
      strategies_tried: result.strategies_tried,
      last_value: result.final.last_value ?? null,
    };
  };
}

/** Look up the expected value for a field given the session.
 *
 *  [review H3] Precedence (highest first):
 *    1. session.field_memory[refId] — captures POST-approveStep edits,
 *       canonical for retry. If the operator changed "5550100" to
 *       "+1 555 0100", field_memory has the new value first.
 *    2. session.field_memory[errorRecord.field] — same with the form's
 *       internal field name fallback.
 *    3. session.per_step_draft fields[refId].suggested_value — original
 *       classifier-decided value when memory has no override.
 *
 *  [review H2] errorRecord.expected_value branch removed — FormErrorSchema
 *  is .strict() so no parser can ever supply this field, and the same
 *  record is persisted later via appendSubmitAttempt's strict Zod parse
 *  (extra keys would throw). Phase 6+ field augmentation belongs on a
 *  separate channel, not by piggybacking the FormError record. */
function lookupExpectedValue(session, fieldRef, errorRecord) {
  if (!session || typeof session !== 'object') return null;

  // 1+2. field_memory holds operator edits — canonical for retry.
  if (session.field_memory && typeof session.field_memory === 'object') {
    const memValue = session.field_memory[fieldRef];
    if (typeof memValue === 'string' && memValue !== '') return memValue;
    if (errorRecord?.field && errorRecord.field !== fieldRef) {
      const altValue = session.field_memory[errorRecord.field];
      if (typeof altValue === 'string' && altValue !== '') return altValue;
    }
  }

  // 3. per_step_draft suggested_value — fallback when memory is empty.
  const drafts = session.per_step_draft || {};
  for (const entry of Object.values(drafts)) {
    const fields = entry?.fields;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      if (!f) continue;
      if (f.refId === fieldRef) {
        return f.suggested_value ?? null;
      }
    }
  }
  return null;
}

/** Resolve the form field to a Locator. Best-effort: tries the
 *  refId then errorRecord.field across several attribute selectors.
 *  Exported [m13] so focusField/retryField endpoint live wiring can
 *  reuse the same waterfall without duplicating Workday/Greenhouse
 *  selector knowledge.
 *  [review H1] data-automation-id added for Workday compatibility —
 *  was the dominant cause of "field_not_found_on_page" on Workday
 *  forms before this fix.
 *  [review M1] redundant `#id` selector dropped — `[id=]` handles
 *  the same case without escaping pitfalls (leading-digit ids etc.). */
export async function resolveFieldLocator(page, fieldRef, errorRecord) {
  const candidates = [fieldRef];
  // errorRecord may be null (operator-driven focus/retry has no error
  // context). Skip the second candidate when missing.
  if (errorRecord?.field && errorRecord.field !== fieldRef) {
    candidates.push(errorRecord.field);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const safe = escapeForAttr(candidate);
    const attempts = [
      `[name="${safe}"]`,
      `[id="${safe}"]`,
      `[data-automation-id="${safe}"]`,  // Workday
      `[data-qa="${safe}"]`,              // Greenhouse / Lever
      `[aria-label="${safe}"]`,
    ];
    for (const sel of attempts) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) return page.locator(sel).first();
      } catch { /* invalid selector — skip */ }
    }
    // Last-resort: getByLabel — handles cases where the form's "field"
    // identifier is actually the label text.
    try {
      const loc = page.getByLabel(candidate, { exact: false });
      const count = await loc.count();
      if (count > 0) return loc.first();
    } catch { /* */ }
  }
  return null;
}

/** Escape a string for use inside a quoted attribute selector value. */
function escapeForAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
