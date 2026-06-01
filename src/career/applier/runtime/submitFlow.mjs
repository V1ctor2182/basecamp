// submitFlow.mjs
//
// 07-applier/02-playwright-runtime m5 — submit-first loop 的三件套
// 提交 + 探测原语:
//
//   1) submitForm(page, adapter?, opts?)
//        Click the submit button and race for the next observable state.
//        Outcomes: 'submitted' | 'has_errors' | 'next_step' | 'timeout'.
//   2) parseFormErrors(page, adapter?)
//        Scan the page for visible inline form errors. Returns the
//        normalized list [{field, error_code, error_msg}].
//   3) detectSubmitSuccess(page, adapter?, opts?)
//        Boolean — was the application accepted? Combines URL pattern,
//        thank-you text, and (optional) network signal.
//
// Consumed by 04-multi-step-state-machine m6 SUBMITTING + PARSING_ERRORS
// states (post-fill-handoff-ux Phase 1).
//
// Locked OQs (per plan-milestones session 2026-05-27):
//   - P2-OQ5: parseFormErrors no-error → returns [] (not throw)
//   - P2-OQ6: submitForm hard timeout 90s, aligned to Phase 1/OQ9
//   - Adapter overrides ship as the override hook only; real per-ATS
//     YAML wiring lands in Phase 6.

import { humanClick } from './humanize.mjs';

/** P2-OQ6 + Phase 1/OQ9 — submit race hard timeout (90s). */
export const SUBMIT_TIMEOUT_MS = 90_000;

/** Cheapest-first list of submit button name hints. Adapter override
 *  via `adapter.submit_button.name_hints`. */
export const DEFAULT_SUBMIT_NAME_HINTS = Object.freeze([
  'Submit Application',
  'Submit application',
  'Submit',
  'Apply',
]);

/** Cross-ATS inline error selectors (per Phase 1/OQ4). Adapter
 *  override via `adapter.error_selectors`. */
export const DEFAULT_ERROR_SELECTORS = Object.freeze([
  '[role=alert]',
  '.error',
  '.field-error',
  '.help-block.is-invalid',
]);

/** Default next-step DOM markers (single-page wizard next-step appears
 *  without URL change). Adapter override via `adapter.next_step_selectors`. */
export const DEFAULT_NEXT_STEP_SELECTORS = Object.freeze([
  '[aria-current="step"]',
  '[data-current-step]',
]);

/** Default success URL regexes — matched against page.url() in
 *  detectSubmitSuccess. */
export const DEFAULT_SUCCESS_URL_PATTERNS = Object.freeze([
  /\/thank[-_]?you/i,
  /\/confirmation/i,
  /\/success/i,
  /\/applied/i,
]);

/** Default success body text. Adapter override via `adapter.success_text`. */
export const DEFAULT_SUCCESS_TEXT = Object.freeze([
  'Thank you',
  'Application received',
  "We've received your application",
]);

/**
 * Click the submit button and race for the next observable state.
 *
 * @param {import('playwright').Page} page
 * @param {{ submit_button?: { name_hints?: string[] }, error_selectors?: string[], next_step_selectors?: string[] }} [adapter]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ outcome: 'submitted' | 'has_errors' | 'next_step' | 'timeout', url_after?: string, elapsed_ms: number }>}
 */
