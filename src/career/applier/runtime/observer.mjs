// observer.mjs
//
// 07-applier/02-playwright-runtime m6 — Apply.tsx UI primitive #1.
//
// Watches a form for live user edits and pushes events back to Node:
//   attachFormObserver(page, formSelector, callback) → detach()
//
// Used by Apply.tsx (post-fill-handoff-ux Phase 3) to know when the
// user touches a field that Mode 2 already filled — so the dashboard
// can flag override events for the flywheel.
//
// Locked OQs (P2-OQ7, OQ8 per plan-milestones session 2026-05-27):
//   - Listens to `input` + `change` only — NOT `blur` (P2-OQ7)
//   - 200ms per-element debounce (P2-OQ8)
//   - Scoped to formSelector subtree (not document) — avoids React
//     re-render storm on unrelated DOM.
//
// Multi-observer on same page: each call registers an independent
// subscriber through a single page binding. detach() removes the
// subscriber + its in-page event listener. The binding stays for the
// page lifetime (Playwright forbids re-exposing the same name).

const DEBOUNCE_MS = 200;
const BINDING_NAME = '__applierFormEvent';

/** Per-page subscriber registry. Page → Map<observerId, callback>. */
const _pageSubscribers = new WeakMap();

/** Per-page binding flag — exposeBinding can only be called once per
 *  name per page. Track to gate at first attach. */
const _bindingExposed = new WeakMap();

let _nextObserverId = 1;

/**
 * Attach a MutationObserver-style event listener to a form. Returns an
 * async detach() that removes the listener.
 *
 * @param {import('playwright').Page} page
 * @param {string} formSelector — CSS selector for the form (or a wrapper
 *   element). The observer is scoped to this subtree.
 * @param {(evt: { field_ref: string | null, value: string, event_type: 'input' | 'change' }) => void} callback
 *   Called per debounced event. Errors thrown by callback are caught.
 * @returns {Promise<() => Promise<void>>}
 */
export async function attachFormObserver(page, formSelector, callback) {
  if (!page) throw new Error('attachFormObserver: page required');
  if (!formSelector || typeof formSelector !== 'string') {
    throw new Error('attachFormObserver: formSelector (string) required');
  }
  if (typeof callback !== 'function') {
    throw new Error('attachFormObserver: callback (function) required');
  }

  // ── First attach on this page: expose the binding ──────────────
  let subscribers = _pageSubscribers.get(page);
  if (!subscribers) {
    subscribers = new Map();
    _pageSubscribers.set(page, subscribers);
  }
  // [review C1] Store the exposeBinding *promise* so concurrent attach
  // calls share one binding. Without this, two parallel
  // attachFormObserver() racers both call page.exposeBinding(same name)
  // and the loser throws "Function ... has been already registered".
  let bindingPromise = _bindingExposed.get(page);
  if (!bindingPromise) {
    bindingPromise = page.exposeBinding(BINDING_NAME, (_, evt) => {
      try {
        const subs = _pageSubscribers.get(page);
        if (!subs || !evt || typeof evt !== 'object') return;
        const obsId = evt._observerId;
        const cb = subs.get(obsId);
        if (!cb) return;
        const { _observerId, ...rest } = evt;
        try { cb(rest); }
        // [review L4] Surface subscriber callback errors so a buggy
        // Apply.tsx React handler doesn't silently vanish.
        catch (e) { try { console.warn('[applier observer] subscriber callback threw:', e); } catch { /* */ } }
      } catch { /* defensive — binding must never throw to Playwright */ }
    });
    _bindingExposed.set(page, bindingPromise);
  }
  await bindingPromise;

  const observerId = _nextObserverId++;
  subscribers.set(observerId, callback);

  // ── Install in-page listener scoped to formSelector ────────────
  try {
    await page.evaluate(
      ({ sel, obsId, debounceMs, bindingName }) => {
        const form = document.querySelector(sel);
        if (!form) throw new Error(`form not found for selector: ${sel}`);

        // Per-page observer registry inside the page context.
        if (!window.__applierObservers) {
          window.__applierObservers = new Map();
        }

        // Debounce keyed by element so two fields debounce independently.
        const debouncers = new WeakMap();

        const handler = (e) => {
          const target = e.target;
          if (!target || typeof target.matches !== 'function') return;
          if (!target.matches('input, select, textarea, [contenteditable="true"]')) return;
          // [P2-OQ7] only input + change — no blur
          if (e.type !== 'input' && e.type !== 'change') return;

          const eventType = e.type;
          const prev = debouncers.get(target);
          if (prev) clearTimeout(prev);
          debouncers.set(target, setTimeout(() => {
            debouncers.delete(target);
            try {
              const fieldRef =
                target.name ||
                target.id ||
                target.getAttribute('aria-label') ||
                null;
              const value = (target.value != null) ? String(target.value) : '';
              window[bindingName]({
                _observerId: obsId,
                field_ref: fieldRef,
                value,
                event_type: eventType,
              });
            } catch { /* binding may be gone (page nav) — swallow */ }
          }, debounceMs));
        };

        // capture phase so we see events on inputs even when an inner
        // handler stops propagation
        form.addEventListener('input', handler, true);
        form.addEventListener('change', handler, true);

        window.__applierObservers.set(obsId, { form, handler });
      },
      { sel: formSelector, obsId: observerId, debounceMs: DEBOUNCE_MS, bindingName: BINDING_NAME },
    );
  } catch (err) {
    // Roll back the subscriber registration so a half-installed observer
    // doesn't leak through a future binding call.
    subscribers.delete(observerId);
    throw err;
  }

  return async function detach() {
    // 1. Stop dispatching new events to this subscriber
    const subs = _pageSubscribers.get(page);
    if (subs) subs.delete(observerId);

    // 2. Remove the in-page listener — best-effort (page may have closed)
    try {
      await page.evaluate((obsId) => {
        const reg = window.__applierObservers;
        if (!reg) return;
        const entry = reg.get(obsId);
        if (!entry) return;
        const { form, handler } = entry;
        try {
          form.removeEventListener('input', handler, true);
          form.removeEventListener('change', handler, true);
        } catch { /* form gone */ }
        reg.delete(obsId);
      }, observerId);
    } catch { /* page closed — listener will GC */ }
  };
}

