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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SnapshotError, classifyPlaywrightError, SNAPSHOT_ERROR_CODES } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

// Whitelist of keyboard keys press() will accept. Locks the LLM out of
// arbitrary key sequences (modifier combos could trigger browser
// shortcuts that escape our control surface — e.g. Ctrl+T new tab).
// Q3 from locked OQs covers the rest; this is the closed set.
const ALLOWED_KEYS = Object.freeze([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Space',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const ALLOWED_KEYS_SET = new Set(ALLOWED_KEYS);

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
    // H5 fix from holistic review: route OPTION_NOT_FOUND for select() misses.
    // We don't have the option arg here, but the Playwright error message
    // already includes it; factory preserves the cause for downstream parse.
    if (code === SNAPSHOT_ERROR_CODES.OPTION_NOT_FOUND) {
      throw SnapshotError.optionNotFound(refId, entry, '(see cause)', err);
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

/**
 * Select an option in a combobox / <select> element. C2 fix from review:
 * accepts string (defaults to label match) OR tagged object {label} /
 * {value} / {index} for ATS forms where value differs from visible label.
 * Refuses early with ROLE_MISMATCH if the ref's role isn't combobox.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {string | { label?: string, value?: string, index?: number }} option
 * @param {{ timeout?: number }} [opts]
 */
export async function select(page, refTable, refId, option, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  // H2 fix from review: explicit precedence. If entry is undefined (unknown
  // ref), fall through to _runAction so resolve() throws UNKNOWN_REF
  // rather than ROLE_MISMATCH. If entry exists with wrong role, throw
  // ROLE_MISMATCH; refTable not invalidated (caller error before action).
  const entry = refTable.get(refId);
  if (entry !== undefined && entry.role !== 'combobox') {
    throw SnapshotError.roleMismatch(refId, entry, 'combobox', 'select');
  }
  // C2 fix: normalize option to Playwright's selectOption argument shape
  let selector;
  if (typeof option === 'string') {
    selector = { label: option };
  } else if (option && typeof option === 'object') {
    if (option.value !== undefined) selector = { value: option.value };
    else if (option.index !== undefined) selector = { index: option.index };
    else if (option.label !== undefined) selector = { label: option.label };
    else throw new TypeError('select: option object must have label/value/index');
  } else {
    throw new TypeError('select: option must be a string or { label | value | index }');
  }
  return _runAction(
    { page, refTable, refId, actionName: 'select', timeout },
    (locator) => locator.selectOption(selector, { timeout }),
  );
}

/**
 * Press a whitelisted key on the focused element. Rejects modifier combos
 * + arbitrary keys to prevent the LLM from triggering browser shortcuts.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {string} key — must be in ALLOWED_KEYS
 * @param {{ timeout?: number }} [opts]
 */
export async function press(page, refTable, refId, key, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  if (!ALLOWED_KEYS_SET.has(key)) {
    // H1 fix: use factory for code/message/hint coherence
    throw SnapshotError.keyNotAllowed(refId, key, ALLOWED_KEYS);
  }
  return _runAction(
    { page, refTable, refId, actionName: 'press', timeout },
    (locator) => locator.press(key, { timeout }),
  );
}

/**
 * Upload a file to a file input identified by `refId`. V1: only supports
 * <input type="file">. Drag-drop dropzones (Workday-style) are deferred
 * to 06-site-adapters per locked Q5.
 *
 * Verifies the file path is absolute + the file exists before invoking
 * setInputFiles so the error message stays meaningful (vs Playwright's
 * generic "ENOENT" / cryptic context).
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {string} filePath — absolute path to the file
 * @param {{ timeout?: number }} [opts]
 */
/**
 * Check a checkbox / radio identified by `refId`. Uses Playwright's
 * locator.check() which auto-waits + verifies the post-state — robust
 * against fancy ATS-styled toggles that swallow plain `click`. H3 fix
 * from holistic review — was a known reliability hole on Greenhouse
 * EEO consent checkboxes when downstream Rooms tried plain `click()`.
 *
 * Refuses early with ROLE_MISMATCH if the ref's role isn't checkbox
 * or radio.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {{ timeout?: number }} [opts]
 */
export async function check(page, refTable, refId, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  const entry = refTable.get(refId);
  if (entry !== undefined && !['checkbox', 'radio'].includes(entry.role)) {
    throw SnapshotError.roleMismatch(refId, entry, 'checkbox|radio', 'check');
  }
  return _runAction(
    { page, refTable, refId, actionName: 'check', timeout },
    (locator) => locator.check({ timeout }),
  );
}

/**
 * Uncheck a checkbox identified by `refId`. Mirror of check() — radios
 * are not unchecked individually (selecting another radio replaces),
 * so this is checkbox-only.
 *
 * @param {import('playwright').Page} page
 * @param {import('./refTable.mjs').RefTable} refTable
 * @param {string} refId
 * @param {{ timeout?: number }} [opts]
 */
export async function uncheck(page, refTable, refId, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  const entry = refTable.get(refId);
  if (entry !== undefined && entry.role !== 'checkbox') {
    throw SnapshotError.roleMismatch(refId, entry, 'checkbox', 'uncheck');
  }
  return _runAction(
    { page, refTable, refId, actionName: 'uncheck', timeout },
    (locator) => locator.uncheck({ timeout }),
  );
}

export async function upload(page, refTable, refId, filePath, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS } = opts;
  // M5 fix from review: check ref FIRST so unknown/stale refs surface
  // their proper error code (UNKNOWN_REF / STALE_REF) instead of a
  // misleading "file not accessible" path-validation error.
  if (!refTable.has(refId)) {
    throw SnapshotError.unknownRef(refId);
  }
  // Path validation BEFORE _runAction — caller errors don't invalidate.
  // H1 fix: factories instead of inline construction.
  if (!path.isAbsolute(filePath)) {
    throw SnapshotError.uploadFailed(refId, filePath, 'path is not absolute');
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw SnapshotError.uploadFailed(refId, filePath, 'not a regular file (directory or symlink-to-missing)');
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw SnapshotError.uploadFailed(refId, filePath, `not accessible (${err.message})`, err);
  }
  return _runAction(
    { page, refTable, refId, actionName: 'upload', timeout },
    (locator) => locator.setInputFiles(filePath, { timeout }),
  );
}
