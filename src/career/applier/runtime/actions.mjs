// Symbolic action API — LLM-facing verbs (click @eN, fill @eN "value")
// that resolve symbolic refs through RefTable to Playwright Locators.
//
// 07-applier/08-snapshot-refs-layer m1.
//
// m1 ships the 2 most-common verbs (click + fill). m2 adds invalidation
// and unified error code wrapping; m3 adds select / press / upload +
// element screenshot.
//
// Per locked Q3: default action timeout 10s; per-action override via opts.
// Per locked C1: this module is the ONLY way an LLM-driven caller is
// supposed to interact with the page. raw `page.locator(...)`,
// `page.eval(...)` etc must NOT be exposed to the LLM tool surface.
// Downstream Rooms (03-field-classifier, 04-multi-step-state-machine,
// etc.) compose only these symbolic verbs.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Click the element identified by `refId`. Pre-click waits for visibility
 * (via Playwright's locator.click auto-wait — visible + stable + enabled
 * + receives events). m1 returns plain Error on failure; m2 wraps into
 * unified SnapshotError codes (STALE_REF / UNKNOWN_REF / ELEMENT_GONE /
 * ACTION_TIMEOUT).
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId — like "e2"
 * @param {{ timeout?: number }} [opts]
 */
export async function click(page, refTable, refId, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  const locator = refTable.resolve(refId, page);
  try {
    await locator.click({ timeout });
  } catch (err) {
    // m1: wrap with refId + entry context so test output is debuggable.
    // m2 replaces with SnapshotError.actionTimeout / .elementGone etc.
    const entry = refTable.get(refId);
    throw new Error(
      `click failed on ${refId} (role=${entry?.role} name=${JSON.stringify(entry?.name)}): ${err.message}`,
      { cause: err },
    );
  }
}

/**
 * Fill text into the element identified by `refId`. Playwright's
 * locator.fill clears + types in one shot (faster than humanType's
 * char-by-char). m2 will offer humanFill as an optional opts.human=true
 * mode for stealth-sensitive ATS.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {string} value
 * @param {{ timeout?: number }} [opts]
 */
export async function fill(page, refTable, refId, value, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  const locator = refTable.resolve(refId, page);
  try {
    await locator.fill(value, { timeout });
  } catch (err) {
    const entry = refTable.get(refId);
    throw new Error(
      `fill failed on ${refId} (role=${entry?.role} name=${JSON.stringify(entry?.name)}): ${err.message}`,
      { cause: err },
    );
  }
}
