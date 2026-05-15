// Date picker strategies — 5 variants + UNKNOWN_CALENDAR (MANUAL).
//
// 07-applier/05-non-standard-controls m2.
//
// Strategy contract (controlRouter.mjs FillResult shape):
//   (page, locator, classifiedField, value) → { filled, confidence, manual,
//   suggestedValue, error? }
//
// All strategies operate on the locator DIRECTLY (OQ1 raw locator bypass).
// They do NOT call actions.mjs verbs — that would re-resolve through
// RefTable and bump generation, breaking sibling-field fills in the same
// snapshot. Strategies that do multi-step DOM work (click + type +
// Escape) use page.keyboard / page.locator() / locator.evaluate directly.
//
// Date string parsing:
//   - ISO 'YYYY-MM-DD' (preferred)
//   - US 'MM/DD/YYYY' or 'M/D/YYYY'
//   - Long form 'Month DD, YYYY' / 'Mon DD YYYY'
//   - Ambiguous '01/02/2024' → assumed US convention (Jan 2)
//   - Anything else → null → strategy returns MANUAL
//
// The strategies are designed to fail gracefully: any parse failure or
// DOM timing issue routes the field to MANUAL with a useful error
// message instead of throwing (which would set fill_error and lose the
// user's chance to fix it).

import { ControlType, Confidence, registerStrategy, registerDetectionRule } from '../controlRouter.mjs';

// ─── Date value parsing ───────────────────────────────────────────────

const _MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Parse a free-form date string into ISO 'YYYY-MM-DD'. Returns null on
 * any failure — strategies use this to decide between trying a fill and
 * returning MANUAL.
 *
 * Supported inputs:
 *   - '2024-06-15' (ISO)
 *   - '06/15/2024' / '6/15/2024' (US, MM/DD/YYYY)
 *   - 'June 15, 2024' / 'Jun 15 2024'
 *   - Numbers or Date instances also tolerated
 *
 * @param {string|number|Date} value
 * @returns {string|null} 'YYYY-MM-DD' or null
 */
export function toISO(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return _formatISO(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const s = String(value).trim();
  if (!s) return null;

  // ISO YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (_validYMD(y, m, d)) return _formatISO(y, m, d);
  }

  // US MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const m = +us[1], d = +us[2], y = +us[3];
    if (_validYMD(y, m, d)) return _formatISO(y, m, d);
  }

  // Long form: "June 15, 2024" / "Jun 15 2024" / "15 June 2024"
  const tokens = s.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const monthFromName = (t) => _MONTH_NAMES[t.toLowerCase()];
    // Try "Month Day Year"
    let m = monthFromName(tokens[0]);
    if (m) {
      const d = +tokens[1], y = +tokens[2];
      if (_validYMD(y, m, d)) return _formatISO(y, m, d);
    }
    // Try "Day Month Year"
    m = monthFromName(tokens[1]);
    if (m) {
      const d = +tokens[0], y = +tokens[2];
      if (_validYMD(y, m, d)) return _formatISO(y, m, d);
    }
  }

  return null;
}

function _validYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function _formatISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function _formatMDY(iso) {
  // 'YYYY-MM-DD' → 'MM/DD/YYYY'
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// ─── Strategies ───────────────────────────────────────────────────────

const _MANUAL = (suggested, error) => ({
  filled: false,
  confidence: Confidence.MANUAL,
  manual: true,
  suggestedValue: suggested,
  error,
});

/** HTML5 <input type=date> — accepts ISO natively. HIGH confidence. */
async function fillHtml5Date(_page, locator, _field, value) {
  const iso = toISO(value);
  if (!iso) return _MANUAL(value, 'html5_date: could not parse value to ISO');
  await locator.fill(iso);
  return { filled: true, confidence: Confidence.HIGH, manual: false, suggestedValue: null };
}

/**
 * React DatePicker (npm react-datepicker, .react-datepicker__input class).
 * Pattern: click to open → clear → type MM/DD/YYYY → Escape.
 * MEDIUM because the popup may reject malformed types.
 */
async function fillReactDatepicker(page, locator, _field, value) {
  const iso = toISO(value);
  if (!iso) return _MANUAL(value, 'react_datepicker: could not parse value');
  try {
    await locator.click();
    await locator.fill('');
    // Review fix (B1): explicit refocus prevents page.keyboard.type
    // from leaking to the wrong element when react-datepicker's
    // close-on-outside-click reacts to fill('') by closing + blurring.
    // press('Escape') is locator-scoped (auto-focuses target first).
    await locator.focus();
    await page.keyboard.type(_formatMDY(iso));
    await locator.press('Escape');
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `react_datepicker: ${err?.message ?? err}`);
  }
}

