// Multi-step site-adapter facade — thin re-export over 06-site-adapters'
// YAML loader.
//
// 07-applier/06-site-adapters m3.
//
// Before m3: this file contained an inline ADAPTERS array hard-coded
// with the 4 multi-step ATS descriptors (workday, icims, successfactors,
// generic). 04-m2 documented that 06 would "supersede [it] later with
// the same shape so m3/m4 callers don't need to change."
//
// After m3: the inline array is replaced by adapters loaded from
// data/career/site-adapters/{workday,icims,successfactors,default}.yml
// via the new siteAdapters/loader.mjs (m1). The legacy public API is
// preserved exactly so stepProbe.mjs / machine.mjs / endpoint.mjs imports
// don't need to change:
//
//   KNOWN_IDS                       — ['workday','icims','successfactors','generic']
//   ADAPTERS                        — array of 4 legacy-shape descriptors
//   detectAdapter(jobUrl)           — URL → legacy id; greenhouse/ashby/lever
//                                      (single-step) collapse to 'generic'
//   getAdapter(id)                  — legacy descriptor by id
//   resolveNextButtonHints(idOrAdapter)   — legacy hint accessor
//   resolveProgressBarHints(idOrAdapter)
//   resolveStepListHints(idOrAdapter)
//   resolveSubmitHints(idOrAdapter)
//
// New API for m2's activateAdapter (06-site-adapters):
//   getCompiledAdapter(legacyIdOrJobUrl) — returns the YAML's CompiledAdapter
//   getRegistry()                        — exposes the underlying m1 registry
//
// Module init: top-level await loadAdapters(). YAMLs read once at module
// import; subsequent calls are sync lookups against the cached registry.
// This means importing siteAdapter.mjs performs file I/O at import time,
// same as the old inline registry's initialization cost (now ~5 ms for
// js-yaml parsing instead of zero).

import { loadAdapters } from '../siteAdapters/loader.mjs';
import { detectSiteAdapter } from '../siteAdapters/detector.mjs';

// ── Legacy contract ────────────────────────────────────────────────────

/**
 * Legacy multi-step adapter id set. Frozen at module load and stays
 * stable — applySessionsStore.mjs's SITE_ADAPTERS enum depends on this.
 */
export const KNOWN_IDS = Object.freeze(['workday', 'icims', 'successfactors', 'generic']);

// Multi-step ATS ids the legacy machine.mjs / stepProbe.mjs operate on.
const _MULTI_STEP_IDS = new Set(['workday', 'icims', 'successfactors']);

// Legacy `generic` id maps to the new schema's `default.yml`. detectAdapter
// returns 'generic' for unknown URLs; the YAML registry stores it under the
// `default` slug.
const _LEGACY_GENERIC_ID = 'generic';
const _NEW_DEFAULT_ID = 'default';

// REVIEW C3 fix: wrap top-level await in try/catch with a minimal
// fallback registry. Pre-m3 the inline registry was unkillable; after
// migration a single malformed YAML would have brought down every
// dependent module (endpoint.mjs, stepProbe.mjs, machine.mjs, the
// entire HTTP server). The fallback gives us "service still up,
// multi-step machine still works with hard-coded hints" instead.
//
// `_loadError` is exported for diagnostics (dashboard / server log).
/** @type {import('../siteAdapters/loader.mjs').AdapterRegistry} */
let _registry;
/** @type {Error|null} */
export let _loadError = null;
try {
  _registry = await loadAdapters();
} catch (err) {
  _loadError = err;
  // Surface to stderr so deploys notice on boot.
  console.error('siteAdapter.mjs: failed to load site-adapters/*.yml; using fallback', err.message);
  _registry = _buildFallbackRegistry();
}

