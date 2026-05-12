// Human-like interaction helpers — random delays, char-by-char typing,
// pre-click think-time + visibility wait.
//
// 07-applier/02-playwright-runtime m2.
//
// Stateless utilities. NO dependency on browser.mjs (avoid circular). All
// helpers compose with Playwright Locators (not Pages) for API consistency
// — except humanNavigate which is intrinsically page-scoped. (M1 fix from
// review: pick one shape; locator-first wins because downstream Rooms
// drive everything through @ref → Locator anyway.)
//
// Per Room constraint: page interactions MUST have 100-400ms random delays.
// Defaults below match that bound; callers override per-action when an
// ATS tunes (Workday tolerates faster typing, Greenhouse seems to flag
// rapid clicks).
//
// m2 ships the primitives. m3 doesn't touch this file. Future Room
// 03-field-classifier may add domain-specific composites (humanFillForm)
// but those belong there.

// Grapheme-cluster segmenter for safe Unicode typing — emoji ZWJ sequences
// (👨‍👩‍👧), regional-indicator flags (🇺🇸 = 2 codepoints), and NFD-
// normalized accents (`é` = "e" + "\u0301") must NOT be split, or input
// validators reject the intermediate strings. (C1 fix from review.) Node
// 18+ ships Intl.Segmenter universally.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * Pause for a random duration between `min` and `max` milliseconds (uniform).
 * Swapped / negative / NaN inputs clamp to a safe [0, max(0, finite)] range.
 *
 * @param {number} [min=100]
 * @param {number} [max=400]
 * @returns {Promise<void>}
 */
export function humanDelay(min = 100, max = 400) {
  // M3 fix: NaN guard — Math.min/max propagate NaN silently, setTimeout(NaN)
  // fires immediately, which would mask broken caller code.
  const a = Number.isFinite(min) ? min : 100;
  const b = Number.isFinite(max) ? max : 400;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(0, Math.max(a, b));
  const ms = lo + Math.random() * (hi - lo);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type text into the element identified by `locator`, char-by-char with
 * per-char random delays. Focuses the locator first so caller doesn't need
 * a separate focus step. Empty text is a no-op.
 *
 * Uses Intl.Segmenter for grapheme-level iteration — emoji ZWJ sequences
 * and combining-accent NFD strings type atomically (single keyboard.type
 * call per grapheme), so on-input validators don't see broken intermediate
 * strings. (C1 fix.)
 *
 * @param {import('playwright').Locator} locator
 * @param {string} text
 * @param {{ minDelay?: number, maxDelay?: number }} [opts]
 */
export async function humanType(locator, text, opts = {}) {
  const { minDelay = 50, maxDelay = 150 } = opts;
  if (!text) return; // empty: no-op (corner case)
  await locator.focus();
  const page = locator.page();
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    await page.keyboard.type(segment);
    await humanDelay(minDelay, maxDelay);
  }
}

/**
 * Click the locator with a pre-click "think time" pause. Waits for element
 * visibility FIRST so the random delay isn't wasted clock time on a not-yet-
 * rendered element — humans pause AFTER seeing the element, not before.
 * (H4 fix + M2 — gives humanClick a real reason to exist beyond renaming.)
 *
 * @param {import('playwright').Locator} locator
 * @param {{ minDelay?: number, maxDelay?: number, timeout?: number }} [opts]
 */
export async function humanClick(locator, opts = {}) {
  const { minDelay = 200, maxDelay = 500, timeout = 10_000 } = opts;
  await locator.waitFor({ state: 'visible', timeout });
  await humanDelay(minDelay, maxDelay);
  await locator.click();
}

/**
 * Navigate to a URL and pause to simulate human reading. The `waitUntil`
 * option lets callers escalate from `domcontentloaded` (default — fast,
 * fits the 800-1500ms budget) to `networkidle` for iframe-heavy ATS
 * (Workday, Greenhouse) where DCL fires before the apply form is mounted.
 * (H2 fix from review.)
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{
 *   minDelay?: number,
 *   maxDelay?: number,
 *   waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' | 'commit',
 *   timeout?: number,
 * }} [opts]
 */
export async function humanNavigate(page, url, opts = {}) {
  const {
    minDelay = 800,
    maxDelay = 1500,
    waitUntil = 'domcontentloaded',
    timeout = 30_000,
  } = opts;
  await page.goto(url, { waitUntil, timeout });
  await humanDelay(minDelay, maxDelay);
}
