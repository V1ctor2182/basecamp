// guards/parseFailure.mjs
//
// 07-applier/04-multi-step-state-machine m6 — guard #1 (highest priority).
//
// Fires when parseFormErrors threw OR returned a value that isn't an
// Array. We can't even SEE what the form's complaining about — every
// downstream guard depends on `currentErrors` being a list. The state
// machine has nothing actionable to do, so escalate immediately.

/**
 * @param {{ currentErrors: any, parseError?: Error }} ctx
 * @returns {{ escalate: true, reason: { code, detail } } | null}
 */
export function parseFailureGuard(ctx) {
  if (ctx.parseError) {
    return {
      escalate: true,
      reason: {
        code: 'parse_failure',
        detail: `parseFormErrors threw: ${String(ctx.parseError?.message ?? ctx.parseError).slice(0, 200)}`,
      },
    };
  }
  // Important: `currentErrors === undefined` means "not yet evaluated this
  // round" (pre-submit phase, or when caller passes no parse context).
  // Only fire on a value that was explicitly set to something non-array
  // (e.g. parseFormErrors returned null or a string by mistake).
  if (ctx.currentErrors !== undefined && !Array.isArray(ctx.currentErrors)) {
    return {
      escalate: true,
      reason: {
        code: 'parse_failure',
        detail: `parseFormErrors returned ${typeof ctx.currentErrors} (expected Array)`,
      },
    };
  }
  return null;
}

export const NAME = 'parseFailure';