export async function submitForm(page, adapter = {}, opts = {}) {
  if (!page) throw new Error('submitForm: page required');
  const timeoutMs = opts.timeoutMs ?? SUBMIT_TIMEOUT_MS;
  const startedAt = Date.now();

  // ── Locate submit button ──────────────────────────────────────
  const hints = adapter?.submit_button?.name_hints || DEFAULT_SUBMIT_NAME_HINTS;
  let button = null;
  for (const hint of hints) {
    // exact first to avoid "Save & Continue" matching "Save"
    const exact = page.getByRole('button', { name: hint, exact: true }).first();
    if ((await exact.count()) > 0) { button = exact; break; }
    const fuzzy = page.getByRole('button', { name: hint, exact: false }).first();
    if ((await fuzzy.count()) > 0) { button = fuzzy; break; }
  }
  if (!button) {
    throw new Error(`submitForm: submit button not found. Tried hints: ${hints.join(', ')}`);
  }

  // ── Capture pre-click state for change detection ───────────────
  const urlBefore = page.url();

  // [review C2] Snapshot visible-error count BEFORE click so errP
  // distinguishes "submit produced new errors" from "errors already
  // visible from previous round". The race for has_errors only
  // resolves when the count INCREASES — otherwise m6's retry loop
  // would loop on stale errors forever (same-error-twice guard would
  // halt, but with misleading telemetry).
  const errorSelectors = (adapter?.error_selectors || DEFAULT_ERROR_SELECTORS).join(', ');
  const nextStepSelectors = (adapter?.next_step_selectors || DEFAULT_NEXT_STEP_SELECTORS).join(', ');

  let errorCountBefore = 0;
  try {
    const all = await page.locator(errorSelectors).all();
    for (const e of all) {
      try {
        if (await e.isVisible()) errorCountBefore++;
      } catch { /* element gone — skip */ }
    }
  } catch { /* selector edge — assume 0 */ }

  // ── humanClick the button ──────────────────────────────────────
  await humanClick(button);

  // ── Race for outcome ───────────────────────────────────────────
  // Each sub-wait has timeoutMs bound. Their rejections become
  // never-settling promises so the `timeoutP` is the guaranteed
  // tie-breaker. This keeps the race cleanly bounded without
  // leaking handlers past the deadline. [review C1] timer cleared
  // after race resolves so Node can exit promptly.
  const navP = pendIfNull(
    page.waitForFunction(
      (prev) => location.href !== prev,
      urlBefore,
      { timeout: timeoutMs, polling: 200 },
    )
      .then(() => ({ outcome: 'submitted', url_after: page.url() }))
      .catch(() => null),
  );

  const errP = pendIfNull(
    page.waitForFunction(
      ([sel, before]) => {
        const els = document.querySelectorAll(sel);
        let visible = 0;
        for (const el of els) {
          const cs = window.getComputedStyle(el);
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null) {
            visible++;
          }
        }
        return visible > before;
      },
      [errorSelectors, errorCountBefore],
      { timeout: timeoutMs, polling: 200 },
    )
      .then(() => ({ outcome: 'has_errors' }))
      .catch(() => null),
  );

  const nextP = pendIfNull(
    page.locator(nextStepSelectors).first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => ({ outcome: 'next_step' }))
      .catch(() => null),
  );

  let timeoutHandle;
  const timeoutP = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ outcome: 'timeout' }), timeoutMs);
  });

  try {
    const result = await Promise.race([navP, errP, nextP, timeoutP]);
    return {
      outcome: result.outcome,
      ...(result.url_after ? { url_after: result.url_after } : {}),
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutHandle);  // [review C1]
  }
}

/** Convert null-resolving promise into a never-settling pending so the
 *  Promise.race tie-breaker (timeoutP) wins instead of an early null. */
function pendIfNull(p) {
  return p.then((v) => (v == null ? new Promise(() => {}) : v));
}

/**
 * Scan the page for visible inline form errors. Returns normalized list.
 * @param {import('playwright').Page} page
 * @param {{ error_selectors?: string[] }} [adapter]
 * @returns {Promise<Array<{ field: string | null, error_code: string, error_msg: string }>>}
 */
export async function parseFormErrors(page, adapter = {}) {
  if (!page) throw new Error('parseFormErrors: page required');
  const selectors = adapter?.error_selectors || DEFAULT_ERROR_SELECTORS;

  const collected = [];
  const seen = new Set();

  // ── Method 1: visible error containers ────────────────────────
  // Iterate each selector independently — combining them into a
  // single locator and then nth()-ing it can be fragile across
  // shadow roots / iframes.
  for (const sel of selectors) {
    const locs = page.locator(sel);
    const count = await locs.count();
    for (let i = 0; i < count; i++) {
      const el = locs.nth(i);
      let visible;
      try { visible = await el.isVisible(); } catch { continue; }
      if (!visible) continue;
      const raw = await el.textContent().catch(() => null);
      const msg = (raw ?? '').replace(/\s+/g, ' ').trim();
      if (!msg) continue;
      const field = await resolveErrorField(page, el);
      // Dedup by (field, msg) — same error often surfaces twice
      // (role=alert + .error wrapper).
      const key = `${field} ${msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        field,
        error_code: inferErrorCode(msg),
        error_msg: msg,
      });
    }
  }

  // ── Method 2: aria-describedby chains from invalid inputs ─────
  // Inputs marked aria-invalid=true with an aria-describedby pointer
  // to a (visible) error description element.
  const invalidInputs = page.locator(
    'input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"]',
  );
  const invCount = await invalidInputs.count();
  for (let i = 0; i < invCount; i++) {
    const input = invalidInputs.nth(i);
    const describedBy = await input.getAttribute('aria-describedby').catch(() => null);
    if (!describedBy) continue;
    // aria-describedby can list multiple IDs
    const ids = describedBy.split(/\s+/).filter(Boolean);
    for (const id of ids) {
      // [review M3] Use attribute selector — Workday IDs may start with
      // digits which `#id` syntax can't address without escaping.
      const target = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`).first();
      if ((await target.count()) === 0) continue;
      let visible;
      try { visible = await target.isVisible(); } catch { continue; }
      if (!visible) continue;
      const raw = await target.textContent().catch(() => null);
      const msg = (raw ?? '').replace(/\s+/g, ' ').trim();
      if (!msg) continue;
      const field = (await input.getAttribute('name').catch(() => null))
        || (await input.getAttribute('id').catch(() => null))
        || (await input.getAttribute('aria-label').catch(() => null))
        || null;
      const key = `${field} ${msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        field,
        error_code: inferErrorCode(msg),
        error_msg: msg,
      });
    }
  }

  // P2-OQ5: empty list when no errors. No throw.
  return collected;
}

