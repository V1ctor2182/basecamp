// Total-step probing + Next button resolution for Mode 2 multi-step
// state machine.
//
// 07-applier/04-multi-step-state-machine m2.
//
// Three fallback strategies for probeTotalSteps (locked at planning):
//   1) progressbar valuetext: role=progressbar with aria-valuetext
//      matching /step \d+ of (\d+)/i → return captured M
//   2) sidebar enumeration: count listitem children of the step list
//      (aria-label containing 'steps' / adapter.stepListHints)
//   3) exploratory: return null + source='exploratory'; m3 advances
//      until findNextButton returns null
//
// All functions accept a `page` object that implements a subset of
// Playwright's Page interface — production passes a real Page; smoke
// injects a mock with the same shape. This keeps the smoke pure-Node
// (no Chromium spawn).
//
// Mock interface contract (smoke-friendly):
//   page.getByRole(role, opts?) → Locator
//   page.locator(selector) → Locator
// Locator:
//   .count() → Promise<number>
//   .first() → Locator (or self if no .first method)
//   .nth(idx) → Locator
//   .getAttribute(name) → Promise<string|null>
//   .textContent() → Promise<string|null>
//   .isVisible() → Promise<bool>

import { getAdapter } from './siteAdapter.mjs';

// Bounded so a hung page can't stall the machine. m3 wraps in its own
// step-level timeout but defense in depth is cheap here.
const LOCATOR_TIMEOUT_MS = 5000;

/**
 * Race a promise against a timeout. Used so a misbehaving Locator that
 * never resolves can't hang the probe.
 */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Strategy 1: read aria-valuetext from a role=progressbar element.
 * Looks for substrings like "Step 3 of 7" / "page 2 of 5" / "3/7".
 *
 * @param {object} page
 * @returns {Promise<{ current?: number, total: number } | null>}
 */
export async function probeProgressBar(page) {
  let count;
  try {
    const loc = page.getByRole('progressbar');
    count = await withTimeout(loc.count(), LOCATOR_TIMEOUT_MS, 'progressbar.count');
  } catch {
    return null;
  }
  if (!count || count < 1) return null;
  for (let i = 0; i < count; i++) {
    const node = page.getByRole('progressbar').nth(i);
    let text = null;
    // Try aria-valuetext (most common on Workday), then aria-valuenow/max
    try {
      text = await withTimeout(node.getAttribute('aria-valuetext'), LOCATOR_TIMEOUT_MS, 'progressbar.valuetext');
    } catch {}
    if (text) {
      const m = text.match(/(?:step|page)\s*(\d+)\s*(?:of|\/)\s*(\d+)/i);
      if (m) {
        const cur = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        // H2 fix from review: enforce cur ≤ tot ≥ 1 invariant; garbage
        // values (server bug / stale snapshot) fall through to next
        // strategy rather than poisoning m3's loop invariants.
        if (cur >= 1 && tot >= 1 && cur <= tot) return { current: cur, total: tot };
      }
      const m2 = text.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
      if (m2) {
        const cur = parseInt(m2[1], 10);
        const tot = parseInt(m2[2], 10);
        if (cur >= 1 && tot >= 1 && cur <= tot) return { current: cur, total: tot };
      }
    }
    // Fallback: aria-valuenow + aria-valuemax
    try {
      const [now, max] = await Promise.all([
        withTimeout(node.getAttribute('aria-valuenow'), LOCATOR_TIMEOUT_MS, 'progressbar.valuenow'),
        withTimeout(node.getAttribute('aria-valuemax'), LOCATOR_TIMEOUT_MS, 'progressbar.valuemax'),
      ]);
      const nowN = now != null ? parseInt(now, 10) : NaN;
      const maxN = max != null ? parseInt(max, 10) : NaN;
      // H2: same current ≤ total guard for the numeric path
      if (
        Number.isFinite(nowN) &&
        Number.isFinite(maxN) &&
        nowN >= 1 &&
        maxN >= 1 &&
        nowN <= maxN
      ) {
        return { current: nowN, total: maxN };
      }
    } catch {}
  }
  return null;
}

/**
 * Strategy 2: count listitem children of the application-steps sidebar.
 * Tries adapter.stepListHints as aria-label substrings.
 *
 * @param {object} page
 * @param {object} adapter — descriptor from getAdapter()
 * @returns {Promise<{ total: number } | null>}
 */
