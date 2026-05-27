// guards/submitInterval.mjs
//
// 07-applier/04-multi-step-state-machine m6 — guard #5.
//
// Per P1-OQ3 (locked default): 5s minimum between submits. The actual
// duration is read from the constant below (export so smoke can stub
// when running with fake timers). The guard returns `action: 'wait'`
// with a `wait_until` timestamp the loop should await; we do NOT
// escalate — this is throttling, not failure.
//
// Per the locked default, escalations do NOT pause the timer. If a
// user spent 60s in the escalation UI then resumed, the next submit is
// effectively free of throttling. This matches "since-last-submit" not
// "since-last-non-escalation-event".

export const MIN_SUBMIT_INTERVAL_MS = 5_000;

/**
 * @param {{ lastSubmitAt: string | null, now: number | undefined }} ctx
 * @returns {{ wait: true, wait_until: string } | null}
 */
export function submitIntervalGuard(ctx) {
  if (!ctx.lastSubmitAt) return null;
  const nowMs = ctx.now ?? Date.now();
  const lastMs = new Date(ctx.lastSubmitAt).getTime();
  if (!Number.isFinite(lastMs)) return null; // malformed; let it through
  const elapsed = nowMs - lastMs;
  if (elapsed >= MIN_SUBMIT_INTERVAL_MS) return null;
  const waitMs = MIN_SUBMIT_INTERVAL_MS - elapsed;
  const waitUntilMs = nowMs + waitMs;
  return {
    wait: true,
    wait_until: new Date(waitUntilMs).toISOString(),
  };
}

export const NAME = 'submitInterval';
