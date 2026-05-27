// strategies/selectOption.mjs
//
// 07-applier/02-playwright-runtime m4 — ladder strategy #1.
//
// Native <select> + <option> path. Playwright's locator.selectOption()
// accepts the option's value, label, or index; we pass the expected
// VALUE (text) since classifier output is the visible label.
//
// Wins when:
//   - HTML form uses native <select multiple/> or <select>
//   - Classifier's expected value matches an exact option.label/value
//
// Misses when:
//   - React-Select / Headless UI / aria-combobox (no native <select>)
//   - Option label is fuzzy (e.g. "Decline" vs "Decline To Self Identify")

import { DEFAULT_STRATEGY_TIMEOUT_MS } from './shared.mjs';

export const NAME = 'selectOption';

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} value
 * @returns {Promise<{ result: 'fill_ok' }>} — throws on failure.
 */
export async function fill(locator, value) {
  await locator.selectOption(String(value), { timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  return { result: 'fill_ok' };
}
