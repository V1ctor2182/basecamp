// Selection control variants — RADIO_DIV / MULTI_SELECT_CHIP /
// CUSTOM_COMBOBOX / SEARCH_SELECT.
//
// 07-applier/05-non-standard-controls m3.
//
// These are ATS-specific variants of the standard selection controls
// that m1 already covers natively (radio_native, checkbox, select_native).
// Each variant differs from its native counterpart in DOM shape and
// interaction protocol:
//
//   radio_div         — div[role=radio] (NOT <input>). Click works as on
//                       native radio; HIGH after the same suggested-value
//                       vs. locator-name guard m1 applies to radio_native.
//   multi_select_chip — combobox with multiple selectable chips/tags.
//                       Value is an array OR pipe/comma-separated string.
//                       Per-value: click to expand → fill/search → click option.
//   custom_combobox   — combobox with role=listbox popup (NOT native <select>).
//                       Click expand → getByRole(option, name) → click.
//                       Fallback: arrow-key + Enter when option locator times out.
//   search_select     — combobox with aria-autocomplete=list. Type to filter
//                       → wait listbox → click first match. Partial fill
//                       (no match) routes to LOW so the user verifies.
//
// All strategies operate on the locator DIRECTLY (OQ1 raw bypass) and
// route to MANUAL on any thrown DOM error rather than propagating.

import { ControlType, Confidence, registerStrategy, registerDetectionRule } from '../controlRouter.mjs';

const OPTION_TIMEOUT_MS = 2000;

const _MANUAL = (suggested, error) => ({
  filled: false,
  confidence: Confidence.MANUAL,
  manual: true,
  suggestedValue: suggested,
  error,
});

const _LOW_PARTIAL = (suggested, error) => ({
  // Partial fill: text typed but no option selected. Like m2's address
  // partial-fill case — LOW so nonstandardFillField sets block_approve.
  filled: true,
  confidence: Confidence.LOW,
  manual: false,
  suggestedValue: suggested,
  error,
});

// ─── radio_div ────────────────────────────────────────────────────────

/**
 * Click on a div[role=radio]. Same defensive name-match check as
 * m1's fillRadioNative: if classifier emitted a suggested_value that
 * disagrees with the locator's accessible name, refuse to click
 * (avoids bot-detection from "wrong answer auto-clicked").
 */
async function fillRadioDiv(_page, locator, classifiedField, value) {
  const sv = value == null ? '' : String(value).trim().toLowerCase();
  const ln = classifiedField?.label == null
    ? ''
    : String(classifiedField.label).trim().toLowerCase();
  if (sv && ln && sv !== ln) {
    return _MANUAL(
      classifiedField?.suggested_value ?? null,
      `radio_div: suggested_value (${sv}) does not match option label (${ln})`,
    );
  }
  try {
    await locator.click();
    return { filled: true, confidence: Confidence.HIGH, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `radio_div: ${err?.message ?? err}`);
  }
}

// ─── multi_select_chip ────────────────────────────────────────────────

