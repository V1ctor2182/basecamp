// guards/maxSubmits.mjs
//
// 07-applier/04-multi-step-state-machine m6 — guard #4.
//
// Per P1-OQ2 (locked default): hardcoded cap of 3 submit attempts per
// session. Beyond 3 attempts the ATS likely sees us as a bot (per
// constraint #4 — too many submits in 30s triggers reCAPTCHA / IP
// block). m5 store layer caps at 50 for runaway protection; we cap at
// 3 here for the conventional UX. The numbers MUST be distinct — the
// 50 in m5 is "your machine is broken if you hit this"; the 3 here is
// "your form is too sticky; let the human finish".

export const MAX_SUBMIT_ATTEMPTS_PER_SESSION = 3;

/**
 * @param {{ priorAttempts: Array<unknown> }} ctx
 * @returns {{ escalate: true, reason: { code, detail } } | null}
 */
export function maxSubmitsGuard(ctx) {
  const count = (ctx.priorAttempts || []).length;
  // Already done count attempts; about to do count+1. We escalate
  // BEFORE doing the (count+1)th attempt if that would exceed cap.
  if (count >= MAX_SUBMIT_ATTEMPTS_PER_SESSION) {
    return {
      escalate: true,
      reason: {
        code: 'max_submits',
        detail: `already attempted submit ${count} times (cap ${MAX_SUBMIT_ATTEMPTS_PER_SESSION}); stopping before triggering ATS anti-bot`,
      },
    };
  }
  return null;
}

export const NAME = 'maxSubmits';
