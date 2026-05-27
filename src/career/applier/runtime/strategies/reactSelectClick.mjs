// strategies/reactSelectClick.mjs
//
// 07-applier/02-playwright-runtime m4 — ladder strategy #2.
//
// React-Select / Headless UI / Material-UI Select pattern. The control
// element ("button"-ish or "div role=combobox") opens a portal-mounted
// listbox with role=option items. selectOption() can't see this because
// there's no underlying <select>.
//
// Algorithm:
//   1. Click the locator (opens the dropdown)
//   2. Look for any visible role=option whose text matches expected
//      (page-scoped, since the listbox is usually portal-mounted outside
//      the original control)
//   3. Click it
//
// Wins when: Greenhouse EEO, modern SaaS forms with custom selects.
// Misses when: the dropdown requires keyboard input first (search +
//              select pattern) — keyboardInput strategy handles that.

import { DEFAULT_STRATEGY_TIMEOUT_MS } from './shared.mjs';

export const NAME = 'react_select_click';

/**
 * @param {import('@playwright/test').Locator} locator — the React-Select control
 * @param {string} value
 * @param {import('@playwright/test').Page} page — needed for portal-mounted options
 */
export async function fill(locator, value, page) {
  if (!page) {
    throw new Error('react_select_click requires `page` (portal options are page-scoped)');
  }
  // 1. Open the dropdown
  await locator.click({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  // [review H5] Wait for the portal-mounted listbox to actually appear
  // before resolving options. React-Select / MUI portal-mount via
  // setTimeout/RAF; without this barrier, getByRole returns no matches
  // OR matches a stale option from a prior open. 1s ceiling — failure
  // here means "click did not open anything" (probably wrong control
  // type) → caller's per-strategy 3s budget swallows the rest.
  try {
    await page.locator('[role=listbox]:visible, [role=menu]:visible').first()
      .waitFor({ state: 'visible', timeout: 1_000 });
  } catch {
    // Listbox never appeared. Continue anyway — getByRole below will
    // throw with a more informative error message after its own
    // timeout, which classifyPlaywrightError will translate.
  }
  // 2. Find the option. [review M5] Try exact match first to avoid
  //    .first() silently picking the wrong "Yes, I am a veteran" vs
  //    "Yes, I am not a veteran" when expected is "Yes, I am not...".
  //    Fall back to fuzzy (the original behavior) so "Decline" still
  //    matches "Decline To Self Identify".
  const want = String(value);
  let option = page.getByRole('option', { name: want, exact: true }).first();
  if ((await option.count()) === 0) {
    option = page.getByRole('option', { name: want, exact: false }).first();
  }
  // 3. Click. If not found within timeout, Playwright throws — caller
  //    classifies via classifyPlaywrightError.
  await option.click({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  return { result: 'fill_ok' };
}
