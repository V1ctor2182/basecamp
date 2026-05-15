// Non-standard control router — ControlType enum + detection + strategy
// registry for the 21 + 5 = 26 control variants the applier may encounter.
//
// 07-applier/05-non-standard-controls m1.
//
// Locked design (planning OQs):
//   - OQ1 (STALE_REF): callers resolve the Locator ONCE via table.resolve
//     and pass it to a strategy. Strategies operate on the raw Locator
//     directly — they do NOT call actions.mjs verbs (which would bump
//     RefTable generation and break sibling-field fills within the same
//     snapshot). The RefTable is touched exactly once per field.
//   - OQ2 (detection depth): ARIA role + optional one-shot class sniff
//     via locator.evaluate. m1 ships the framework; m2/m3/m4 register
//     their patterns through registerDetectionRule() — no edits to this
//     file required as new ATS shapes land.
//   - OQ3 (scope): nonstandardFillField is a FULL replacement for
//     machine.mjs's PROVISIONAL defaultFillField, so this router must
//     resolve standard textbox/select/checkbox/radio/file too — those
//     strategies are registered in nonstandardFillField.mjs at m1.
//
// The registry pattern keeps the router decoupled from the strategy
// implementations: every later milestone adds entries via the same
// registerStrategy() seam.

/**
 * Closed set of recognized control variants. The router maps a (refId,
 * snapshot entry, optional class sniff) tuple onto exactly one of these
 * values; the registry maps each value to a fill strategy. Types whose
 * strategy is unregistered fall through to MANUAL.
 *
 * @readonly
 * @enum {string}
 */
export const ControlType = Object.freeze({
  // STANDARD (5) — strategies registered in nonstandardFillField.mjs m1
  TEXTBOX: 'textbox',
  SELECT_NATIVE: 'select_native',
  CHECKBOX: 'checkbox',
  RADIO_NATIVE: 'radio_native',
  FILE: 'file',
  // DATE (6) — strategies registered in m2
  HTML5_DATE: 'html5_date',
  REACT_DATEPICKER: 'react_datepicker',
  MUI_DATEPICKER: 'mui_datepicker',
  FLATPICKR: 'flatpickr',
  SPLIT_MDY_SELECT: 'split_mdy_select',
  UNKNOWN_CALENDAR: 'unknown_calendar',
  // ADDRESS (3) — strategies registered in m2
  GOOGLE_PLACES: 'google_places',
  ALGOLIA_PLACES: 'algolia_places',
  CUSTOM_AUTOCOMPLETE: 'custom_autocomplete',
  // SELECTION VARIANT (4) — strategies registered in m3
  RADIO_DIV: 'radio_div',
  MULTI_SELECT_CHIP: 'multi_select_chip',
  CUSTOM_COMBOBOX: 'custom_combobox',
  SEARCH_SELECT: 'search_select',
  // SPECIAL (5) — strategies registered in m4
  RICH_TEXT: 'rich_text',
  SLIDER_RANGE: 'slider_range',
  CAPTCHA: 'captcha',
  SHADOW_DOM: 'shadow_dom',
  IFRAME_FORM: 'iframe_form',
  // Catch-all — never strategy-registered; always MANUAL
  UNKNOWN: 'unknown',
});

const ALL_CONTROL_TYPES = new Set(Object.values(ControlType));

/**
 * Confidence tier returned by a strategy. Drives downstream UI behavior:
 *   - HIGH: bulk-approve in dashboard
 *   - MEDIUM: highlight but allow approve
 *   - LOW: block_approve flag set; user must per-field accept
 *   - MANUAL: not filled; user takes over in browser (red border via
 *     manualHighlight.mjs in m4)
 *
 * Stored as lowercase strings to match the existing draftsStore.mjs
 * CONFIDENCE_TIERS (['high','medium','low','manual']) — same string
 * shape avoids translation at persistence time.
 *
 * @readonly
 * @enum {string}
 */
