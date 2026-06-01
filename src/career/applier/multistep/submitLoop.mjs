// submitLoop.mjs
//
// 07-applier/04-multi-step-state-machine m6 — submit-first error loop.
//
// Called by runMachine after the form is filled + final step approved.
// Owns the SUBMITTING / PARSING_ERRORS / RETRYING_FIX / SUBMITTED_SUCCESS
// / ESCALATING_TO_USER state transitions.
//
// The loop calls evaluateGuards at THREE points per iteration so each
// guard runs against the input it actually needs (not stale data from
// the previous round):
//
//   1. Pre-submit:    maxSubmits / submitInterval
//                      (uses priorAttempts.length, lastSubmitAt)
//   2. Post-parse:    parseFailure / sameErrorTwice
//                      (uses currentErrors, parseError, priorAttempts)
//   3. Post-fix:      allStrategiesFailed
//                      (uses fixesResult)
//
// Earlier prototypes called evaluateGuards ONCE at loop top with stale
// inputs — that wrongly tripped sameErrorTwice on iter N+1 with iter N's
// errors. The 3-phase split removes that ambiguity.
//
// Persistence: every submit round appends one SubmitAttempt via the m5
// `appendSubmitAttempt` helper. The attempt INDEX is owned by the loop
// (1-based, monotonic across the session). The m5 helper validates the
// invariant `attempt === session.submit_attempts.length + 1`.
//
// DI deps (all injected from runMachine):
//   _submitForm(page, adapter) → { outcome, url_after?, elapsed_ms }
//   _parseFormErrors(page, adapter) → Array<{ field, error_code, error_msg }>
//   _fixField(page, fieldRef, errorRecord) → { field, fix_name, result, success }
//   _appendSubmitAttempt(jobId, attempt) → updated session
//   _now() → number (Date.now-equivalent; injectable for fake timers)
//   _sleep(ms) → Promise<void> (injectable for fake timers)

import { evaluateGuards } from './guards/policy.mjs';
import { MAX_SUBMIT_ATTEMPTS_PER_SESSION } from './guards/maxSubmits.mjs';
import { appendSubmitAttempt as defaultAppendSubmitAttempt } from './applySessionsStore.mjs';

/**
 * Hard runaway cap. Guards should escalate before this; if we somehow
 * loop past 50 rounds, the m5 store layer also enforces this — but we
 * want to fail clean inside submitLoop before the m5 helper throws.
 */
const HARD_CAP_ATTEMPTS = 50;

/**
 * Run the submit-first error loop.
 *
 * @param {{
 *   jobId: string,
 *   session: object,
 *   page: any,
 *   siteAdapter: string,
 *   deps: {
 *     _submitForm: Function,
 *     _parseFormErrors: Function,
 *     _fixField: Function,
 *     _appendSubmitAttempt?: Function,
 *     _now?: () => number,
 *     _sleep?: (ms) => Promise<void>,
 *   },
 * }} args
 * @returns {Promise<{
 *   outcome: 'submitted' | 'escalated' | 'timeout',
 *   attempts_run: number,
 *   escalation_reason?: { code: string, detail: string, field?: string, triggered_by?: string },
 *   final_session: object,
 * }>}
 */
