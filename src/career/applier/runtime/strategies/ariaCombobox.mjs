// strategies/ariaCombobox.mjs
//
// 07-applier/02-playwright-runtime m4 — ladder strategy #5 (last
// fallback).
//
// ARIA combobox pattern with `aria-activedescendant` — fully
// accessibility-spec-compliant. The combobox doesn't expose
// role=option until focused; once focused, options appear via the
// activedescendant chain. Algorithm:
//
//   1. focus the combobox
//   2. type the value to filter
//   3. await aria-activedescendant pointing at a matching option
//   4. press Enter (commits the highlighted option)
//
// Distinct from keyboardInput (#3) because we WAIT for the
// activedescendant pointer before committing — strategy #3 just
// blasts the value and presses Enter optimistically.
//
// Wins when: well-implemented WAI-ARIA Authoring Practices comboboxes
// (some accessible Greenhouse / Lever forms).
// Misses when: the combobox doesn't update activedescendant on type
// (broken accessibility) — then keyboardInput #3 is the right pick,
// and the ladder ordering means we tried that already.

import { DEFAULT_STRATEGY_TIMEOUT_MS, sanitizeKeyboardInput } from './shared.mjs';

export const NAME = 'aria_combobox';

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} value
 * @param {import('@playwright/test').Page} page
 */
export async function fill(locator, value, page) {
  if (!page) {
    throw new Error('aria_combobox requires `page` for page.keyboard + waiter');
  }
  await locator.focus({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  // [review H2] sanitize input before keyboard.type
  const safe = sanitizeKeyboardInput(value);
  // Type with filter delay
  await page.keyboard.type(safe, { delay: 30 });
  // Await aria-activedescendant pointing somewhere (non-empty). Bound
  // the wait — if the combobox doesn't update the attribute we want
  // to fail fast, not hang the whole submit loop.
  await locator.evaluate(async (el, deadline) => {
    const start = Date.now();
    while (Date.now() - start < deadline) {
      const ad = el.getAttribute('aria-activedescendant');
      if (ad && ad.length > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('aria_combobox: aria-activedescendant never populated');
  }, DEFAULT_STRATEGY_TIMEOUT_MS);
  await page.keyboard.press('Enter');
  return { result: 'fill_ok' };
}
