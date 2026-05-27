// guards/policy.mjs
//
// 07-applier/04-multi-step-state-machine m6 — central guard dispatcher.
//
// One function, one truth: `evaluateGuards(ctx)` runs the 5 guards in
// priority order and returns the FIRST non-null verdict. Order matters
// because:
//
//   1. parseFailure       — without parseable errors, nothing else has
//                           valid input. Must run first.
//   2. allStrategiesFailed — uses fixesResult (this round's fix
//                           outcomes). Run before checking error-history
//                           because a fix that exhausted strategies
//                           tells us MORE than "same error came back".
//   3. sameErrorTwice     — uses prior+current. Run before maxSubmits
//                           because "we already tried this fix" is
//                           more informative than "we tried N times".
//   4. maxSubmits         — last escalation gate. If we've genuinely
//                           cycled N rounds with novel errors each,
//                           that's the ATS being sticky; escalate.
//   5. submitInterval     — not an escalation; a throttle. Returns
//                           {wait, wait_until}. Last so a quick fix
//                           doesn't get throttled into a guard that
//                           would have escalated anyway.
//
// Returns:
//   { action: 'escalate', reason: { code, detail, field? } }  — fatal
//   { action: 'wait', wait_until: ISO }                       — throttle
//   { action: 'proceed' }                                     — submit ok
//
// All guards stay pure (no I/O). Side-effect-free composition.

import { parseFailureGuard, NAME as N_PARSE } from './parseFailure.mjs';
import { allStrategiesFailedGuard, NAME as N_ALL_FAIL } from './allStrategiesFailed.mjs';
import { sameErrorTwiceGuard, NAME as N_SAME_ERR } from './sameErrorTwice.mjs';
import { maxSubmitsGuard, NAME as N_MAX } from './maxSubmits.mjs';
import { submitIntervalGuard, NAME as N_INTERVAL } from './submitInterval.mjs';

export const GUARD_NAMES = Object.freeze([
  N_PARSE,
  N_ALL_FAIL,
  N_SAME_ERR,
  N_MAX,
  N_INTERVAL,
]);

/**
 * @param {{
 *   currentErrors?: any,            // from parseFormErrors this round
 *   parseError?: Error,             // if parseFormErrors threw
 *   fixesResult?: Array,            // from fix round (Phase 2/m4 results)
 *   priorAttempts?: Array,          // session.submit_attempts[] BEFORE this round
 *   lastSubmitAt?: string | null,   // ISO of most recent submit
 *   now?: number,                   // injectable for tests
 * }} ctx
 * @returns {{ action: 'escalate' | 'wait' | 'proceed', reason?: object, wait_until?: string, triggered_by?: string }}
 */
export function evaluateGuards(ctx) {
  // 1. parseFailure — needs only currentErrors / parseError
  {
    const v = parseFailureGuard(ctx);
    if (v?.escalate) return { action: 'escalate', reason: v.reason, triggered_by: N_PARSE };
  }
  // 2. allStrategiesFailed — needs fixesResult
  {
    const v = allStrategiesFailedGuard(ctx);
    if (v?.escalate) return { action: 'escalate', reason: v.reason, triggered_by: N_ALL_FAIL };
  }
  // 3. sameErrorTwice — needs currentErrors + priorAttempts
  {
    const v = sameErrorTwiceGuard(ctx);
    if (v?.escalate) return { action: 'escalate', reason: v.reason, triggered_by: N_SAME_ERR };
  }
  // 4. maxSubmits — needs priorAttempts.length
  {
    const v = maxSubmitsGuard(ctx);
    if (v?.escalate) return { action: 'escalate', reason: v.reason, triggered_by: N_MAX };
  }
  // 5. submitInterval — throttle, never escalate
  {
    const v = submitIntervalGuard(ctx);
    if (v?.wait) return { action: 'wait', wait_until: v.wait_until, triggered_by: N_INTERVAL };
  }
  return { action: 'proceed' };
}

// Re-exports for callers that want to use one guard in isolation
// (e.g. smoke tests targeting a specific failure mode).
export {
  parseFailureGuard,
  allStrategiesFailedGuard,
  sameErrorTwiceGuard,
  maxSubmitsGuard,
  submitIntervalGuard,
};