export const Confidence = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  MANUAL: 'manual',
});

const ALL_CONFIDENCE = new Set(Object.values(Confidence));

/**
 * @typedef {object} FillResult
 * @property {boolean} filled — true if the strategy mutated DOM (HIGH/
 *   MEDIUM/LOW path); false for MANUAL or no-op.
 * @property {string} confidence — Confidence enum value.
 * @property {boolean} manual — true when the caller (nonstandardFillField)
 *   must surface to UI as user-must-fill. Equivalent to confidence==='manual'.
 * @property {string|null} suggestedValue — value the strategy WOULD have
 *   filled (passed to UI for Copy-to-Clipboard); preserved on MANUAL so
 *   the dashboard can show what to type.
 * @property {string} [error] — short message when a strategy gave up
 *   gracefully (no throw). Propagated to classifiedField.fill_error.
 */

/**
 * Module-level strategy registry. Keyed by ControlType value. Each entry:
 *   { fill: async (page, locator, classifiedField, value) → FillResult }
 *
 * Mutated at import time by strategy modules (nonstandardFillField.mjs
 * for standard controls in m1; date/address/selection/special modules in
 * m2/m3/m4). NOT re-exported as a plain object literal — keep it a Map
 * so concurrent modifications during smoke setup don't leak between tests.
 *
 * @type {Map<string, { fill: Function }>}
 */
export const STRATEGY_REGISTRY = new Map();

/**
 * Register a strategy for a ControlType. Overwrites any prior entry — the
 * last registration wins. Smoke tests rely on this for mock injection.
 *
 * @param {string} type — ControlType value
 * @param {{ fill: Function }} strategy
 */
export function registerStrategy(type, strategy) {
  if (!ALL_CONTROL_TYPES.has(type)) {
    throw new TypeError(`registerStrategy: unknown ControlType "${type}"`);
  }
  if (!strategy || typeof strategy.fill !== 'function') {
    throw new TypeError(`registerStrategy(${type}): strategy must have async fill()`);
  }
  STRATEGY_REGISTRY.set(type, strategy);
}

/** @param {string} type */
export function getStrategy(type) {
  return STRATEGY_REGISTRY.get(type) || null;
}

/**
 * Clear all registered strategies. Smoke-only — production callers should
 * never invoke this since strategies are registered at module import.
 */
export function _resetRegistryForTesting() {
  STRATEGY_REGISTRY.clear();
  DETECTION_RULES.length = 0;
}

/**
 * Pluggable detection rules. Each rule sees the snapshot entry +
 * (optional) element sniff and returns a ControlType or null to defer
 * to the next rule. Rules run in registration order — earlier rules
 * win. m2/m3/m4 each register their patterns at import time.
 *
 * Rule signature:
 *   (entry, elementInfo, classifiedField) → ControlType | null
 * Where:
 *   entry         — table.publicEntry(refId): { role, name, occurrenceIndex, frameIdx }
 *   elementInfo   — sniffElement output (null when sniff was skipped)
 *   classifiedField — full classified field for class-aware decisions
 *
 * @type {Array<Function>}
 */
export const DETECTION_RULES = [];

/** @param {Function} rule */
export function registerDetectionRule(rule) {
  if (typeof rule !== 'function') {
    throw new TypeError('registerDetectionRule: rule must be a function');
  }
  DETECTION_RULES.push(rule);
}

/**
 * Map an ARIA role string to its closest STANDARD ControlType. Returns
 * UNKNOWN for unrecognized roles — caller decides whether to escalate
 * to MANUAL or run the class sniff. Pure function, no I/O.
 *
 * @param {string} role
 * @param {string} [name] — accessible name (for "textbox role with name
 *   matching /month|day|year/i" → SPLIT_MDY_SELECT shortcut)
 * @returns {string} ControlType
 */