/**
 * Parse a multi-value into an array. Accepts:
 *   - Array<string>: returned as-is (filtered to non-empty strings)
 *   - 'a|b|c' (pipe)
 *   - 'a, b, c' (comma)
 *   - single string → [string]
 * Empty input returns empty array.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseMultiValue(value) {
  let parts;
  if (value == null) {
    parts = [];
  } else if (Array.isArray(value)) {
    parts = value.map((v) => (v == null ? '' : String(v).trim()));
  } else {
    const s = String(value).trim();
    if (!s) {
      parts = [];
    } else if (s.includes('|')) {
      // Pipe takes precedence over comma since classifier may emit
      // 'Java, JS' as a single skill rather than two ('Java' and 'JS').
      parts = s.split('|').map((v) => v.trim());
    } else if (s.includes(',')) {
      parts = s.split(',').map((v) => v.trim());
    } else {
      parts = [s];
    }
  }
  // Filter empties + punctuation-only artifacts (e.g. ',|,' → ['',',',''] → drop).
  parts = parts.filter((p) => p && !/^[\s,;|]+$/.test(p));
  // Review fix (adversarial #5): case-insensitive dedupe. Some ATS
  // chip libraries don't reject duplicates internally; submitting
  // "Java, Java, JS" can trip bot-detection or silently swallow the
  // dup. Keep the FIRST occurrence (preserves user-intended ordering).
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function fillMultiSelectChip(page, locator, classifiedField, value) {
  const values = parseMultiValue(value);
  if (values.length === 0) {
    return _MANUAL(value, 'multi_select_chip: empty value list');
  }
  try {
    // Open the chip-picker once.
    await locator.click();
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      // Review fix (CRITICAL C1 / adversarial #4): explicit clear then
      // fill between iterations. Without the clear, residual typed
      // text from the prior iteration causes some libraries (react-
      // select, headlessui) to skip the input event when fill()
      // sees the same value, leaving the listbox filtered on stale
      // text. The result: option-by-name lookup times out on chip #2+
      // → MANUAL → application aborts mid-list with chip #1 already
      // added and chips #2/#3 missing.
      try {
        await locator.fill('');
        await locator.fill(v);
      } catch {
        // Some chip pickers use a sibling input. Fall back to
        // keyboard typing on the focused element.
        await locator.focus();
        await page.keyboard.type(v);
      }
      // Review fix (CRITICAL adversarial #1): exact name match.
      // Playwright's getByRole({name}) defaults to substring-after-
      // whitespace-normalize — "Java" would silently match
      // "JavaScript" or "Java EE". exact:true requires equality.
      // Also wait for the option to be visible BEFORE clicking; this
      // guarantees the listbox has re-rendered post-fill (race fix).
      const option = page.getByRole('option', { name: v, exact: true });
      await option.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS });
      await option.first().click({ timeout: OPTION_TIMEOUT_MS });
    }
    // Close the listbox via Escape — locator-scoped so focus is on
    // the input not the document body.
    try {
      await locator.press('Escape');
    } catch {
      // Some pickers don't accept Escape on the input; close by
      // clicking outside is the caller's responsibility.
    }
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `multi_select_chip: ${err?.message ?? err}`);
  }
}

// ─── custom_combobox ──────────────────────────────────────────────────

async function fillCustomCombobox(page, locator, _field, value) {
  if (value == null || value === '') {
    return _MANUAL(value, 'custom_combobox: empty value');
  }
  const target = String(value).trim();
  try {
    await locator.click();
    // Review fix (CRITICAL adversarial #1): exact name match. Without
    // exact:true, "Senior" matches "Senior Engineer" AND "Senior
    // Manager" — `.first()` then silently picks DOM order winner.
    const option = page.getByRole('option', { name: target, exact: true });
    try {
      await option.first().click({ timeout: OPTION_TIMEOUT_MS });
      return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
    } catch {
      // Review fix (HIGH H2): gate the arrow-key fallback behind a
      // visible-listbox check. On a closed/empty listbox, Enter can
      // SUBMIT THE FORM on some ATSs (Workday, Greenhouse) — a
      // catastrophic side effect. We require a real listbox to exist
      // before sending keys.
      try {
        const listbox = page.getByRole('listbox').first();
        await listbox.waitFor({ state: 'visible', timeout: 500 });
        await locator.press('ArrowDown');
        await locator.press('Enter');
        return _LOW_PARTIAL(
          value,
          'custom_combobox: option not found by name — arrow-key fallback used',
        );
      } catch (fallbackErr) {
        return _MANUAL(
          value,
          `custom_combobox: option not found and no visible listbox for fallback (${fallbackErr?.message ?? fallbackErr})`,
        );
      }
    }
  } catch (err) {
    return _MANUAL(value, `custom_combobox: ${err?.message ?? err}`);
  }
}

// ─── search_select ────────────────────────────────────────────────────

async function fillSearchSelect(page, locator, _field, value) {
  if (value == null || value === '') {
    return _MANUAL(value, 'search_select: empty value');
  }
  const target = String(value).trim();
  try {
    await locator.fill(target);
    // Review fix (CRITICAL adversarial #2): prefer exact-name match
    // before falling back to .first(). The old version silently
    // picked the topmost option for ambiguous strings — "Mountain"
    // returns ["Mountain View, CA", "Mountain Brook, AL"] and
    // `.first()` clicks the wrong one based on DOM order. Now:
    //   1. Try exact name match → MEDIUM
    //   2. Try prefix match (option starts with target, case-insensitive)
    //      with EXACTLY ONE visible option → MEDIUM
    //   3. Otherwise → LOW (raw text typed, user must verify)
    try {
      const exact = page.getByRole('option', { name: target, exact: true });
      await exact.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS });
      await exact.first().click();
      return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
    } catch {
      // No exact match — try unanchored, but only auto-click when
      // exactly one option is visible. Anything else is ambiguous
      // and must route to LOW so the user verifies the picked city.
      try {
        const anyOpt = page.getByRole('option');
        const count = await anyOpt.count();
        if (count === 1) {
          // Verify the single option's text aligns with the target
          // before committing. We don't fail-hard if textContent isn't
          // mockable — fall back to LOW in that case.
          let optionText = '';
          try {
            optionText = (await anyOpt.first().textContent()) || '';
          } catch {
            optionText = '';
          }
          if (
            optionText &&
            optionText.toLowerCase().trim().startsWith(target.toLowerCase())
          ) {
            await anyOpt.first().click();
            return {
              filled: true,
              confidence: Confidence.MEDIUM,
              manual: false,
              suggestedValue: null,
            };
          }
        }
        return _LOW_PARTIAL(
          value,
          `search_select: ${count} options visible — no unambiguous match for ${JSON.stringify(target)}`,
        );
      } catch (timeoutErr) {
        return _LOW_PARTIAL(
          value,
          `search_select: option listbox timeout (${timeoutErr?.message ?? 'timeout'})`,
        );
      }
    }
  } catch (err) {
    return _MANUAL(value, `search_select: ${err?.message ?? err}`);
  }
}

// ─── Detection rule ───────────────────────────────────────────────────

// Token-aware class match. Review fix (HIGH from m3 review): chip/tag/
// pill use STRICT equality only — `startsWith('chip-')` previously
// false-positive on `chip-icon` (a common MUI styling token). Reserve
// startsWith for `multiselect`/`multi-select` where the prefix variant
// is meaningful (e.g. `multiselect-input`, `multi-select-trigger`).
function _hasExactClassToken(info, needle) {
  if (!info || typeof info.className !== 'string') return false;
  const target = needle.toLowerCase();
  const tokens = info.className.toLowerCase().split(/\s+/);
  return tokens.includes(target);
}

function _hasClassPrefix(info, needle) {
  if (!info || typeof info.className !== 'string') return false;
  const target = needle.toLowerCase();
  const tokens = info.className.toLowerCase().split(/\s+/);
  return tokens.some((t) => t === target || t.startsWith(`${target}-`) || t.startsWith(`${target}_`));
}

const CHIP_EXACT_TOKENS = ['chip', 'chips', 'tag', 'tags', 'pill', 'pills'];
const CHIP_PREFIX_TOKENS = ['multiselect', 'multi-select'];

function _looksLikeChipControl(info) {
  return (
    CHIP_EXACT_TOKENS.some((t) => _hasExactClassToken(info, t)) ||
    CHIP_PREFIX_TOKENS.some((t) => _hasClassPrefix(info, t))
  );
}

function selectionDetectionRule(entry, info, _classifiedField) {
  if (!info) return null;
  // RADIO_DIV: ARIA radio that isn't a real <input>. Native radios are
  // m1's RADIO_NATIVE — this rule supersedes only when the underlying
  // element is e.g. <div role=radio>.
  if (entry?.role === 'radio' && info.tagName !== 'INPUT') {
    return ControlType.RADIO_DIV;
  }
  if (entry?.role === 'combobox') {
    // MULTI_SELECT_CHIP via aria-multiselectable OR class hint.
    if (info?.attrs?.['aria-multiselectable'] === 'true') {
      return ControlType.MULTI_SELECT_CHIP;
    }
    if (_looksLikeChipControl(info)) {
      return ControlType.MULTI_SELECT_CHIP;
    }
    // SEARCH_SELECT via aria-autocomplete=list (typed filter).
    if (info?.attrs?.['aria-autocomplete'] === 'list' || info?.attrs?.['aria-autocomplete'] === 'both') {
      return ControlType.SEARCH_SELECT;
    }
    // CUSTOM_COMBOBOX: ARIA combobox with listbox popup but NOT a
    // native <select>.
    if (info.tagName !== 'SELECT' && info?.attrs?.['aria-haspopup'] === 'listbox') {
      return ControlType.CUSTOM_COMBOBOX;
    }
    // Review fix (CRITICAL C2): any non-native combobox falls through
    // to CUSTOM_COMBOBOX here. Without this fallback, role=combobox
    // on a <div> with no aria-haspopup attribute routes via m1's
    // ARIA-only mapping to SELECT_NATIVE → selectOption() on a
    // non-<select> → throws → entire field aborts. CUSTOM_COMBOBOX's
    // click-to-expand pattern is the safer default.
    if (info.tagName !== 'SELECT') {
      return ControlType.CUSTOM_COMBOBOX;
    }
  }
  return null;
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerSelectionStrategies() {
  registerStrategy(ControlType.RADIO_DIV, { fill: fillRadioDiv });
  registerStrategy(ControlType.MULTI_SELECT_CHIP, { fill: fillMultiSelectChip });
  registerStrategy(ControlType.CUSTOM_COMBOBOX, { fill: fillCustomCombobox });
  registerStrategy(ControlType.SEARCH_SELECT, { fill: fillSearchSelect });
  registerDetectionRule(selectionDetectionRule);
}

registerSelectionStrategies();

export const _testing = {
  fillRadioDiv,
  fillMultiSelectChip,
  fillCustomCombobox,
  fillSearchSelect,
  selectionDetectionRule,
  parseMultiValue,
};
