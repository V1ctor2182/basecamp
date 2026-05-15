// nonstandardFillField — production _fillField for machine.mjs FILL step.
//
// 07-applier/05-non-standard-controls m1.
//
// Replaces the PROVISIONAL `defaultFillField` in
// 04-multi-step-state-machine/machine.mjs. Routes every refId through:
//
//   table.resolve()        ← one-shot (OQ1: raw locator bypass for the
//                            strategy; downstream actions never re-resolve
//                            through the table within this strategy)
//   detectControlType()    ← ARIA + optional sniff (controlRouter.mjs)
//   getStrategy(type).fill ← per-type strategy
//
// Contract with machine.mjs's FILL loop (machine.mjs:355-365):
//   • THROWS on real fill failures → machine catches, sets
//     classifiedField.fill_error, increments errors counter.
//   • DOES NOT throw on MANUAL / LOW confidence → mutates classifiedField
//     to signal UI and returns; machine counts the field as "filled" but
//     fieldMemory.recordToMemory no-ops (since we clear suggested_value
//     on MANUAL — null short-circuits recordToMemory per fieldMemory.mjs:84).
//
// classifiedField mutations:
//   • confidence            — set from FillResult.confidence
//   • manual_required: true — set on MANUAL path
//   • manual_reason         — short string from FillResult.error / fallback
//   • suggested_value_manual — preserves original value for UI Copy-to-
//                             Clipboard (since suggested_value is nulled)
//   • suggested_value: null — cleared on MANUAL to suppress memory write
//   • block_approve: true   — set when confidence === 'low' (constraint #2:
//                             UI must NOT bulk-approve low-confidence fields)
//
// Standard control strategies (m1, registered at module load):
//   TEXTBOX        → locator.fill(value)        HIGH
//   SELECT_NATIVE  → locator.selectOption(value) HIGH
//   CHECKBOX       → check / uncheck per truthy  HIGH
//   RADIO_NATIVE   → locator.click()             HIGH (value implied by name)
//   FILE           → locator.setInputFiles(path) HIGH
//
// m2/m3/m4 register their strategies into the same registry without
// touching this file.

import {
  ControlType,
  Confidence,
  registerStrategy,
  getStrategy,
  detectControlType,
} from './controlRouter.mjs';
import { highlightManual } from './manualHighlight.mjs';

/**
 * The _fillField implementation injected into machine.mjs at startup.
 * Signature is exactly `(page, refId, classifiedField, table) → Promise<void>`
 * to match the FILL-loop call site.
 *
 * @param {object} page — Playwright Page
 * @param {string} refId
 * @param {object} classifiedField — output of 03-field-classifier, mutated
 *   in place to surface confidence / manual flags to the persisted draft
 * @param {object} table — RefTable from 08-snapshot-refs-layer
 * @returns {Promise<void>}
 */