export async function runSubmitLoop({ jobId, session, page, siteAdapter, deps }) {
  if (!jobId) throw new Error('runSubmitLoop: jobId required');
  if (!session) throw new Error('runSubmitLoop: session required');
  if (!deps || typeof deps._submitForm !== 'function') {
    throw new Error('runSubmitLoop: deps._submitForm required (Phase 2/m5)');
  }
  if (typeof deps._parseFormErrors !== 'function') {
    throw new Error('runSubmitLoop: deps._parseFormErrors required (Phase 2/m5)');
  }
  if (typeof deps._fixField !== 'function') {
    throw new Error('runSubmitLoop: deps._fixField required (Phase 2/m4)');
  }
  const _append = deps._appendSubmitAttempt || defaultAppendSubmitAttempt;
  const _now = deps._now || (() => Date.now());
  const _sleep = deps._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let attemptsRun = 0;
  let lastSubmitAt = null;
  // priorAttempts seeds from session — if loop is being resumed mid-flow
  // (the session was paused and writeSession persisted prior attempts),
  // those attempts COUNT toward maxSubmits.
  let priorAttempts = Array.isArray(session.submit_attempts)
    ? [...session.submit_attempts]
    : [];
  let finalSession = session;
  // [review C1] Bound consecutive wait re-entries per attempt. If _sleep
  // returns without advancing _now() (broken mock or wall-clock skew),
  // we'd otherwise spin without ever bumping attemptsRun. 5 retries is
  // generous — each sleep is at least MIN_SUBMIT_INTERVAL_MS so 5 ×
  // 5s = 25s wall time max, plenty for any real clock to catch up.
  const MAX_WAIT_RETRIES = 5;
  let waitRetries = 0;

  while (attemptsRun < HARD_CAP_ATTEMPTS) {
    // ── Phase A: pre-submit guards ────────────────────────────────
    // Only maxSubmits + submitInterval are relevant here (others lack
    // their inputs — they return null).
    const preVerdict = evaluateGuards({
      priorAttempts,
      lastSubmitAt,
      now: _now(),
    });
    if (preVerdict.action === 'escalate') {
      // We never even tried this attempt → don't synthesize an attempt
      // record. The previous attempt is already in submit_attempts[].
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: { ...preVerdict.reason, triggered_by: preVerdict.triggered_by },
        final_session: finalSession,
      };
    }
    if (preVerdict.action === 'wait') {
      // [review C1] Cap consecutive waits per attempt.
      if (++waitRetries > MAX_WAIT_RETRIES) {
        return {
          outcome: 'escalated',
          attempts_run: attemptsRun,
          escalation_reason: {
            code: 'wait_loop_stuck',
            detail: `submitInterval guard kept returning wait beyond ${MAX_WAIT_RETRIES} retries — _sleep/_now mismatch?`,
            triggered_by: 'submitLoop',
          },
          final_session: finalSession,
        };
      }
      const waitMs = Math.max(0, new Date(preVerdict.wait_until).getTime() - _now());
      if (waitMs > 0) await _sleep(waitMs);
      continue;
    }
    waitRetries = 0;  // proceeded → reset

    // ── Phase B: submit ─────────────────────────────────────────
    attemptsRun++;
    const attemptIdx = priorAttempts.length + 1;
    const submitStartIso = new Date(_now()).toISOString();
    lastSubmitAt = submitStartIso;

    let submitRes;
    try {
      submitRes = await deps._submitForm(page, siteAdapter);
    } catch (err) {
      submitRes = {
        outcome: 'submit_failed',
        error_msg: String(err?.message ?? err).slice(0, 200),
      };
    }

    if (submitRes.outcome === 'submitted') {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: [],
        fixes_tried: [],
        outcome: 'no_errors',
      };
      finalSession = await _append(jobId, attempt);
      // [m14] Identify the success signal — url_pattern / thank_you_text /
      // network_signal — so the cockpit's autoMark decision can choose
      // between auto_redirect (strong signal) and confirm_fallback (no
      // signal but submit completed). Falls back to null when no detector
      // is wired (default deps).
      let detectedBy = null;
      if (typeof deps._detectSubmitSuccess === 'function') {
        try {
          detectedBy = await deps._detectSubmitSuccess(page, siteAdapter);
        } catch { /* detector errors must not derail the success path */ }
      }
      return {
        outcome: 'submitted',
        attempts_run: attemptsRun,
        final_session: finalSession,
        submit_detected_by: detectedBy,
      };
    }

    if (submitRes.outcome === 'timeout') {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: [],
        fixes_tried: [],
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
        priorAttempts = [...finalSession.submit_attempts];
      } catch {
        // [review C2] Append failed (FS wedged / SESSION_ATTEMPT_INDEX_MISMATCH / Zod)
        // — still advance priorAttempts locally so maxSubmits guard sees
        // the attempt count next iteration. Without this, the loop could
        // exceed cap=3 if the disk goes wedged on round 3 and trip the
        // ATS anti-bot heuristic.
        priorAttempts.push(attempt);
      }
      return {
        outcome: 'timeout',
        attempts_run: attemptsRun,
        escalation_reason: {
          code: 'timeout',
          detail: `submitForm timed out after ${submitRes.elapsed_ms ?? '?'}ms`,
          triggered_by: 'submitForm',
        },
        final_session: finalSession,
      };
    }

    // [review H4] Explicit branch for submit_failed — caller's
    // _submitForm returned a network/transient error cleanly (we'd
    // otherwise fall through to parse phase against a non-form page).
    if (submitRes.outcome === 'submit_failed') {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: [],
        fixes_tried: [],
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
        priorAttempts = [...finalSession.submit_attempts];
      } catch {
        priorAttempts.push(attempt);
      }
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: {
          code: 'submit_failed',
          detail: submitRes.error_msg || `submitForm reported submit_failed at ~${submitRes.elapsed_ms ?? '?'}ms`,
          triggered_by: 'submitForm',
        },
        final_session: finalSession,
      };
    }

    if (submitRes.outcome === 'next_step') {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: [],
        fixes_tried: [],
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
        priorAttempts = [...finalSession.submit_attempts];
      } catch {
        // [review C2] Append failed (FS wedged / SESSION_ATTEMPT_INDEX_MISMATCH / Zod)
        // — still advance priorAttempts locally so maxSubmits guard sees
        // the attempt count next iteration. Without this, the loop could
        // exceed cap=3 if the disk goes wedged on round 3 and trip the
        // ATS anti-bot heuristic.
        priorAttempts.push(attempt);
      }
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: {
          code: 'unexpected_next_step',
          detail: 'submitForm returned next_step outcome past the multistep approve loop',
          triggered_by: 'submitForm',
        },
        final_session: finalSession,
      };
    }

    // ── Phase C: parse errors ───────────────────────────────────
    let currentErrors;
    let parseError = null;
    try {
      currentErrors = await deps._parseFormErrors(page, siteAdapter);
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
      currentErrors = null;
    }
    const safeErrors = Array.isArray(currentErrors) ? currentErrors : [];

    // ── Phase D: post-parse guards ──────────────────────────────
    // parseFailure (if parseError) + sameErrorTwice (vs priorAttempts).
    const postParseVerdict = evaluateGuards({
      currentErrors,
      parseError,
      priorAttempts,
    });
    if (postParseVerdict.action === 'escalate') {
      // Append the attempt with whatever we observed, then escalate.
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: safeErrors,
        fixes_tried: [],
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
      } catch (err) {
        postParseVerdict.reason.detail =
          `${postParseVerdict.reason.detail}; append refused: ${String(err?.message ?? err).slice(0, 120)}`;
      }
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: { ...postParseVerdict.reason, triggered_by: postParseVerdict.triggered_by },
        final_session: finalSession,
      };
    }

    // [review H5] Empty errors despite 'has_errors' outcome = parser
    // confusion (form said it failed but we can't see what's wrong).
    // Escalate immediately rather than retrying — every retry just
    // wastes a submit toward the cap without telemetry to learn from.
    if (safeErrors.length === 0) {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: [],
        fixes_tried: [],
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
        priorAttempts = [...finalSession.submit_attempts];
      } catch {
        priorAttempts.push(attempt);
      }
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: {
          code: 'parse_failure_empty',
          detail: `submitForm returned has_errors but parseFormErrors found none — adapter rule may need tuning`,
          triggered_by: 'submitLoop',
        },
        final_session: finalSession,
      };
    }

    // ── Phase E: fix round ──────────────────────────────────────
    const roundFixes = [];
    for (const err of safeErrors) {
      let fixRes;
      try {
        fixRes = await deps._fixField(page, err.field, err);
      } catch (e) {
        fixRes = {
          field: err.field,
          fix_name: 'unknown',
          result: 'fixer_threw',
          success: false,
          detail: String(e?.message ?? e).slice(0, 200),
        };
      }
      roundFixes.push({
        field: fixRes.field || err.field,
        fix_name: fixRes.fix_name || 'unknown',
        result: fixRes.result || 'unknown',
        success: fixRes.success === true,
      });
    }

    // ── Phase F: post-fix guard ────────────────────────────────
    // allStrategiesFailed (only one relevant here).
    const postFixVerdict = evaluateGuards({ fixesResult: roundFixes });
    if (postFixVerdict.action === 'escalate') {
      const attempt = {
        attempt: attemptIdx,
        started_at: submitStartIso,
        form_errors: safeErrors,
        fixes_tried: roundFixes.map((f) => ({
          field: f.field, fix_name: f.fix_name, result: f.result,
        })),
        outcome: 'submit_failed',
      };
      try {
        finalSession = await _append(jobId, attempt);
      } catch (err) {
        postFixVerdict.reason.detail =
          `${postFixVerdict.reason.detail}; append refused: ${String(err?.message ?? err).slice(0, 120)}`;
      }
      return {
        outcome: 'escalated',
        attempts_run: attemptsRun,
        escalation_reason: { ...postFixVerdict.reason, triggered_by: postFixVerdict.triggered_by },
        final_session: finalSession,
      };
    }

    // ── Phase G: append + loop ─────────────────────────────────
    const attempt = {
      attempt: attemptIdx,
      started_at: submitStartIso,
      form_errors: safeErrors,
      fixes_tried: roundFixes.map((f) => ({
        field: f.field, fix_name: f.fix_name, result: f.result,
      })),
      outcome: 'errors_returned',
    };
    finalSession = await _append(jobId, attempt);
    priorAttempts = [...finalSession.submit_attempts];
    // Loop continues. Next iteration's pre-submit phase A will see
    // updated priorAttempts for maxSubmits.
  }

  // Reached HARD_CAP without conclusive outcome — defensive.
  return {
    outcome: 'escalated',
    attempts_run: attemptsRun,
    escalation_reason: {
      code: 'hard_cap',
      detail: `submitLoop hit HARD_CAP_ATTEMPTS (${HARD_CAP_ATTEMPTS}) without escalation — guards bug`,
      triggered_by: 'submitLoop',
    },
    final_session: finalSession,
  };
}

export { HARD_CAP_ATTEMPTS, MAX_SUBMIT_ATTEMPTS_PER_SESSION };