export function ariaRoleToControlType(role, name) {
  switch (role) {
    case 'textbox':
      return ControlType.TEXTBOX;
    case 'combobox':
      return ControlType.SELECT_NATIVE;
    case 'checkbox':
      return ControlType.CHECKBOX;
    case 'radio':
      return ControlType.RADIO_NATIVE;
    case 'spinbutton':
      // Split month/day/year selects sometimes expose as 3 spinbuttons;
      // the per-segment name match catches them. H4 from review:
      // tightened the regex — `\bmonth\b` matched "Months of experience";
      // require the name to be effectively JUST the segment label or
      // pair it with date-context tokens ("birth", "date of", "dob").
      if (typeof name === 'string' && _looksLikeDateSegment(name)) {
        return ControlType.SPLIT_MDY_SELECT;
      }
      return ControlType.TEXTBOX;
    default:
      return ControlType.UNKNOWN;
  }
}

// H4 fix from review: tighten spinbutton → SPLIT_MDY_SELECT detection.
// Old regex `\b(month|day|year|mm|dd|yyyy)\b` matched "Years of experience"
// (token "year" inside compound noun) — false positive that routed
// non-date numeric inputs to a non-existent strategy → MANUAL.
//
// New rule: name must be EFFECTIVELY just the segment label (with
// optional separator/qualifier), OR it must include a date-context
// keyword. "Month" / "Birth Month" / "DOB Year" pass; "Years of
// experience" / "Month-to-month basis" fail.
const _DATE_SEGMENT_BASE = /^(?:month|day|year|mm|dd|yyyy|yy)$/i;
const _DATE_SEGMENT_CONTEXT = /(?:^|\W)(?:birth|dob|date(?:\s*of)?)(?:\W|$)/i;
const _DATE_SEGMENT_WITH_LABEL =
  /(?:^|\W)(?:month|day|year|mm|dd|yyyy|yy)(?:\W|$)/i;

function _looksLikeDateSegment(name) {
  const trimmed = name.trim();
  if (_DATE_SEGMENT_BASE.test(trimmed)) return true;
  if (!_DATE_SEGMENT_WITH_LABEL.test(trimmed)) return false;
  return _DATE_SEGMENT_CONTEXT.test(trimmed);
}

/**
 * One-shot DOM sniff. Pulls className / dataset / tagName / type / a
 * curated set of attrs in a single page.evaluate so detection rules
 * have what they need without round-tripping. Returns null when the
 * locator can't be resolved (treated as "no sniff signal").
 *
 * The attribute list is deliberately narrow — every entry has a known
 * detection use somewhere in m2/m3/m4. Keep it bounded to avoid leaking
 * arbitrary DOM state into the rule engine.
 *
 * @param {object} locator — Playwright Locator (pre-resolved by caller)
 * @returns {Promise<{ className: string, dataset: object, tagName: string, type: string, attrs: object } | null>}
 */
export async function sniffElement(locator) {
  if (!locator || typeof locator.evaluate !== 'function') return null;
  try {
    return await locator.evaluate((el) => ({
      className: typeof el.className === 'string' ? el.className : '',
      dataset: el.dataset ? { ...el.dataset } : {},
      tagName: el.tagName || '',
      type: el.type || '',
      attrs: {
        'aria-multiselectable': el.getAttribute('aria-multiselectable'),
        'aria-haspopup': el.getAttribute('aria-haspopup'),
        'aria-autocomplete': el.getAttribute('aria-autocomplete'),
        'aria-multiline': el.getAttribute('aria-multiline'),
        'data-sitekey': el.getAttribute('data-sitekey'),
        'role': el.getAttribute('role'),
        'contenteditable': el.getAttribute('contenteditable'),
      },
    }));
  } catch {
    // sniff is opportunistic; resolve() failures bubble up via the
    // caller's main fill path (table.resolve will throw the proper
    // SnapshotError there). Returning null here means downstream rules
    // see "no signal" — they'll fall through to ariaRoleToControlType.
    return null;
  }
}