/**
 * MUI X DatePicker. Exposes 3 spinbutton segments (month/day/year). Fill
 * each by name; fall back to plain type pattern if segments not found.
 */
async function fillMuiDatepicker(page, locator, _field, value) {
  const iso = toISO(value);
  if (!iso) return _MANUAL(value, 'mui_datepicker: could not parse value');
  const [y, m, d] = iso.split('-');
  try {
    // Try segmented spinbuttons first
    const segments = locator.locator('[role=spinbutton]');
    const count = await segments.count();
    if (count >= 3) {
      // MUI segment order: MM DD YYYY
      await segments.nth(0).fill(m);
      await segments.nth(1).fill(d);
      await segments.nth(2).fill(y);
      return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
    }
    // Review fix (M4): with count===0 the locator might point at a
    // misrouted control entirely. Don't blindly click+type a date
    // string into whatever the locator is — fall to MANUAL.
    if (count === 0) {
      return _MANUAL(value, 'mui_datepicker: no spinbutton segments found — refusing blind fallback');
    }
    // Fallback: click + type pattern (partial segments — 1 or 2). This
    // is a best-effort recovery for buggy implementations. We focus
    // explicitly so page.keyboard.type doesn't leak to the wrong
    // element (review fix B1).
    await locator.click();
    await locator.fill('');
    await locator.focus();
    await page.keyboard.type(_formatMDY(iso));
    await locator.press('Escape');
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `mui_datepicker: ${err?.message ?? err}`);
  }
}

/**
 * Flatpickr — hides the original input; set value + dispatch change event
 * directly via page.evaluate. Known limitation: altInput configurations
 * may not reflect the change. MEDIUM confidence.
 */
async function fillFlatpickr(_page, locator, _field, value) {
  const iso = toISO(value);
  if (!iso) return _MANUAL(value, 'flatpickr: could not parse value');
  try {
    // Review fix (B8/H3): flatpickr stores state on an instance bound
    // to the element as `el._flatpickr`. Setting `el.value` directly
    // doesn't update the instance — the next reflow can overwrite it
    // and altInput configurations point the visible input at a sibling
    // entirely. Prefer `instance.setDate(val, true)` which fires the
    // proper onChange callback chain; fall back to native dispatch
    // when the instance can't be found (e.g. a different library
    // that shares the class name).
    await locator.evaluate((el, val) => {
      const candidates = [
        el._flatpickr,
        el.parentElement && el.parentElement.querySelector
          ? el.parentElement.querySelector('.flatpickr-input')?._flatpickr
          : null,
        el.nextElementSibling && el.nextElementSibling._flatpickr,
      ].filter(Boolean);
      const fp = candidates[0];
      if (fp && typeof fp.setDate === 'function') {
        fp.setDate(val, true);
        return;
      }
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, iso);
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `flatpickr: ${err?.message ?? err}`);
  }
}

/**
 * Split month/day/year selects — locator is the CONTAINER. Resolve 3
 * child <select> by name/id matching /month|m\b/i, etc., then
 * selectOption each.
 */
async function fillSplitMdySelect(_page, locator, _field, value) {
  const iso = toISO(value);
  if (!iso) return _MANUAL(value, 'split_mdy_select: could not parse value');
  const [y, m, d] = iso.split('-');
  try {
    // Review fix (CRITICAL C1): tighten selectors. The old query
    // `select[name*="month" i]` matched compound names like
    // "month-year-select" which produced the WRONG child via
    // .first() (DOM-order dependent). We exclude the cross-attribute
    // collision by requiring the OTHER segment names to NOT be in
    // the same attribute value.
    const monthSel = locator
      .locator('select[name*="month" i]:not([name*="year" i]):not([name*="day" i]), select[id*="month" i]:not([id*="year" i]):not([id*="day" i])')
      .first();
    const daySel = locator
      .locator('select[name*="day" i]:not([name*="month" i]):not([name*="year" i]), select[id*="day" i]:not([id*="month" i]):not([id*="year" i])')
      .first();
    const yearSel = locator
      .locator('select[name*="year" i]:not([name*="month" i]):not([name*="day" i]), select[id*="year" i]:not([id*="month" i]):not([id*="day" i])')
      .first();
    // Try numeric-string options first (e.g. '06'); fall back to int
    // string ('6') and (for year) 2-digit ('24').
    await _trySelectOption(monthSel, [m, String(+m)]);
    await _trySelectOption(daySel, [d, String(+d)]);
    // Review fix (L2): year fallback also includes 2-digit form for
    // forms that use `<select>` with `<option value="24">2024</option>`.
    await _trySelectOption(yearSel, [y, y.slice(-2)]);
    return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
  } catch (err) {
    return _MANUAL(value, `split_mdy_select: ${err?.message ?? err}`);
  }
}

