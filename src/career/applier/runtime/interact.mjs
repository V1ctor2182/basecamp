// interact.mjs
//
// 07-applier/02-playwright-runtime m6 — Apply.tsx UI primitive #2 + #3.
//
//   focusField(page, locator)
//     Smooth-scroll the field into view, paint a 2px red outline,
//     and shift keyboard focus to it. Used when Apply.tsx wants to
//     show the user "fix THIS field" — the outline persists until
//     clearFocusField() or page reload.
//
//   clearFocusField(page, locator)
//     Remove the outline marker (does not unfocus the element).
//
//   resetField(page, locator, kind?)
//     Auto-detected field reset. Used when Apply.tsx wants to undo
//     a bad fill before Mode 2 retries. `kind` is an optional hint;
//     auto-detection covers the common cases.
//
// Locked OQs (per plan-milestones session 2026-05-27):
//   - P2-OQ9: focus outline = 2px solid #d33 + 2px offset (red)
//   - P2-OQ10: custom-widget (role=combobox) reset uses
//     Focus + Ctrl+A + Delete + blur (Cmd+A on macOS via Playwright
//     auto-mapping)

import { DEFAULT_STRATEGY_TIMEOUT_MS } from './strategies/shared.mjs';

const FOCUS_ATTR = 'data-applier-focus';

/** [P2-OQ9] Red 2px outline applied to the currently-focused field.
 *  Injected once per page via addStyleTag (idempotent — repeat
 *  attempts re-inject which is fine; CSS de-dupes by content). */
export const FOCUS_OUTLINE_CSS = `
  [${FOCUS_ATTR}] {
    outline: 2px solid #d33 !important;
    outline-offset: 2px !important;
    transition: outline-color 0.15s ease;
  }
`;

/**
 * Smooth-scroll the field into viewport center, paint a focus outline,
 * shift keyboard focus to it.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 */
export async function focusField(page, locator) {
  if (!page) throw new Error('focusField: page required');
  if (!locator) throw new Error('focusField: locator required');

  // 1. Inject the outline style. [review H1] No per-page dedup — SPA
  //    route changes blow away injected <style> tags, and a stale
  //    WeakMap flag would silently skip re-injection. Idempotent CSS
  //    + always-on inline fallback (step 3) keeps the outline visible
  //    even when CSP blocks addStyleTag.
  let styleInjected = false;
  try {
    await page.addStyleTag({ content: FOCUS_OUTLINE_CSS });
    styleInjected = true;
  } catch { /* CSP blocked — inline fallback in step 3 carries the outline */ }

  // 2. Resolve to a single element and scroll into view smoothly.
  await locator.first().evaluate((el) => {
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch {
      el.scrollIntoView();  // older browsers — non-smooth fallback
    }
  });

  // 3. Mark with focus attribute. Apply inline-style outline whenever
  //    addStyleTag is blocked (CSP) — cheap, idempotent.
  await locator.first().evaluate((el, applied) => {
    el.setAttribute('data-applier-focus', '1');
    if (!applied) {
      el.style.outline = '2px solid #d33';
      el.style.outlineOffset = '2px';
    }
  }, styleInjected);

  // 4. focus() the element if it's actually focusable. Non-focusable
  //    targets (e.g., a wrapper div on a custom select) silently skip.
  const focusable = await locator.first().evaluate((el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea', 'button', 'a'].includes(tag)) return true;
    if (el.hasAttribute('tabindex')) return true;
    if (el.isContentEditable) return true;
    return false;
  });
  if (focusable) {
    try { await locator.first().focus({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS }); }
    catch { /* element not visible / detached — skip */ }
  }
}

/**
 * Remove the focus outline. Idempotent — calling on an unmarked element
 * is a no-op.
 *
 * @param {import('playwright').Page} _page  (kept for API symmetry; unused)
 * @param {import('playwright').Locator} locator
 */