/** Resolve the field name an error element refers to. Best-effort. */
async function resolveErrorField(page, errorEl) {
  try {
    return await errorEl.evaluate((node) => {
      // [review H1] Prefer aria-describedby REVERSE lookup over DOM walk
      // when the error has an id. This aligns Method 1's field resolution
      // with Method 2's (which always uses input.name) so dedup keys
      // match. DOM walk is the fallback when there's no id pointer.
      const id = node.getAttribute('id');
      if (id) {
        const ref = document.querySelector(`[aria-describedby~="${CSS.escape(id)}"]`);
        if (ref) {
          return ref.getAttribute('name')
            || ref.getAttribute('id')
            || ref.getAttribute('aria-label')
            || null;
        }
      }

      // Fallback: climb up to the field group looking for an input.
      // [review H2] When multiple inputs sit in the same group (date
      // trios, phone trios), return joined names so the error doesn't
      // get pinned to just the first input — m6's same-error-twice
      // guard then correctly compares group-level signatures.
      let cur = node.parentElement;
      let depth = 0;
      while (cur && depth < 6) {
        const inputs = cur.querySelectorAll('input, select, textarea');
        if (inputs.length === 1) {
          const input = inputs[0];
          return input.getAttribute('name')
            || input.getAttribute('id')
            || input.getAttribute('aria-label')
            || null;
        }
        if (inputs.length > 1) {
          const names = Array.from(inputs)
            .map((i) => i.getAttribute('name') || i.getAttribute('id') || i.getAttribute('aria-label'))
            .filter(Boolean);
          if (names.length > 0) return names.join('+');
          return null;
        }
        cur = cur.parentElement;
        depth++;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/** Infer an error_code bucket from a free-text error message. Drives
 *  m6's same-error-twice guard + Phase 5 flywheel bucketing.
 *  Order matters — more specific patterns first. */
export function inferErrorCode(msg) {
  // null/undefined/'' → 'custom' (documented bucket for unparseable input)
  if (!msg) return 'custom';
  const s = String(msg).toLowerCase();
  // [review H3] too_large requires either a unit token OR an explicit "size"
  // keyword. Dropped bare "too long" — it conflates resume-file-too-big
  // (size) with cover-letter-text-too-long (length). Length issues now
  // fall under too_short's opposite (custom) until a separate too_long
  // bucket is added.
  const hasUnit = /\b(mb|kb|gb|bytes?)\b/i.test(s);
  const sizeWords = /(too large|too big|exceed|max(imum)? size|maximum length|file size|size limit|size exceeded)/i.test(msg);
  const sizeBound = /\b(must be (at most|less than|<=|smaller than))\b/i.test(msg);
  if (hasUnit || sizeWords || sizeBound) {
    return 'too_large';
  }
  if (/(too short|min(imum)?(\s|-)?length|at least \d|must be at least)/i.test(msg)) {
    return 'too_short';
  }
  if (/(invalid|format|must match|valid email|valid (phone|date|number|url)|incorrect)/i.test(msg)) {
    return 'invalid_format';
  }
  if (/(required|cannot be (empty|blank)|this field is|please (fill|select|enter|provide))/i.test(msg)) {
    return 'required';
  }
  return 'custom';
}

/**
 * Detect whether the application was successfully submitted AND
 * identify which signal triggered the detection. Returns the signal
 * name (e.g. 'url_pattern') or `null` when no signal matched. The
 * signal name flows into m10's `submitDetectedBy` field so the
 * cockpit's autoMark decision can fire `auto_redirect` vs
 * `confirm_fallback`.
 *
 * @param {import('playwright').Page} page
 * @param {{ success_url_patterns?: RegExp[], success_text?: string[] }} [adapter]
 * @param {{ networkSignal?: () => boolean }} [opts]  - pre-installed listener
 * @returns {Promise<'url_pattern' | 'thank_you_text' | 'network_signal' | null>}
 */
export async function detectSubmitSuccess(page, adapter = {}, opts = {}) {
  if (!page) throw new Error('detectSubmitSuccess: page required');

  // ── (1) URL pattern ───────────────────────────────────────────
  const url = page.url();
  const patterns = adapter?.success_url_patterns || DEFAULT_SUCCESS_URL_PATTERNS;
  for (const p of patterns) {
    if (p instanceof RegExp && p.test(url)) return 'url_pattern';
    if (typeof p === 'string' && url.includes(p)) return 'url_pattern';
  }

  // ── (2) Thank-you body text ───────────────────────────────────
  // [review H5] Iterate ALL matches and return on the FIRST
  // visible one — first() can land on a hidden modal even when a
  // visible success banner exists later in DOM order.
  const texts = adapter?.success_text || DEFAULT_SUCCESS_TEXT;
  for (const t of texts) {
    try {
      const matches = await page.getByText(t, { exact: false }).all();
      for (const m of matches) {
        try {
          if (await m.isVisible()) return 'thank_you_text';
        } catch { /* element disposed — skip */ }
      }
    } catch { /* selector edge — keep going */ }
  }

  // ── (3) Network signal (pre-installed by caller) ──────────────
  if (typeof opts.networkSignal === 'function') {
    try {
      if (opts.networkSignal()) return 'network_signal';
    } catch { /* signal threw — treat as false */ }
  }

  return null;
}

/** Backward-compat boolean helper for callers that just want to know
 *  "did it succeed?" without the signal source. */
export async function isSubmitSuccess(page, adapter = {}, opts = {}) {
  const by = await detectSubmitSuccess(page, adapter, opts);
  return by !== null;
}

/**
 * Helper: install a pre-submit response listener that flags success
 * when a POST application endpoint replies 2xx + the page navigates.
 * Returns { signal, dispose }.
 *
 * Used by callers who want detectSubmitSuccess's method (3):
 *
 *   const obs = attachSubmitNetworkSignal(page);
 *   await submitForm(page, adapter);
 *   const ok = await detectSubmitSuccess(page, adapter, { networkSignal: obs.signal });
 *   obs.dispose();
 *
 * @param {import('playwright').Page} page
 * @param {{ urlPatterns?: RegExp[] }} [opts]
 */
export function attachSubmitNetworkSignal(page, opts = {}) {
  const patterns = opts.urlPatterns || [
    /\/applications?\b/i,
    /\/apply\b/i,
    /\/submissions?\b/i,
  ];
  let sawPostOk = false;
  let sawNavigation = false;

  const onResponse = (res) => {
    try {
      const req = res.request();
      if (req.method() !== 'POST') return;
      const url = res.url();
      const matched = patterns.some((p) => p.test(url));
      if (!matched) return;
      const status = res.status();
      // [review M4] Tighten to 2xx — 3xx redirects from /applications
      // → /login (expired session) would falsely count as success.
      // Playwright surfaces the final 2xx after redirect-following.
      if (status >= 200 && status < 300) sawPostOk = true;
    } catch { /* listener must never throw */ }
  };

  const onFramenav = () => { sawNavigation = true; };

  page.on('response', onResponse);
  page.on('framenavigated', onFramenav);

  return {
    signal: () => sawPostOk && sawNavigation,
    // [review H4] reset() — attach once, clear between submit attempts.
    // Without this, a flag set by attempt #1's POST persists into attempt
    // #2's evaluation and yields false-positive success.
    reset: () => { sawPostOk = false; sawNavigation = false; },
    dispose: () => {
      // [review M5] page.off can throw TargetClosedError on closed pages;
      // cleanup must never throw to caller (often called from finally{}).
      try { page.off('response', onResponse); } catch { /* page closed */ }
      try { page.off('framenavigated', onFramenav); } catch { /* page closed */ }
    },
  };
}