async function _trySelectOption(loc, candidates) {
  let lastErr;
  for (const candidate of candidates) {
    try {
      await loc.selectOption(candidate);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('selectOption: no candidate matched');
}

// ─── Detection rules ──────────────────────────────────────────────────

// Review fix (B9/H1): class matching MUST be token-aware. Previous
// substring match (`className.includes('pac-input')`) collided with
// unrelated class names (`react-datepicker-popper`, custom
// `epicac-input-foo`, etc.). Split on whitespace, compare per-token
// with optional `name-*` prefix match (covers `flatpickr-input-mobile`
// while rejecting `notaflatpickr-input`).
function _hasClassToken(info, needle) {
  if (!info || typeof info.className !== 'string') return false;
  const target = needle.toLowerCase();
  const tokens = info.className.toLowerCase().split(/\s+/);
  return tokens.some((t) => t === target || t.startsWith(`${target}-`) || t.startsWith(`${target}_`));
}

// True when the class list contains ANY of the candidate prefixes.
function _hasAnyClassPrefix(info, needles) {
  if (!info || typeof info.className !== 'string') return false;
  const tokens = info.className.toLowerCase().split(/\s+/);
  const targets = needles.map((n) => n.toLowerCase());
  return tokens.some((t) => targets.some((target) => t === target || t.startsWith(target)));
}

/**
 * Detection rule for date control variants. Runs in DETECTION_RULES order
 * — m1 baseline first, m2 rules appended here. Returns a ControlType
 * value or null to defer.
 */
function dateDetectionRule(entry, info, _classifiedField) {
  if (!info) return null;
  // HTML5 <input type=date> — cheapest signal, no class needed.
  if (info.tagName === 'INPUT' && info.type === 'date') {
    return ControlType.HTML5_DATE;
  }
  // Flatpickr — distinctive class on the input or its alt-input.
  if (_hasClassToken(info, 'flatpickr-input') || _hasClassToken(info, 'flatpickr-alt-input')) {
    return ControlType.FLATPICKR;
  }
  // React DatePicker — match only specific known classes. Review fix
  // (H2): previous broad `_hasClass('react-datepicker')` matched
  // popper / day-button classes too, mis-routing fields whose locator
  // accidentally resolved into the popup.
  if (
    _hasAnyClassPrefix(info, [
      'react-datepicker__input-container',
      'react-datepicker-ignore-onclickoutside',
      'react-datepicker-wrapper',
    ])
  ) {
    return ControlType.REACT_DATEPICKER;
  }
  // MUI DatePicker — Review fix (CRITICAL B5/C2): old rule used `mui`
  // class + `aria-haspopup=dialog` as a sufficient signal. That matched
  // EVERY MuiAutocomplete + MuiSelect (also aria-haspopup=dialog),
  // routing job-title selects and city autocompletes to the date
  // strategy. New rule requires an explicit DATE-only MUI class.
  if (
    _hasAnyClassPrefix(info, [
      'muipickerstextfield',
      'muipickers',
      'muidatefield',
      'muidatepicker',
      'muidatecalendar',
    ])
  ) {
    return ControlType.MUI_DATEPICKER;
  }
  // Split MDY selects — entry is the container (group/region) and name
  // mentions "date of birth" / "birth date". Require container-like
  // role/tag so we don't mis-route a single text input inside a
  // fieldset labeled "Date of birth" (review fix B6).
  if (
    entry &&
    typeof entry.name === 'string' &&
    /(date\s*of\s*birth|birth\s*date|dob)/i.test(entry.name)
  ) {
    const looksLikeContainer =
      entry.role === 'group' ||
      entry.role === 'region' ||
      info.tagName === 'FIELDSET' ||
      info.tagName === 'DIV';
    if (looksLikeContainer) return ControlType.SPLIT_MDY_SELECT;
  }
  return null;
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerDateStrategies() {
  registerStrategy(ControlType.HTML5_DATE, { fill: fillHtml5Date });
  registerStrategy(ControlType.REACT_DATEPICKER, { fill: fillReactDatepicker });
  registerStrategy(ControlType.MUI_DATEPICKER, { fill: fillMuiDatepicker });
  registerStrategy(ControlType.FLATPICKR, { fill: fillFlatpickr });
  registerStrategy(ControlType.SPLIT_MDY_SELECT, { fill: fillSplitMdySelect });
  // UNKNOWN_CALENDAR is intentionally NOT registered — it falls to
  // MANUAL via nonstandardFillField's unregistered-strategy path.
  registerDetectionRule(dateDetectionRule);
}

registerDateStrategies();

// Exported for unit-testing strategy internals without going through
// the full router/dispatcher path.
export const _testing = {
  fillHtml5Date,
  fillReactDatepicker,
  fillMuiDatepicker,
  fillFlatpickr,
  fillSplitMdySelect,
  dateDetectionRule,
};