export async function nonstandardFillField(page, refId, classifiedField, table) {
  // OQ1 — resolve locator ONCE. Strategy operates on this directly. If
  // resolve throws (UNKNOWN_REF / STALE_REF / WRONG_PAGE / IFRAME_DETACHED),
  // propagate so machine.mjs catches and records fill_error normally.
  const locator = table.resolve(refId, page);

  const type = await detectControlType(page, refId, table, classifiedField);
  const strategy = getStrategy(type);
  const value = classifiedField?.suggested_value;

  if (!strategy) {
    // No strategy registered for this ControlType (e.g. m1 sees a date
    // picker before m2 ships) → MANUAL path. NEVER throw here; machine
    // continues with subsequent fields.
    await _markAndHighlightManual(
      page,
      locator,
      classifiedField,
      `No strategy registered for ${type}`,
    );
    return;
  }

  // Strategy errors propagate. Common cases:
  //   • locator.fill / selectOption / check timeouts → machine catches +
  //     fill_error.
  //   • Strategy chose to throw a domain error (e.g. CAPTCHA strategy
  //     deciding to hard-abort) → same path.
  // Strategies that want graceful degradation must return MANUAL via
  // FillResult instead of throwing.
  const result = await strategy.fill(page, locator, classifiedField, value);

  if (!result || typeof result !== 'object') {
    // Defensive: malformed strategy contract → treat as MANUAL so the
    // user takes over rather than counting a phantom success.
    await _markAndHighlightManual(
      page,
      locator,
      classifiedField,
      `Strategy ${type} returned malformed result`,
    );
    return;
  }

  if (result.manual || result.confidence === Confidence.MANUAL) {
    await _markAndHighlightManual(
      page,
      locator,
      classifiedField,
      result.error || `Strategy ${type} returned MANUAL`,
    );
    return;
  }

  // H1 fix from review: `filled:false` paired with non-MANUAL confidence
  // is a contract violation — the strategy claims success without having
  // mutated DOM. Per constraint #1, defaultMANUAL rather than counting
  // a phantom write.
  if (result.filled === false) {
    await _markAndHighlightManual(
      page,
      locator,
      classifiedField,
      result.error || `Strategy ${type} returned filled:false without MANUAL`,
    );
    return;
  }

  // M2 fix from review: unknown confidence value (typo, drift, or a
  // strategy speaking a future enum) MUST NOT silently downgrade to
  // MEDIUM-and-count-as-success. Treat as MANUAL — same rationale as
  // constraint #1 (never persist data we can't characterize).
  const conf = result.confidence;
  if (conf !== Confidence.HIGH && conf !== Confidence.MEDIUM && conf !== Confidence.LOW) {
    await _markAndHighlightManual(
      page,
      locator,
      classifiedField,
      `Strategy ${type} returned unknown confidence=${JSON.stringify(conf)}`,
    );
    return;
  }
  classifiedField.confidence = conf;

  // C1 fix from review (CRITICAL): LOW confidence laundering. The FILL
  // loop calls `recordToMemory(memory, f, f.suggested_value)` AFTER our
  // return; if we leave suggested_value intact for a LOW-confidence
  // strategy, that value is persisted to field_memory — and on the
  // next step, `applyMemoryHit` (fieldMemory.mjs:101-105) promotes ALL
  // memory hits to confidence='high'. A LOW guess gets laundered into
  // HIGH on subsequent steps, silently defeating the bulk-approve gate.
  //
  // Mirror MANUAL's pattern: null suggested_value (memory short-circuits
  // per fieldMemory.mjs:84) while preserving the value for UI under a
  // distinct key so per-field review can still show what was filled.
  //
  // Constraint #2: low-confidence fields MUST block bulk approve. The
  // dashboard (08-human-gate-tracker) reads block_approve to disable
  // "Approve All" while honoring per-field accept.
  if (classifiedField.confidence === Confidence.LOW) {
    classifiedField.block_approve = true;
    if (classifiedField.suggested_value != null && classifiedField.suggested_value !== '') {
      classifiedField.suggested_value_filled = String(classifiedField.suggested_value);
      classifiedField.suggested_value = null;
    }
  }
}

function _markManual(classifiedField, reason) {
  if (!classifiedField || typeof classifiedField !== 'object') return;
  classifiedField.manual_required = true;
  classifiedField.confidence = Confidence.MANUAL;
  // Preserve original value for the dashboard so the user sees what to
  // type. nulling suggested_value suppresses fieldMemory.recordToMemory
  // (fieldMemory.mjs:84 — null/empty value is no-op).
  if (
    classifiedField.suggested_value != null &&
    classifiedField.suggested_value !== ''
  ) {
    classifiedField.suggested_value_manual = String(classifiedField.suggested_value);
    classifiedField.suggested_value = null;
  }
  if (reason) {
    classifiedField.manual_reason = String(reason).slice(0, 200);
  }
}

/**
 * Mark the field manual AND inject the red-outline highlight in the
 * browser via manualHighlight.mjs. Highlight is best-effort — its
 * failure cannot block the machine.
 */
async function _markAndHighlightManual(page, locator, classifiedField, reason) {
  _markManual(classifiedField, reason);
  // Use the manual hint (preserved by _markManual) as the
  // Copy-to-Clipboard payload for the dashboard.
  const hint = classifiedField?.suggested_value_manual ?? null;
  try {
    await highlightManual(page, locator, hint);
  } catch {
    // Highlight is a UX nicety — never let it block the FILL loop.
  }
}

// ─── Standard control strategies (m1) ───────────────────────────────────

const HIGH_FILLED = Object.freeze({
  filled: true,
  confidence: Confidence.HIGH,
  manual: false,
  suggestedValue: null,
});

async function fillTextbox(_page, locator, _field, value) {
  await locator.fill(String(value ?? ''));
  return HIGH_FILLED;
}

async function fillSelectNative(_page, locator, _field, value) {
  await locator.selectOption(String(value ?? ''));
  return HIGH_FILLED;
}

