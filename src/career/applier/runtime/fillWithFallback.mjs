// fillWithFallback.mjs
//
// 07-applier/02-playwright-runtime m4 — strategy-ladder fill orchestrator.
//
// One field, many ways to fill it. The ladder lives in `DEFAULT_LADDER`
// (5 strategies, ordered from cheapest to most complex). Each strategy
// is a module in `./strategies/` that exports { NAME, fill(locator,
// value, page?) }. The orchestrator drives them in order: try → verify
// → first-success-wins.
//
// Locked OQs (P2-OQ1..10, per plan-milestones session 2026-05-27):
//   - Ladder default hardcoded; adapter override via options.ladder
//     (Phase 6 wires real per-ATS adapter overrides)
//   - Per-strategy auto-reset before the next (P2-OQ2)
//   - Verify: trim+lowercase string compare (P2-OQ3)
//   - First-success short-circuit (P2-OQ4)
//
// Output:
//   {
//     strategies_tried: [{ name, result, verify_value? }],
//     final: { strategy: <name>, success: bool, last_value: <string> },
//   }
//
// Consumed by 04-multi-step-state-machine m6 via DI as `_fixField` —
// but **NOT directly**. m6's `_fixField(page, fieldRef, errorRecord)`
// returns the FLAT shape `{ field, fix_name, result, success }`,
// whereas fillWithFallback returns the NESTED `{ strategies_tried,
// final }`. The wiring milestone (m5 of 02-playwright-runtime + the
// endpoint glue) supplies an adapter:
//
//   async function fixFieldAdapter(page, fieldRef, errorRecord, opts) {
//     const locator = opts.resolveLocator(fieldRef);  // RefTable.resolve or similar
//     const expected = errorRecord.expected_value;
//     const result = await fillWithFallback(page, locator, expected);
//     return {
//       field: fieldRef,
//       fix_name: result.final.strategy ?? 'all_strategies_failed',
//       result: result.final.success ? 'verified'
//             : (result.strategies_tried[0]?.result ?? 'no_effect'),
//       success: result.final.success,
//       // For Phase 5/m5 signal A — preserve the full ladder log so
//       // the flywheel can rank strategies per fingerprint_class.
//       // m6's envelope.fixes_tried currently drops this; track in
//       // m6-followup or Phase 5/m5 ingestion.
//       strategies_tried: result.strategies_tried,
//     };
//   }
//
// `strategies_tried` is THE telemetry for Phase 5/m5 signal A. The
// adapter MUST forward it; m6 should also extend its envelope shape
// in a followup so the flywheel input chain is complete.

import { SnapshotError, classifyPlaywrightError, SNAPSHOT_ERROR_CODES } from './errors.mjs';
import { verifyValue, resetLocator, DEFAULT_STRATEGY_TIMEOUT_MS } from './strategies/shared.mjs';

/** [review C3] Outer hard cap on a single strategy.fill() call. Slightly
 *  larger than DEFAULT_STRATEGY_TIMEOUT_MS so Playwright's own per-action
 *  timeout fires first with its useful error message; only fires if the
 *  strategy hangs on non-Playwright work (custom Phase 6 strategies, a
 *  busy-loop bug, etc.). */
const STRATEGY_HARD_TIMEOUT_MS = DEFAULT_STRATEGY_TIMEOUT_MS + 2_000;

/** Wrap a strategy.fill() call with a hard timeout. Returns
 *  { result } on success or throws the underlying error / hard-timeout. */
