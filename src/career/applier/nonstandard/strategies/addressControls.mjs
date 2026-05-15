// Address autocomplete strategies — Google Places + Algolia Places +
// custom autocomplete (MANUAL).
//
// 07-applier/05-non-standard-controls m2.
//
// Pattern (both Google + Algolia): type into input → wait for suggestion
// dropdown to appear → click first suggestion. If the dropdown doesn't
// appear in time, leave the raw text in place and return MEDIUM (partial
// fill — the ATS may accept the typed string anyway). Hard failures
// (e.g. locator throws) route to MANUAL.
//
// Custom autocomplete (registered as STRATEGY-less) automatically falls
// to MANUAL via nonstandardFillField.

import { ControlType, Confidence, registerStrategy, registerDetectionRule } from '../controlRouter.mjs';

const DROPDOWN_TIMEOUT_MS = 2000;

const _MANUAL = (suggested, error) => ({
  filled: false,
  confidence: Confidence.MANUAL,
  manual: true,
  suggestedValue: suggested,
  error,
});

const _PARTIAL_LOW = (error) => ({
  // Review fix (H4/B3-Hazard#2): partial fill = raw text typed without
  // the place_id metadata that the ATS expects. Marking MEDIUM was too
  // optimistic — without the canonical suggestion, the ATS may
  // serialize a city as plain text and lose zip/country. LOW routes
  // through nonstandardFillField's block_approve gate so the user
  // must verify per-field.
  filled: true,
  confidence: Confidence.LOW,
  manual: false,
  suggestedValue: null,
  error,
});

/**
 * Google Places Autocomplete (Google Maps JS API). Dropdown injected
 * as a `.pac-container` element on document.body — page-scoped, NOT
 * inside the input's ancestor. We use page.locator() to find it.
 */
async function fillGooglePlaces(page, locator, _field, value) {
  if (value == null || value === '') return _MANUAL(value, 'google_places: empty value');
  try {
    // Review fix (CRITICAL B3/H5): dismiss any stale `.pac-container`
    // from a previous field before fill. Google's container fade
    // animation leaves the old `.pac-item` set `:visible` for ~200ms,
    // and `.first()` returns DOM-order results — meaning a previous
    // field's suggestion could be clicked for the CURRENT field
    // (user lives in a different city than they applied for).
    // page.evaluate is page-scoped so this clears all stale containers.
    try {
      await page.evaluate(() => {
        document.querySelectorAll('.pac-container').forEach((el) => {
          el.style.display = 'none';
          el.dataset.applierStale = 'true';
        });
      });
    } catch {
      // page.evaluate failure is non-fatal — we'll still try fill
      // and rely on the post-fill waitFor to surface the issue.
    }

    await locator.fill(String(value));

    try {
      // Capture the locator once and reuse — review fix B10 (test gap
      // surfaced design issue): two `.first()` calls re-resolve the
      // selector and may select different elements if Google
      // re-renders mid-wait. Excluding stale containers (which we
      // marked above with data-applier-stale).
      const item = page
        .locator('.pac-container:not([data-applier-stale]):visible .pac-item')
        .first();
      await item.waitFor({ state: 'visible', timeout: DROPDOWN_TIMEOUT_MS });
      await item.click();
      return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
    } catch (timeoutErr) {
      return _PARTIAL_LOW(`google_places: dropdown timeout (${timeoutErr?.message ?? 'timeout'})`);
    }
  } catch (err) {
    return _MANUAL(value, `google_places: ${err?.message ?? err}`);
  }
}

/**
 * Algolia Places — similar pattern with .ap-suggestions / .ap-suggestion
 * CSS. Algolia attaches the dropdown to the input's parent (unlike
 * Google's document-body attachment), so we scope to a sibling.
 */
async function fillAlgoliaPlaces(page, locator, _field, value) {
  if (value == null || value === '') return _MANUAL(value, 'algolia_places: empty value');
  try {
    await locator.fill(String(value));
    try {
      // Capture once to avoid re-resolution race (same rationale as
      // google_places fix above).
      const suggestion = page.locator('.ap-suggestions .ap-suggestion').first();
      await suggestion.waitFor({ state: 'visible', timeout: DROPDOWN_TIMEOUT_MS });
      await suggestion.click();
      return { filled: true, confidence: Confidence.MEDIUM, manual: false, suggestedValue: null };
    } catch (timeoutErr) {
      return _PARTIAL_LOW(`algolia_places: dropdown timeout (${timeoutErr?.message ?? 'timeout'})`);
    }
  } catch (err) {
    return _MANUAL(value, `algolia_places: ${err?.message ?? err}`);
  }
}

// ─── Detection rule ───────────────────────────────────────────────────

// Review fix (B9/H1): token-aware class match. Substring matching
// `'pac-input'` would collide with `'epicac-input-wrapper'`,
// `'react-pac-input-extra'`, etc. Tokens are space-separated and we
// match equality OR a `name-*`/`name_*` prefix (so `pac-input-mobile`
// counts as `pac-input` but `pac-inputextra` does not).
function _hasClassToken(info, needle) {
  if (!info || typeof info.className !== 'string') return false;
  const target = needle.toLowerCase();
  const tokens = info.className.toLowerCase().split(/\s+/);
  return tokens.some(
    (t) => t === target || t.startsWith(`${target}-`) || t.startsWith(`${target}_`),
  );
}

function addressDetectionRule(_entry, info, _classifiedField) {
  if (!info) return null;
  // Google Places — the input is the user-supplied <input> with class
  // 'pac-input' or its ancestor markup. The class is auto-applied by
  // the Maps SDK on initialization.
  if (_hasClassToken(info, 'pac-input') || _hasClassToken(info, 'pac-target-input')) {
    return ControlType.GOOGLE_PLACES;
  }
  // Algolia Places attaches 'algolia-places' or 'ap-input' to the
  // input wrapper.
  if (_hasClassToken(info, 'algolia-places') || _hasClassToken(info, 'ap-input')) {
    return ControlType.ALGOLIA_PLACES;
  }
  return null;
}

// ─── Registration ─────────────────────────────────────────────────────

export function registerAddressStrategies() {
  registerStrategy(ControlType.GOOGLE_PLACES, { fill: fillGooglePlaces });
  registerStrategy(ControlType.ALGOLIA_PLACES, { fill: fillAlgoliaPlaces });
  // CUSTOM_AUTOCOMPLETE is intentionally NOT registered — falls to
  // MANUAL via nonstandardFillField.
  registerDetectionRule(addressDetectionRule);
}

registerAddressStrategies();

export const _testing = {
  fillGooglePlaces,
  fillAlgoliaPlaces,
  addressDetectionRule,
};