async function fillCheckbox(_page, locator, classifiedField, value) {
  // H4 fix from review: explicit truthy + explicit falsy sets. Ambiguous
  // strings ('maybe', 'sometimes', 'idk') previously fell through to
  // uncheck via _isTruthy returning false — silently wrong for legal /
  // EEO questions where the right action is to defer to the user.
  const polarity = _checkboxPolarity(value);
  if (polarity === 'check') {
    await locator.check();
    return HIGH_FILLED;
  }
  if (polarity === 'uncheck') {
    await locator.uncheck();
    return HIGH_FILLED;
  }
  // Ambiguous — defer to user.
  return {
    filled: false,
    confidence: Confidence.MANUAL,
    manual: true,
    suggestedValue: classifiedField?.suggested_value ?? null,
    error: `checkbox: ambiguous value ${JSON.stringify(value)}`,
  };
}

async function fillRadioNative(_page, locator, classifiedField, value) {
  // H3 fix from review: the locator was minted with a specific
  // accessible name (the option label), so clicking it picks THAT
  // option regardless of suggested_value. If classifier's suggested
  // value doesn't match the locator's name, silently clicking is a
  // bot-detection risk. Defense in depth: require name match before
  // clicking; otherwise defer to user.
  //
  // We pull the locator's target name from classifiedField.label which
  // mirrors what RefTable minted the ref with (machine.mjs's classify
  // pipeline sets label = entry.name). When classifier picked the right
  // refId, suggested_value === label modulo case/whitespace. When it
  // didn't, the strings diverge and we route to MANUAL.
  const sv = value == null ? '' : String(value).trim().toLowerCase();
  const ln = classifiedField?.label == null ? '' : String(classifiedField.label).trim().toLowerCase();
  if (sv && ln && sv !== ln) {
    return {
      filled: false,
      confidence: Confidence.MANUAL,
      manual: true,
      suggestedValue: classifiedField?.suggested_value ?? null,
      error: `radio: suggested_value (${sv}) does not match option label (${ln})`,
    };
  }
  await locator.click();
  return HIGH_FILLED;
}

async function fillFile(_page, locator, _field, value) {
  if (value == null || value === '') {
    // File-class field reached us with no path — machine's pre-check
    // (suggested_value empty → skip) should have caught this; surface
    // as MANUAL just in case.
    return {
      filled: false,
      confidence: Confidence.MANUAL,
      manual: true,
      suggestedValue: null,
      error: 'file strategy: empty path',
    };
  }
  await locator.setInputFiles(String(value));
  return HIGH_FILLED;
}

// H4 fix from review: explicit truthy + falsy sets. Returns 'check' /
// 'uncheck' / 'ambiguous' so callers can route ambiguous values to MANUAL
// rather than silently picking the false branch. L4 fix: NaN is not 0
// in JavaScript (`NaN !== 0 === true`), which used to coerce as truthy.
const _CHECKBOX_TRUTHY = new Set(['yes', 'true', 'y', '1', 'on', 'checked', 'agree', 'accept']);
const _CHECKBOX_FALSY = new Set(['no', 'false', 'n', '0', 'off', 'unchecked', 'disagree', 'decline']);

function _checkboxPolarity(value) {
  if (typeof value === 'boolean') return value ? 'check' : 'uncheck';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'ambiguous';
    return value !== 0 ? 'check' : 'uncheck';
  }
  if (typeof value !== 'string') return 'ambiguous';
  const v = value.trim().toLowerCase();
  if (!v) return 'ambiguous';
  if (_CHECKBOX_TRUTHY.has(v)) return 'check';
  if (_CHECKBOX_FALSY.has(v)) return 'uncheck';
  return 'ambiguous';
}

// Register at module load. Smoke tests that exercise the registry call
// `registerStandardStrategies()` after `_resetRegistryForTesting()` to
// restore the m1 baseline.
export function registerStandardStrategies() {
  registerStrategy(ControlType.TEXTBOX, { fill: fillTextbox });
  registerStrategy(ControlType.SELECT_NATIVE, { fill: fillSelectNative });
  registerStrategy(ControlType.CHECKBOX, { fill: fillCheckbox });
  registerStrategy(ControlType.RADIO_NATIVE, { fill: fillRadioNative });
  registerStrategy(ControlType.FILE, { fill: fillFile });
}

registerStandardStrategies();