export async function clearFocusField(_page, locator) {
  if (!locator) throw new Error('clearFocusField: locator required');
  await locator.first().evaluate((el) => {
    el.removeAttribute('data-applier-focus');
    // also clear inline-style fallback set by focusField when CSP blocked addStyleTag
    try {
      if (el.style.outline === '2px solid #d33' || /2px solid (rgb\(221, 51, 51\)|#d33)/i.test(el.style.outline || '')) {
        el.style.outline = '';
        el.style.outlineOffset = '';
      }
    } catch { /* not an HTMLElement — skip */ }
  });
}

/** Field kinds resetField understands. */
export const FIELD_KINDS = Object.freeze([
  'text', 'email', 'tel', 'textarea', 'select', 'file', 'combobox',
]);

/**
 * Reset a field's value to empty.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 * @param {('text'|'email'|'tel'|'textarea'|'select'|'file'|'combobox')=} kind
 */
export async function resetField(page, locator, kind) {
  if (!page) throw new Error('resetField: page required');
  if (!locator) throw new Error('resetField: locator required');

  const detected = kind || await detectFieldKind(locator);

  switch (detected) {
    case 'text':
    case 'email':
    case 'tel':
    case 'textarea':
      await locator.first().fill('', { timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
      return;

    case 'select':
      await locator.first().selectOption({ index: 0 }, { timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
      return;

    case 'file':
      await locator.first().setInputFiles([], { timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
      return;

    case 'combobox':
      // [P2-OQ10] custom widget reset: focus + select all + delete + blur.
      // Use 'ControlOrMeta' so Playwright maps Cmd/Ctrl per OS.
      await locator.first().focus({ timeout: DEFAULT_STRATEGY_TIMEOUT_MS });
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Delete');
      await locator.first().evaluate((el) => { try { el.blur?.(); } catch { /* not focusable */ } });
      // [review H2] Verify the reset actually cleared. Non-contenteditable
      // role=combobox widgets (React-Select trigger) eat the Ctrl+A
      // silently — caller would otherwise see "reset reported success
      // but value still set" and the loop's same-error-twice guard would
      // halt with confusing telemetry. Surface the failure here.
      {
        const remaining = await locator.first().evaluate((el) => {
          const v = el.value ?? el.textContent ?? '';
          return String(v).trim();
        });
        if (remaining.length > 0) {
          throw new Error(
            `resetField: combobox keyboard sequence did not clear value (still "${remaining.slice(0, 40)}"); ` +
            `widget may need a custom clear action — pass an explicit kind override or wire a Phase 6 adapter strategy.`,
          );
        }
      }
      return;

    default:
      // Best-effort fallback: try fill('') then selectOption(index 0).
      // [review H3] On failure, surface the locator's tag + role so the
      // caller can diagnose without re-running with extra logging.
      try { await locator.first().fill('', { timeout: DEFAULT_STRATEGY_TIMEOUT_MS }); return; } catch { /* fall through */ }
      try { await locator.first().selectOption({ index: 0 }, { timeout: DEFAULT_STRATEGY_TIMEOUT_MS }); return; } catch { /* fall through */ }
      const inspect = await locator.first().evaluate((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        contentEditable: el.isContentEditable,
      })).catch(() => null);
      throw new Error(
        `resetField: cannot reset field of detected kind "${detected}" — ` +
        `element=${JSON.stringify(inspect)}. Pass explicit kind hint or wrap a different locator.`,
      );
  }
}

/** Inspect the locator's element to determine the appropriate reset
 *  strategy. Best-effort — caller can pass `kind` to override. */
export async function detectFieldKind(locator) {
  return await locator.first().evaluate((el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'file') return 'file';
      if (type === 'email') return 'email';
      if (type === 'tel') return 'tel';
      // text / search / url / number / password / etc. all share the
      // fill('') reset path — bucket under 'text'.
      return 'text';
    }
    // Custom widgets: role=combobox (React-Select, Headless UI, etc.)
    if (el.getAttribute('role') === 'combobox') return 'combobox';
    // contenteditable divs also need the combobox path (Ctrl+A + Delete)
    if (el.isContentEditable) return 'combobox';
    return 'unknown';
  });
}
