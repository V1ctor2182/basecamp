// strategies/roleLocatorClick.mjs
//
// 07-applier/02-playwright-runtime m4 — ladder strategy #4.
//
// ARIA-pure approach. The control already has role=listbox / role=menu
// visible by default (no separate open step), and the options are
// direct accessible-tree children with role=option. Just click the
// matching option by accessible name — no clicking-to-open required.
//
// Wins when: form is built with semantic ARIA from the ground up
// (well-maintained component libraries; some Greenhouse legacy forms).
// Misses when: options aren't in the accessibility tree until the
// control is opened (most modern Headless UI variants — those need
// strategy #2 or #5).

import { DEFAULT_STRATEGY_TIMEOUT_MS } from './shared.mjs';

export const NAME = 'role_locator_click';

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} value
 * @param {import('@playwright/test').Page} page
 */
export async function fill(locator, value, page) {
  if (!page) {
    throw new Error('role_locator_click requires `page` for getByRole');
  }
  // Resolve the option via getByRole + accessible name. [review M5]
  // Try exact first to avoid "Yes" matching "Yes, I have ..."
  // ambiguously; fall back to fuzzy so "Decline" still matches
  // "Decline To Self Identify".
  const want = String(value);
  let option = page.getByRole('option', { name: want, exact: true }).first();
  if ((await option.count()) === 0) {
    option = page.getByRole('option', { name: want, exact: false }).first();
  }
  await option.click({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  return { result: 'fill_ok' };
}
