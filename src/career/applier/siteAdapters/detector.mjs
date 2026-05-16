// URL → adapter detector.
//
// 07-applier/06-site-adapters m1.
//
// Given a job URL + an AdapterRegistry (from loader.mjs), returns the
// highest-priority matching adapter. Never returns null — `default.yml`
// catches everything as the priority-0 fallback so callers can assume
// a non-null result.
//
// Matching strategy:
//   1. Try new URL(jobUrl).hostname — match adapter.detection.urlRegexes
//      against the hostname only. This is the primary path; hostnames
//      are stable across query strings and resilient to nested paths
//      that might contain false-positive substrings.
//   2. If new URL() throws (malformed input), fall back to raw-string
//      matching. Adapter regexes are tight enough (e.g.
//      `myworkdayjobs\.com`) that false positives are unlikely.
//
// OQ4 m1: URL-only. DOM signatures are accepted in the schema but
// detector does NOT inspect them — they'd require a Page reference at
// detection time (async), which complicates startMachine's call path
// for marginal gain. Phase 2 / 飞轮 will revisit when ambiguous-URL
// cases come up.

/**
 * @param {string} jobUrl
 * @param {import('./loader.mjs').AdapterRegistry} registry
 * @returns {import('./schema.mjs').CompiledAdapter}
 */
export function detectSiteAdapter(jobUrl, registry) {
  if (!registry || !registry.default) {
    throw new Error('detectSiteAdapter: registry missing default adapter — load failed?');
  }
  const target = _normalizeTarget(jobUrl);
  if (!target) return registry.default;

  // adapters are sorted priority DESC by the loader
  for (const adapter of registry.adapters) {
    for (const rx of adapter.detection.urlRegexes) {
      if (rx.test(target)) return adapter;
    }
  }
  return registry.default;
}

/**
 * Diagnostic: list every adapter that matches the given URL, sorted by
 * priority DESC. Useful for debugging "why did adapter X get picked".
 * Always includes `default` at the tail (it matches everything).
 *
 * @param {string} jobUrl
 * @param {import('./loader.mjs').AdapterRegistry} registry
 * @returns {Array<import('./schema.mjs').CompiledAdapter>}
 */
export function listMatchingAdapters(jobUrl, registry) {
  const target = _normalizeTarget(jobUrl);
  const matches = [];
  if (target) {
    for (const adapter of registry.adapters) {
      for (const rx of adapter.detection.urlRegexes) {
        if (rx.test(target)) {
          matches.push(adapter);
          break;
        }
      }
    }
  }
  matches.push(registry.default);
  return matches;
}

function _normalizeTarget(jobUrl) {
  if (typeof jobUrl !== 'string' || !jobUrl) return '';
  try {
    const u = new URL(jobUrl);
    return u.hostname || jobUrl;
  } catch {
    return jobUrl;
  }
}
