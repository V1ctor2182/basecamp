// Manual fallback browser-side highlight.
//
// 07-applier/05-non-standard-controls m4.
//
// When nonstandardFillField marks a field MANUAL (CAPTCHA, rich text,
// detection miss, etc.), it calls highlightManual to inject a red
// outline + scrollIntoView into the actual browser DOM. The dashboard
// UI (owned by 08-human-gate-tracker/02) reads the data-applier-manual
// attribute to surface the field in its approval queue with a
// "user must fill in browser" prompt.
//
// Best-effort by design: any locator-resolve failure or page.evaluate
// throw is swallowed — the user can still finish the application by
// scrolling manually if our visual hint never landed.
//
// Outline style chosen to be obvious without depending on host-page
// CSS: 3px solid red + 2px offset, plus a subtle box-shadow so the
// halo survives nested transforms. ScrollIntoView uses 'center' so
// the highlighted field lands mid-viewport even on long forms.

const MANUAL_OUTLINE = '3px solid #e53e3e';
const MANUAL_OUTLINE_OFFSET = '2px';
const MANUAL_SHADOW = '0 0 0 6px rgba(229, 62, 62, 0.18)';

/**
 * Inject the red-outline highlight on `locator`'s element and scroll
 * it to viewport center. Annotates the element with data-applier-manual
 * (a pure flag — NO user data) so the dashboard can locate the field.
 *
 * Review fix CRITICAL C3: the previous version wrote `suggestedValue`
 * into `data-applier-suggested`. That's a stored-PII / XSS surface —
 * any third-party script on the ATS page (analytics, A/B testing,
 * Workday-injected trackers) can `getAttribute('data-applier-suggested')`
 * and exfiltrate the user's email/phone/SSN/salary fragments. The
 * dashboard already has the value via the session JSON (read from the
 * backend API, not page DOM), so this attribute was redundant.
 * `suggestedValue` parameter is now ignored; kept in signature for
 * caller compatibility.
 *
 * @param {object} _page — Playwright Page (unused but kept for symmetry
 *   with clearManualHighlight + future shadow-piercing variants)
 * @param {object} locator — Playwright Locator already resolved by
 *   nonstandardFillField via table.resolve(refId, page)
 * @param {string|null} [_suggestedValue] — IGNORED (review fix C3).
 *   Caller still passes it for API stability; dashboard reads the
 *   value from session JSON instead of from page DOM.
 * @returns {Promise<boolean>} true if highlight landed, false on best-
 *   effort skip
 */
export async function highlightManual(_page, locator, _suggestedValue) {
  if (!locator || typeof locator.evaluate !== 'function') return false;
  try {
    await locator.evaluate((el, args) => {
      // Stash original outline so clearManualHighlight can restore.
      if (!el.dataset.applierOutlinePrior) {
        el.dataset.applierOutlinePrior = el.style.outline || '';
      }
      if (!el.dataset.applierShadowPrior) {
        el.dataset.applierShadowPrior = el.style.boxShadow || '';
      }
      el.style.outline = args.outline;
      el.style.outlineOffset = args.offset;
      el.style.boxShadow = args.shadow;
      // Pure flag — NO user data. Dashboard reads suggested_value from
      // the session JSON, not from this attribute (C3 fix).
      el.setAttribute('data-applier-manual', 'true');
      // ScrollIntoView is no-op if the element is detached or hidden;
      // wrap in try/catch so a transient layout error doesn't bubble.
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {
        /* ignore */
      }
    }, {
      outline: MANUAL_OUTLINE,
      offset: MANUAL_OUTLINE_OFFSET,
      shadow: MANUAL_SHADOW,
    });
    return true;
  } catch {
    // Best-effort: silently skip when the DOM evaluate can't reach the
    // element (detached frame / pre-navigation / Playwright timeout).
    return false;
  }
}

/**
 * Remove the manual highlight and restore prior outline/shadow. Used by
 * resume flow when the user confirmed the manual field and the machine
 * picks up the form again.
 *
 * @param {object} _page — Playwright Page (unused)
 * @param {object} locator
 * @returns {Promise<boolean>}
 */
export async function clearManualHighlight(_page, locator) {
  if (!locator || typeof locator.evaluate !== 'function') return false;
  try {
    await locator.evaluate((el) => {
      el.style.outline = el.dataset.applierOutlinePrior || '';
      el.style.outlineOffset = '';
      el.style.boxShadow = el.dataset.applierShadowPrior || '';
      delete el.dataset.applierOutlinePrior;
      delete el.dataset.applierShadowPrior;
      el.removeAttribute('data-applier-manual');
      // data-applier-suggested no longer written (C3 fix); remove
      // unconditionally to clean up if older agents wrote it.
      el.removeAttribute('data-applier-suggested');
    });
    return true;
  } catch {
    return false;
  }
}
