// Site adapter recognition for Mode 2 multi-step state machine.
//
// 07-applier/04-multi-step-state-machine m2.
//
// Inline mini-registry — does NOT depend on 06-site-adapters being
// merged. 06 will supersede later with the same shape so m3/m4
// callers don't need to change. Contract:
//   {
//     id: 'workday' | 'icims' | 'successfactors' | 'generic',
//     urlPattern: RegExp,
//     nextButtonHints: string[],   // accessible-name substrings to try
//     progressBarHints: string[],  // aria-label substrings
//     stepListHints: string[],     // aria-label of sidebar step list
//     submitHints: string[],       // "submit application" / "apply" patterns
//   }
//
// Detection precedence: workday → icims → successfactors → generic
// (generic always matches; explicit ATS regexes are tried first).

/**
 * M4 fix from review: explicit contract — adapter ids MUST be a subset
 * of m1's SITE_ADAPTERS enum. detectAdapter assertion at the bottom of
 * this file enforces this at module load so a 06-site-adapters drop-in
 * can't quietly desync.
 */
export const KNOWN_IDS = Object.freeze(['workday', 'icims', 'successfactors', 'generic']);

/** @type {ReadonlyArray<object>} */
export const ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'workday',
    // myworkdayjobs.com (most common), workdayjobs.com, *.wd5.myworkdayjobs.com
    urlPattern: /\b(myworkdayjobs|workdayjobs)\.com\b/i,
    nextButtonHints: ['Next', 'Save and Continue', 'Continue'],
    progressBarHints: ['progress', 'application progress'],
    stepListHints: ['application steps', 'progress steps'],
    submitHints: ['Submit', 'Submit Application'],
  }),
  Object.freeze({
    id: 'icims',
    // jobs.icims.com — sometimes mounted on tenant subdomain
    urlPattern: /\b(icims)\.com\b/i,
    nextButtonHints: ['Next', 'Continue', 'Save & Continue'],
    progressBarHints: ['progress', 'application progress'],
    stepListHints: ['steps', 'application sections'],
    submitHints: ['Submit', 'Submit Application'],
  }),
  Object.freeze({
    id: 'successfactors',
    // *.successfactors.com (SAP)
    urlPattern: /\b(successfactors)\.com\b/i,
    nextButtonHints: ['Next', 'Continue', 'Forward'],
    progressBarHints: ['progress'],
    stepListHints: ['tabs', 'steps'],
    submitHints: ['Submit', 'Apply'],
  }),
  Object.freeze({
    id: 'generic',
    // Fallback — always matches
    urlPattern: /.*/,
    nextButtonHints: ['Next', 'Continue', 'Save and Continue', 'Save & Continue'],
    progressBarHints: ['progress'],
    stepListHints: ['steps'],
    submitHints: ['Submit', 'Apply'],
  }),
]);

const ADAPTERS_BY_ID = Object.freeze(
  Object.fromEntries(ADAPTERS.map((a) => [a.id, a])),
);

/**
 * Recognize the ATS from a job URL. Returns the adapter id; 'generic'
 * on unknown / empty / malformed URLs.
 *
 * M1 fix from review: match against URL.hostname (not the full URL
 * string) so a path containing "workdayjobs" can't false-positive a
 * non-ATS site. Falls back to substring match on the original string
 * if URL parsing fails (defense in depth).
 *
 * @param {string} jobUrl
 * @returns {'workday'|'icims'|'successfactors'|'generic'}
 */
export function detectAdapter(jobUrl) {
  if (typeof jobUrl !== 'string' || !jobUrl) return 'generic';
  let host = '';
  try {
    host = new URL(jobUrl).hostname;
  } catch {
    // Malformed URL — fall through; let the regex try the raw string
    // (very permissive, but bounded by adapter regex tightness).
  }
  const target = host || jobUrl;
  for (const adapter of ADAPTERS) {
    if (adapter.id === 'generic') continue; // fallthrough at end
    if (adapter.urlPattern.test(target)) return adapter.id;
  }
  return 'generic';
}

// M4: enforce adapter id ↔ KNOWN_IDS subset at module load.
for (const adapter of ADAPTERS) {
  if (!KNOWN_IDS.includes(adapter.id)) {
    throw new Error(
      `siteAdapter.mjs: adapter id "${adapter.id}" not in KNOWN_IDS — must match m1's SITE_ADAPTERS enum`,
    );
  }
}

/**
 * Return the full adapter descriptor by id. Throws on unknown id.
 *
 * @param {string} id
 * @returns {object} the adapter descriptor (frozen)
 */
export function getAdapter(id) {
  const a = ADAPTERS_BY_ID[id];
  if (!a) throw new Error(`unknown adapter id: ${JSON.stringify(id)}`);
  return a;
}

/** Convenience accessor — returns the array of name-substring hints. */
export function resolveNextButtonHints(idOrAdapter) {
  const a = typeof idOrAdapter === 'string' ? getAdapter(idOrAdapter) : idOrAdapter;
  return a.nextButtonHints;
}

export function resolveProgressBarHints(idOrAdapter) {
  const a = typeof idOrAdapter === 'string' ? getAdapter(idOrAdapter) : idOrAdapter;
  return a.progressBarHints;
}

export function resolveStepListHints(idOrAdapter) {
  const a = typeof idOrAdapter === 'string' ? getAdapter(idOrAdapter) : idOrAdapter;
  return a.stepListHints;
}

export function resolveSubmitHints(idOrAdapter) {
  const a = typeof idOrAdapter === 'string' ? getAdapter(idOrAdapter) : idOrAdapter;
  return a.submitHints;
}