export async function probeStepList(page, adapter) {
  const hints = adapter.stepListHints || [];
  for (const hint of hints) {
    // M3 fix from review: escapeRegex(hint) — symmetric with findNextButton.
    // Defensive against future hints containing regex metacharacters.
    // M2 fix from review: hoist the locator so we don't re-issue the list
    // query twice per hint (one Playwright roundtrip vs two on real Pages).
    let list;
    let listCount = 0;
    try {
      list = page.getByRole('list', { name: new RegExp(escapeRegex(hint), 'i') });
      listCount = await withTimeout(list.count(), LOCATOR_TIMEOUT_MS, `list:${hint}.count`);
    } catch {
      continue;
    }
    if (!listCount) continue;
    try {
      // list.first().getByRole('listitem') scopes to descendants of the
      // first matching list (Playwright contract); does NOT escape to
      // page-wide listitems.
      const items = list.first().getByRole('listitem');
      const n = await withTimeout(items.count(), LOCATOR_TIMEOUT_MS, `listitem:${hint}.count`);
      if (n && n >= 1) return { total: n };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Combined probe: try strategy 1 → 2 → exploratory.
 *
 * Contract (M5): `total === null` is the AUTHORITATIVE signal for
 * exploratory mode; `source` is informational telemetry. The invariant
 * `source === 'exploratory' ⇔ total === null` is maintained by this
 * implementation but m3 should branch on `total === null`, not source.
 *
 * @param {object} page
 * @param {string|object} adapterIdOrDescriptor
 * @returns {Promise<{ total: number|null, current?: number, source: 'progressbar'|'sidebar'|'exploratory' }>}
 */
export async function probeTotalSteps(page, adapterIdOrDescriptor) {
  const adapter = typeof adapterIdOrDescriptor === 'string'
    ? getAdapter(adapterIdOrDescriptor)
    : adapterIdOrDescriptor;

  const pb = await probeProgressBar(page).catch(() => null);
  if (pb && pb.total >= 1) {
    return { total: pb.total, current: pb.current, source: 'progressbar' };
  }
  const sl = await probeStepList(page, adapter).catch(() => null);
  if (sl && sl.total >= 1) {
    return { total: sl.total, source: 'sidebar' };
  }
  return { total: null, source: 'exploratory' };
}

/**
 * Find a clickable "Next" button on the current page. Tries each of the
 * adapter's nextButtonHints in order; returns the first visible match.
 *
 * @param {object} page
 * @param {string|object} adapterIdOrDescriptor
 * @returns {Promise<{ locator: object, hint: string } | null>}
 */
export async function findNextButton(page, adapterIdOrDescriptor) {
  const adapter = typeof adapterIdOrDescriptor === 'string'
    ? getAdapter(adapterIdOrDescriptor)
    : adapterIdOrDescriptor;
  for (const hint of adapter.nextButtonHints) {
    let cand;
    let candCount = 0;
    try {
      cand = page.getByRole('button', { name: new RegExp(`^${escapeRegex(hint)}$`, 'i') });
      candCount = await withTimeout(cand.count(), LOCATOR_TIMEOUT_MS, `button:${hint}.count`);
    } catch {
      continue;
    }
    if (!candCount) continue;
    // Pick the first visible candidate (multi-step forms can render
    // disabled/hidden duplicates of Next).
    // L1 fix from review: cap iteration at actual count — don't issue
    // wasted isVisible() roundtrips against empty Locators.
    for (let i = 0; i < Math.min(candCount, 5); i++) {
      const node = cand.nth(i);
      let visible = false;
      try {
        visible = await withTimeout(node.isVisible(), LOCATOR_TIMEOUT_MS, `button:${hint}.isVisible[${i}]`);
      } catch {}
      if (visible) return { locator: node, hint };
    }
  }
  return null;
}

/**
 * Heuristic: is the currently-visible primary action a Submit (terminal
 * step)? Used by the state machine to know when to stop the STEP_LOOP
 * and present the "ready to submit" prompt.
 *
 * @param {object} page
 * @param {string|object} adapterIdOrDescriptor
 * @returns {Promise<boolean>}
 */
export async function isOnSubmitStep(page, adapterIdOrDescriptor) {
  const adapter = typeof adapterIdOrDescriptor === 'string'
    ? getAdapter(adapterIdOrDescriptor)
    : adapterIdOrDescriptor;
  for (const hint of adapter.submitHints) {
    try {
      // H1 fix from review: anchor the regex (symmetric with findNextButton).
      // Without anchors, hint='Apply' false-matches "Apply Filter" / "Apply
      // Now" buttons on intermediate / pre-application pages, killing the
      // STEP_LOOP before reaching the real submit step.
      const loc = page.getByRole('button', { name: new RegExp(`^${escapeRegex(hint)}$`, 'i') });
      const n = await withTimeout(loc.count(), LOCATOR_TIMEOUT_MS, `submit:${hint}.count`);
      if (n >= 1) {
        const visible = await withTimeout(
          loc.first().isVisible(),
          LOCATOR_TIMEOUT_MS,
          `submit:${hint}.isVisible`,
        );
        if (visible) return true;
      }
    } catch {}
  }
  return false;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { LOCATOR_TIMEOUT_MS };
