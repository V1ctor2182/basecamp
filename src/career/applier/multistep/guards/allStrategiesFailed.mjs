// guards/allStrategiesFailed.mjs
//
// 07-applier/04-multi-step-state-machine m6 — guard #2.
//
// Fires when the most recent fix round had ≥ 1 field where every
// strategy in the ladder failed (Phase 2/m4 fillWithFallback returns
// `final.success: false`). No fallback for the machine to try — we
// don't know how to fill this field. Escalate before retrying submit
// (a retry would just hit the same error again).

/**
 * @param {{ fixesResult?: Array<{ field, fix_name, result, success?: boolean }> }} ctx
 * @returns {{ escalate: true, reason: { code, detail, field } } | null}
 */
export function allStrategiesFailedGuard(ctx) {
  const fixes = ctx.fixesResult || [];
  // Group by field. A field with at least one success is "fixable".
  // A field that appears with `success: false` (or `result: 'all_strategies_failed'`)
  // on every entry means the strategy ladder ran out.
  const byField = new Map();
  for (const f of fixes) {
    if (!f || !f.field) continue;
    if (!byField.has(f.field)) byField.set(f.field, []);
    byField.get(f.field).push(f);
  }
  for (const [field, attempts] of byField) {
    const anySuccess = attempts.some(
      (a) => a.success === true || a.result === 'verified',
    );
    if (anySuccess) continue;
    const allExhausted = attempts.some(
      (a) => a.result === 'all_strategies_failed' || a.success === false,
    );
    if (allExhausted) {
      return {
        escalate: true,
        reason: {
          code: 'all_strategies_failed',
          detail: `field "${field}" exhausted the strategy ladder without success`,
          field,
        },
      };
    }
  }
  return null;
}

export const NAME = 'allStrategiesFailed';