function _buildFallbackRegistry() {
  // Bare-minimum registry matching the pre-m3 inline contract. Used
  // ONLY when YAML loading fails — single-step adapters (greenhouse /
  // ashby / lever) are absent here because they didn't exist pre-m3
  // either; their hints are nice-to-have, not load-bearing.
  const mkAdapter = (id, urls, nextHints, submitHints) => Object.freeze({
    id,
    name: id,
    priority: 110,
    detection: Object.freeze({
      url_patterns: Object.freeze(urls),
      dom_signatures: Object.freeze([]),
      urlRegexes: Object.freeze(urls.map((p) => new RegExp(p, 'i'))),
    }),
    flow: Object.freeze({
      type: 'multi-step',
      next_button: Object.freeze({
        selectors: Object.freeze([]),
        name_hints: Object.freeze(nextHints),
      }),
      submit_button: Object.freeze({
        selectors: Object.freeze([]),
        name_hints: Object.freeze(submitHints),
      }),
      progress_bar: Object.freeze({ selectors: Object.freeze([]), name_hints: Object.freeze(['progress']) }),
      step_list: Object.freeze({ selectors: Object.freeze([]), name_hints: Object.freeze(['steps']) }),
    }),
    controls: Object.freeze({}),
    known_fields: Object.freeze([]),
    quirks: Object.freeze([]),
  });
  const defaultAdapter = mkAdapter(
    'default',
    ['.*'],
    ['Next', 'Continue', 'Save and Continue'],
    ['Submit', 'Apply'],
  );
  return Object.freeze({
    adapters: Object.freeze([
      mkAdapter('workday', ['myworkdayjobs\\.com', 'workdayjobs\\.com'], ['Next', 'Save and Continue', 'Continue'], ['Submit', 'Submit Application']),
      mkAdapter('icims', ['icims\\.com'], ['Next', 'Continue', 'Save & Continue'], ['Submit', 'Submit Application']),
      mkAdapter('successfactors', ['successfactors\\.com'], ['Next', 'Continue', 'Forward'], ['Submit', 'Apply']),
    ]),
    default: defaultAdapter,
    common: null,
    dir: '<fallback>',
    signature: 'fallback',
  });
}

// Build the legacy ADAPTERS array EXACTLY in the shape the prior inline
// registry exposed (matches what stepProbe.mjs reads).
const _legacyAdaptersById = (() => {
  const byId = Object.create(null);
  for (const id of ['workday', 'icims', 'successfactors']) {
    const compiled = _registry.adapters.find((a) => a.id === id);
    if (!compiled) {
      throw new Error(
        `siteAdapter.mjs: required multi-step YAML missing for "${id}" — ` +
          `expected data/career/site-adapters/${id}.yml`,
      );
    }
    byId[id] = _toLegacyShape(compiled, id);
  }
  // 'generic' is the legacy alias for the new schema's default.yml
  byId[_LEGACY_GENERIC_ID] = _toLegacyShape(_registry.default, _LEGACY_GENERIC_ID);
  return Object.freeze(byId);
})();

export const ADAPTERS = Object.freeze(
  KNOWN_IDS.map((id) => _legacyAdaptersById[id]),
);

// Module-load sanity check: contract enforced at start so a YAML drop-in
// can't silently desync from KNOWN_IDS.
for (const id of KNOWN_IDS) {
  if (!_legacyAdaptersById[id]) {
    throw new Error(`siteAdapter.mjs: KNOWN_IDS expects "${id}" — missing from registry`);
  }
}

/**
 * Recognize the multi-step ATS from a job URL. Maps single-step ATS
 * matches (greenhouse / ashby / lever) onto 'generic' so callers in the
 * multi-step machine stay in their type-safe ATS enum. Unknown / empty
 * / malformed URLs return 'generic'.
 *
 * @param {string} jobUrl
 * @returns {'workday'|'icims'|'successfactors'|'generic'}
 */
export function detectAdapter(jobUrl) {
  if (typeof jobUrl !== 'string' || !jobUrl) return _LEGACY_GENERIC_ID;
  let compiled;
  try {
    compiled = detectSiteAdapter(jobUrl, _registry);
  } catch {
    return _LEGACY_GENERIC_ID;
  }
  if (!compiled) return _LEGACY_GENERIC_ID;
  if (_MULTI_STEP_IDS.has(compiled.id)) return compiled.id;
  // Single-step ATS or default → fall through to legacy 'generic' since
  // the multi-step state machine has no use for greenhouse/ashby/lever
  // hints (those flow through 01-mode1-simplify-hybrid instead).
  return _LEGACY_GENERIC_ID;
}