async function runStrategyWithTimeout(strategy, locator, value, page) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`strategy "${strategy.NAME}" exceeded hard timeout (${STRATEGY_HARD_TIMEOUT_MS}ms)`)),
      STRATEGY_HARD_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([strategy.fill(locator, value, page), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

import * as selectOption from './strategies/selectOption.mjs';
import * as reactSelectClick from './strategies/reactSelectClick.mjs';
import * as keyboardInput from './strategies/keyboardInput.mjs';
import * as roleLocatorClick from './strategies/roleLocatorClick.mjs';
import * as ariaCombobox from './strategies/ariaCombobox.mjs';

/** Default strategy ladder. Order matters — cheapest first.
 *  Phase 6 will allow per-ATS YAML overrides via the
 *  `adapter.strategy_priority[fingerprint_class]` block; m4 ships
 *  with this default and exposes the override hook only. */
export const DEFAULT_LADDER = Object.freeze([
  selectOption,
  reactSelectClick,
  keyboardInput,
  roleLocatorClick,
  ariaCombobox,
]);

/** Names in default order — exported for telemetry / dashboards. */
export const DEFAULT_LADDER_NAMES = Object.freeze(DEFAULT_LADDER.map((s) => s.NAME));

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} locator
 * @param {string} expected
 * @param {{
 *   ladder?: Array<{ NAME: string, fill: Function }>,
 *   verifier?: typeof verifyValue,
 *   reseter?: typeof resetLocator,
 * }} [options]
 * @returns {Promise<{
 *   strategies_tried: Array<{ name: string, result: string, verify_value?: string | null }>,
 *   final: { strategy: string | null, success: boolean, last_value: string | null },
 * }>}
 */
export async function fillWithFallback(page, locator, expected, options = {}) {
  if (!page) throw new Error('fillWithFallback: page required');
  if (!locator) throw new Error('fillWithFallback: locator required');
  if (expected == null) {
    throw new Error('fillWithFallback: expected value required (use "" for clear, not null)');
  }
  const ladder = options.ladder || DEFAULT_LADDER;
  const verifier = options.verifier || verifyValue;
  const reseter = options.reseter || resetLocator;

  const tried = [];
  let lastValue = null;

  for (let i = 0; i < ladder.length; i++) {
    const strategy = ladder[i];
    const name = strategy.NAME;

    // Run the strategy with an outer hard timeout (review C3) — protects
    // against Phase 6 caller-provided strategies that hang on non-
    // Playwright work. We translate Playwright errors into SnapshotError
    // codes so the caller (m6) can distinguish "this strategy didn't
    // fit this control" (soft) from "the element is gone — re-snapshot
    // before ANY more attempts" (hard).
    let attemptResult;
    try {
      attemptResult = await runStrategyWithTimeout(strategy, locator, expected, page);
    } catch (err) {
      const code = classifyPlaywrightError(err);
      // Hard error → propagate (m6 must re-snapshot before any more attempts)
      if (code === SNAPSHOT_ERROR_CODES.ELEMENT_GONE
          || code === SNAPSHOT_ERROR_CODES.STALE_REF
          || code === SNAPSHOT_ERROR_CODES.IFRAME_DETACHED) {
        if (err instanceof SnapshotError) throw err;
        // Caller's m6 catch chain wraps + classifies further.
        throw err;
      }
      // Soft error — strategy didn't fit this control. Record + try next.
      // [review C2] Unknown classification (code == null) is treated as
      // soft (not rethrow) because strategy failure is the EXPECTED
      // ladder semantic — Playwright invents new error messages over
      // time (e.g. "Element is not a <select>") that we haven't
      // catalogued yet. Tagged with a distinct result so the flywheel
      // surfaces unknown patterns for triage. Hard-error class above
      // (ELEMENT_GONE / STALE_REF / IFRAME_DETACHED) still rethrows.
      tried.push({
        name,
        result: code == null ? 'no_effect_unknown' : classifyToResult(code, err),
        // [review M1] preserve err.code so m6's catch chain can route
        // by classification (e.g. recurrent ACTION_TIMEOUT → re-snapshot
        // bias). Limited keys to keep envelope shape stable.
        ...(err && typeof err === 'object' && err.code ? { code: err.code } : {}),
        error_msg: String(err?.message ?? err).slice(0, 200),
      });
      // Reset before next strategy (per P2-OQ2) — wrap to absorb a
      // custom reseter (Phase 6) that throws; orchestrator must not
      // die mid-ladder and lose remaining-strategy telemetry.
      if (i < ladder.length - 1) {
        try { await reseter(locator); } catch { /* best-effort */ }
      }
      continue;
    }

    // Verify. trim+lowercase compare per P2-OQ3.
    const v = await verifier(locator, expected);
    lastValue = v.actual;
    tried.push({
      name,
      result: v.ok ? 'verified' : 'fill_ok_verify_mismatch',
      verify_value: v.actual,
    });

    if (v.ok) {
      // First success — short-circuit (P2-OQ4)
      return {
        strategies_tried: tried,
        final: { strategy: name, success: true, last_value: v.actual },
      };
    }

    // Fill landed but value mismatched — try next strategy.
    if (i < ladder.length - 1) {
      try { await reseter(locator); } catch { /* best-effort */ }
    }
  }

  // Whole ladder exhausted without verification.
  return {
    strategies_tried: tried,
    final: {
      strategy: null,
      success: false,
      last_value: lastValue,
    },
  };
}

/** Map SnapshotError code → telemetry-friendly result string.
 *  Keeps the per-strategy "result" enum small for flywheel bucketing
 *  (Phase 5/m5 signal A bins by these values). */
function classifyToResult(code, err) {
  switch (code) {
    case SNAPSHOT_ERROR_CODES.ACTION_TIMEOUT: return 'no_effect_timeout';
    case SNAPSHOT_ERROR_CODES.OPTION_NOT_FOUND: return 'option_not_found';
    case SNAPSHOT_ERROR_CODES.WRONG_PAGE: return 'no_effect_wrong_page';
    default:
      // The strategy may have thrown a clear domain error (e.g.
      // aria_combobox's "aria-activedescendant never populated"
      // or react_select_click's "page required").
      return 'no_effect';
  }
}
