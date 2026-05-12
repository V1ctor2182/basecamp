// Symbolic action API — LLM-facing verbs (click @eN, fill @eN "value")
// that resolve symbolic refs through RefTable to Playwright Locators.
//
// 07-applier/08-snapshot-refs-layer m1+m2.
//
// m1 shipped click + fill with plain Error wrapping. m2 adds:
//   - Pessimistic post-action invalidation (C3): every successful action
//     bumps the RefTable's generation, so remaining refs become STALE_REF.
//     Caller MUST re-snapshot() before next action. This catches SPA
//     pushState which bypasses framenavigated.
//   - Unified error codes (C4): Playwright TimeoutError / "Target closed"
//     / "resolved to 0 elements" are translated to ACTION_TIMEOUT /
//     ELEMENT_GONE via classifyPlaywrightError. SnapshotError instances
//     carry refId + role + name + hint for downstream consumption.
//
// m3 adds select / press / upload + element screenshot.

import { SnapshotError, classifyPlaywrightError, SNAPSHOT_ERROR_CODES } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Internal: execute a Playwright action and translate any error into a
 * SnapshotError. Always invalidates the RefTable AFTER the call (whether
 * the action succeeded or failed) — pessimistic per C3.
 */
async function _runAction({ page, refTable, refId, actionName, timeout }, fn) {
  // C1+L3 fix: removed dead `try { resolve } catch { throw }` wrapper —
  // resolve() throws SnapshotError directly, and we WANT those to skip
  // the post-action invalidate (UNKNOWN_REF / STALE_REF / WRONG_PAGE /
  // IFRAME_DETACHED leave the table state alone; only action-time
  // failures inside fn() should pessimistic-invalidate). The previous
  // wrapper was correct but structurally unobvious to future refactors.
  const locator = refTable.resolve(refId, page);
  try {
    await fn(locator);
  } catch (err) {
    const code = classifyPlaywrightError(err);
    const entry = refTable.get(refId);
    if (code === SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT) {
      throw SnapshotError.actionTimeout(refId, entry, actionName, timeout, err);
    }
    if (code === SNAPSHOT_ERROR_CODES.ELEMENT_GONE) {
      throw SnapshotError.elementGone(refId, entry, err);
    }
    // Unknown error pattern — re-throw original so we don't silently
    // swallow real bugs. Downstream Rooms can log + decide.
    throw err;
  } finally {
    // C3: pessimistic invalidation. Bump generation whether action
    // succeeded OR failed — failure could mean DOM mutated mid-action,
    // and we shouldn't trust the rest of the table either way.
    refTable.invalidate();
  }
}

/**
 * Click the element identified by `refId`. Pre-click waits for visibility
 * (via Playwright's locator.click auto-wait). Post-action: refTable is
 * invalidated, so subsequent ref usage requires a fresh snapshot().
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId — like "e2"
 * @param {{ timeout?: number }} [opts]
 */
export async function click(page, refTable, refId, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  return _runAction(
    { page, refTable, refId, actionName: 'click', timeout },
    (locator) => locator.click({ timeout }),
  );
}

/**
 * Fill text into the element identified by `refId`. Playwright's
 * locator.fill clears + types in one shot. Post-action invalidates table.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {string} value
 * @param {{ timeout?: number }} [opts]
 */
export async function fill(page, refTable, refId, value, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  return _runAction(
    { page, refTable, refId, actionName: 'fill', timeout },
    (locator) => locator.fill(value, { timeout }),
  );
}