// C1 fix from review: router-owned WeakMap keyed by the raw entry
// object replaces the previous `entry._controlTypeHint = …` mutation.
// The previous design wrote into RefTable internal state (which
// refTable.mjs:117-121 documents as INTERNAL), risking
// leak-across-snapshots and write-during-iteration hazards. WeakMap
// auto-GCs when the table (and its entries) is dropped.
const _CONTROL_TYPE_CACHE = new WeakMap();

/**
 * Detect the ControlType for a classified field. Cheap-to-expensive:
 *   1. classifiedField.class === 'file' → FILE shortcut
 *   2. ARIA role mapping (no I/O)
 *   3. If DETECTION_RULES are registered, sniff the element and let
 *      rules vote. Rules can override the ARIA mapping (e.g. role=radio
 *      + tagName=DIV → RADIO_DIV).
 *
 * Caching: the result is stashed in _CONTROL_TYPE_CACHE keyed by the
 * raw RefTable entry object so a re-call within the same step is O(1).
 * Cache auto-cleans when the entry is GC'd (new snapshot → new entries).
 *
 * @param {object} page — Playwright Page
 * @param {string} refId
 * @param {object} table — RefTable from 08-snapshot-refs-layer
 * @param {object} classifiedField — output of 03-field-classifier
 * @returns {Promise<string>} ControlType value
 */
export async function detectControlType(page, refId, table, classifiedField) {
  // 1. file class shortcut — classifier already told us. Skip any DOM I/O.
  if (classifiedField && classifiedField.class === 'file') {
    return ControlType.FILE;
  }

  // 2. Cache check (router-owned WeakMap keyed by entry identity).
  const rawEntry = typeof table.get === 'function' ? table.get(refId) : null;
  if (rawEntry) {
    const cached = _CONTROL_TYPE_CACHE.get(rawEntry);
    if (cached) return cached;
  }

  const pub = typeof table.publicEntry === 'function' ? table.publicEntry(refId) : null;
  if (!pub) {
    return ControlType.UNKNOWN;
  }

  // 3. ARIA-only baseline (always available — no sniff cost).
  const ariaType = ariaRoleToControlType(pub.role, pub.name);

  // 4. If no detection rules registered yet (m1 baseline), trust ARIA.
  if (DETECTION_RULES.length === 0) {
    if (rawEntry) _CONTROL_TYPE_CACHE.set(rawEntry, ariaType);
    return ariaType;
  }

  // 5. Sniff once + run rules in order. Rules may upgrade ARIA mapping
  //    (e.g. detect div[role=radio] → RADIO_DIV) or detect special
  //    types (CAPTCHA via data-sitekey, RICH_TEXT via ql-editor class).
  //
  // H5 fix from review: don't catch resolve errors here. If STALE_REF
  // / UNKNOWN_REF / WRONG_PAGE fires, propagate so the outer
  // nonstandardFillField fail-fast path reports the real error once,
  // rather than silently falling back to ARIA and then re-throwing
  // at the action site.
  const locator =
    typeof table.resolve === 'function' ? table.resolve(refId, page) : null;
  const elementInfo = locator ? await sniffElement(locator) : null;

  for (const rule of DETECTION_RULES) {
    try {
      const t = rule(pub, elementInfo, classifiedField);
      if (t && ALL_CONTROL_TYPES.has(t)) {
        if (rawEntry) _CONTROL_TYPE_CACHE.set(rawEntry, t);
        return t;
      }
    } catch {
      // Rule errors must not derail detection — fall through to next.
    }
  }

  if (rawEntry) _CONTROL_TYPE_CACHE.set(rawEntry, ariaType);
  return ariaType;
}

/** Validation guard — exported for tests. */
export function isValidConfidence(c) {
  return ALL_CONFIDENCE.has(c);
}

/** Validation guard — exported for tests. */
export function isValidControlType(t) {
  return ALL_CONTROL_TYPES.has(t);
}