/**
 * Return the legacy descriptor by id. Throws on unknown id (matches the
 * pre-m3 behavior).
 *
 * @param {string} id
 */
export function getAdapter(id) {
  const a = _legacyAdaptersById[id];
  if (!a) throw new Error(`unknown adapter id: ${JSON.stringify(id)}`);
  return a;
}

/** Convenience accessor — returns the legacy array of name-substring hints. */
export function resolveNextButtonHints(idOrAdapter) {
  return _resolveHints(idOrAdapter, 'nextButtonHints');
}

export function resolveProgressBarHints(idOrAdapter) {
  return _resolveHints(idOrAdapter, 'progressBarHints');
}

export function resolveStepListHints(idOrAdapter) {
  return _resolveHints(idOrAdapter, 'stepListHints');
}

export function resolveSubmitHints(idOrAdapter) {
  return _resolveHints(idOrAdapter, 'submitHints');
}

// ── New API for m2's activateAdapter ──────────────────────────────────

/**
 * Return the CompiledAdapter (m1 schema) for a legacy id OR a job URL.
 * Used by endpoint.mjs to feed activateAdapter so per-ATS controls +
 * known_fields take effect during the apply. For URLs whose true match
 * is a single-step ATS (greenhouse etc.), this returns the actual
 * compiled adapter — NOT the legacy 'generic' translation — so the
 * greenhouse YAML's known_fields fire even though the multi-step state
 * machine treats the apply as 'generic'.
 *
 * @param {string} legacyIdOrJobUrl — 'workday'|'generic'|… OR a full URL
 * @returns {import('../siteAdapters/schema.mjs').CompiledAdapter}
 */
export function getCompiledAdapter(legacyIdOrJobUrl) {
  if (typeof legacyIdOrJobUrl !== 'string' || !legacyIdOrJobUrl) {
    return _registry.default;
  }
  // REVIEW C5 fix: strict URL detection. Old heuristic `.includes('.')`
  // misrouted any id that happened to contain a dot (e.g. legacy id
  // 'v2.workday' or test fixtures like 'foo.bar') into the URL branch,
  // where `new URL()` would throw and the function would silently
  // return `default` instead of throwing "unknown id" as documented.
  if (legacyIdOrJobUrl.includes('://')) {
    try {
      return detectSiteAdapter(legacyIdOrJobUrl, _registry);
    } catch {
      return _registry.default;
    }
  }
  // Id case: translate legacy 'generic' → 'default'
  const lookupId = legacyIdOrJobUrl === _LEGACY_GENERIC_ID
    ? _NEW_DEFAULT_ID
    : legacyIdOrJobUrl;
  if (lookupId === _NEW_DEFAULT_ID) return _registry.default;
  const found = _registry.adapters.find((a) => a.id === lookupId);
  if (!found) {
    throw new Error(`getCompiledAdapter: unknown id ${JSON.stringify(legacyIdOrJobUrl)}`);
  }
  return found;
}

/** Expose the underlying m1 registry — diagnostic / dashboard use. */
export function getRegistry() {
  return _registry;
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Translate a CompiledAdapter (m1 schema) to the legacy shape stepProbe.mjs
 * expects. Dedupes hint arrays since `_common.yml` merge can introduce
 * repeats (adapter-specific + common defaults overlap).
 */
function _toLegacyShape(compiled, overrideId) {
  return Object.freeze({
    id: overrideId || compiled.id,
    urlPattern: compiled.detection.urlRegexes[0] || /^$/,
    nextButtonHints: _uniq(compiled.flow.next_button.name_hints || []),
    progressBarHints: _uniq(compiled.flow.progress_bar.name_hints || []),
    stepListHints: _uniq(compiled.flow.step_list.name_hints || []),
    submitHints: _uniq(compiled.flow.submit_button.name_hints || []),
  });
}

function _uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function _resolveHints(idOrAdapter, field) {
  if (typeof idOrAdapter === 'string') return getAdapter(idOrAdapter)[field];
  if (idOrAdapter && typeof idOrAdapter === 'object' && Array.isArray(idOrAdapter[field])) {
    return idOrAdapter[field];
  }
  throw new TypeError(`${field}: expected legacy id string or descriptor object`);
}
