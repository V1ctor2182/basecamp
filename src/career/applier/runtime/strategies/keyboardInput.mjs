// strategies/keyboardInput.mjs
//
// 07-applier/02-playwright-runtime m4 — ladder strategy #3.
//
// Focus + type + Enter. The brute-force fallback for "search-then-pick"
// comboboxes and any input that responds to keyboard but not
// click-on-option. Many ATSes use autocomplete inputs that need
// keystrokes to surface matching options.
//
// Algorithm:
//   1. focus the locator
//   2. select-all + delete (Cmd/Ctrl+A + Backspace) to clear any
//      previous value
//   3. type the expected value at a humanized cadence (delegated to
//      humanize.mjs's humanType when available; falls back to
//      keyboard.type)
//   4. press Enter
//
// Wins when: autocomplete inputs, "type-to-select" combobox patterns.
// Misses when: control requires the listbox to be open BEFORE typing
//              (Material UI Autocomplete variant) — reactSelectClick
//              + keyboardInput compose covers that via ladder.

import { DEFAULT_STRATEGY_TIMEOUT_MS, sanitizeKeyboardInput } from './shared.mjs';

export const NAME = 'keyboard_input';

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} value
 * @param {import('@playwright/test').Page} page
 */
export async function fill(locator, value, page) {
  if (!page) {
    throw new Error('keyboard_input requires `page` for page.keyboard');
  }
  await locator.focus({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
  // Clear any pre-existing value. macOS uses Cmd, others Ctrl — try
  // ControlOrMeta which Playwright maps per-platform.
  try {
    await page.keyboard.press('ControlOrMeta+A', { delay: 0 });
    await page.keyboard.press('Backspace', { delay: 0 });
  } catch {
    // best-effort; some inputs ignore select-all (e.g. number spinner)
  }
  // [review H2] sanitize before sending — strip control chars + bidi
  // marks so prompt-injected classifier output can't blast Enter / Tab
  // through the keyboard pipe.
  const safe = sanitizeKeyboardInput(value);
  // Type the value char-by-char with a tiny delay so autocomplete
  // listboxes have time to populate.
  await page.keyboard.type(safe, { delay: 30 });
  // [review H6] Only press Enter if there's a visible listbox/menu now
  // (typing-to-select pattern). For a plain textbox in a <form>, Enter
  // SUBMITS the form — blowing through maxSubmits + burning the daily
  // job submit quota.
  const hasOpenPopup = await page.locator('[role=listbox]:visible, [role=menu]:visible').count();
  if (hasOpenPopup > 0) {
    await page.keyboard.press('Enter');
  }
  return { result: 'fill_ok' };
}
