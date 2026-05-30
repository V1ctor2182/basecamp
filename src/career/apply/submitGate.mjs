// submitGate.mjs
//
// 07-applier/04-multi-step/m10 — Pure helpers for the Submit gate,
// Loop progress stepper, and Escalation panel + auto-Mark-applied
// decision logic.
//
// Same .mjs pattern as triage.mjs / cardActions.mjs — keeps the
// React component thin and the smoke test fixture-driven.
//
// Exports:
//   - requiredVerifyState(session) → { ready, total, verified, missing }
//   - loopProgressState(submitAttempts, machine) → null | { ... }
//   - escalationState(machine) → null | { code, detail, ... }
//   - autoMarkDecision(machine, prevSeenAttempts) → 'auto_redirect' | 'confirm_fallback' | 'none'
//
// Locked OQs (per plan-milestones 2026-05-27):
//   - P3-OQ4: submit gate stays VISIBLE when not ready (disabled + tooltip)
//   - P3-OQ5: strong signal → auto redirect; user_fallback → confirmation modal
//   - Phase 1/OQ7: machine NEVER auto-submits — only operator clicks Submit
//
// SubmitAttemptSchema.outcome enum (from m5):
//   'no_errors' | 'errors_returned' | 'submit_failed'

// [review H3] Single source of truth for the policy cap. Keeps the
// UI's "of N" copy in sync with the actual server-side guard so a
// policy bump doesn't silently drift the UI.
import { MAX_SUBMIT_ATTEMPTS_PER_SESSION } from '../applier/multistep/guards/maxSubmits.mjs';

/** Sentinel values from machine.lastOutcome (mirrors OUTCOME in
 *  machine.mjs). Imported as strings instead of the enum so this
 *  module stays platform-agnostic. */
export const OUTCOME_VALUES = Object.freeze({
  COMPLETED: 'completed',
  PAUSED: 'paused',
  ERROR: 'error',
  ESCALATED: 'escalated',
});

/** Submit-attempt outcomes (m5 SUBMIT_OUTCOMES). */
export const SUBMIT_ATTEMPT_OUTCOMES = Object.freeze({
  NO_ERRORS: 'no_errors',
  ERRORS_RETURNED: 'errors_returned',
  SUBMIT_FAILED: 'submit_failed',
});

/** detectSubmitSuccess sources we trust without confirmation (P3-OQ5).
 *  Anything else (incl. 'user_fallback') prompts a confirm modal. */
const STRONG_SUBMIT_SIGNALS = new Set([
  'url_pattern',
  'thank_you_text',
  'network_signal',
]);

/** Field classes that MAY be operator-handled. The gate only excludes
 *  them when there's no signal at all (no suggested_value AND no
 *  verify_status) — a CAPTCHA the operator never solved, or a resume
 *  the file-filler couldn't produce. [review H1/H2] When EITHER signal
 *  is present, the field is gating — the operator is responsible for
 *  finishing it before clicking Submit. */
const MAYBE_MANUAL_CLASSES = new Set(['file', 'manual']);

/** verify_status values that count as "this required field is ready
 *  for submit". skipped_by_user is operator's affirmative "I handle
 *  this" so it counts. */
const READY_STATUSES = new Set(['verified', 'skipped_by_user']);

/**
 * Walk all per_step_draft fields and decide whether the Submit button
 * should be enabled. A required field counts as "missing" when it
 * lacks a ready verify_status AND isn't a manual class (those land in
 * the user's lap anyway).
 *
 * @param {object} session
 * @returns {{
 *   ready: boolean,
 *   total: number,        // required + non-manual count
 *   verified: number,
 *   missing: Array<{ refId: string, label: string, stepIdx: number, verify_status: string | null }>,
 * }}
 */
export function requiredVerifyState(session) {
  const missing = [];
  let total = 0;
  let verified = 0;
  if (!session || typeof session !== 'object') {
    return { ready: false, total: 0, verified: 0, missing };
  }
  const drafts = session.per_step_draft || {};
  const stepKeys = Object.keys(drafts).sort((a, b) => Number(a) - Number(b));
  for (const k of stepKeys) {
    const entry = drafts[k];
    const fields = entry?.fields;
    if (!Array.isArray(fields)) continue;
    const stepIdx = entry.step_idx ?? Number(k);
    if (!Number.isFinite(stepIdx)) continue;
    for (const f of fields) {
      if (!f) continue;
      // Optional fields don't gate submit. Default required=true.
      if (f.required === false) continue;
      // [review H1/H2] Maybe-manual classes (file / manual / CAPTCHA)
      // only skip the gate when they have NO signal at all — no
      // suggested_value AND no verify_status. Once the file-filler
      // produced a path or any verify state landed, the field IS gating.
      if (MAYBE_MANUAL_CLASSES.has(f.class)) {
        const hasSignal =
          (f.suggested_value != null && f.suggested_value !== '') ||
          (f.verify_status != null);
        if (!hasSignal) continue;
      }
      total++;
      if (READY_STATUSES.has(f.verify_status)) {
        verified++;
      } else {
        missing.push({
          refId: f.refId ?? '',
          label: String(f.label ?? f.refId ?? '(unlabeled)'),
          stepIdx,
          verify_status: f.verify_status ?? null,
        });
      }
    }
  }
  // ready === true when total>0 AND nothing's missing. total===0 means
  // no required fields have been probed yet — stay GRAY so the user
  // doesn't think they can submit before the machine has finished
  // probing. Once the snapshot fills the per_step_draft, total>0.
  const ready = total > 0 && missing.length === 0;
  return { ready, total, verified, missing };
}

/**
 * Decide whether to render the loop progress stepper, and which steps
 * to include. Returns null when no submit_attempts have been logged
 * yet (the gate-only view is enough).
 *
 * @param {Array} submitAttempts - session.submit_attempts
 * @param {{ lastOutcome?: string | null }} machine
 * @returns {{
 *   currentAttempt: number,
 *   maxAttempts: number,
 *   finalized: boolean,
 *   steps: Array<{ kind: 'auto_fill' | 'attempt' | 'fixing' | 'pending', label: string, detail?: string, status: 'done' | 'in_progress' | 'pending' }>,
 * } | null}
 */
export function loopProgressState(submitAttempts, machine) {
  if (!Array.isArray(submitAttempts) || submitAttempts.length === 0) return null;
  // [review H3] Use guards/maxSubmits.mjs MAX_SUBMIT_ATTEMPTS_PER_SESSION
  // as the single source of truth — UI text follows the server policy
  // automatically.
  const maxAttempts = MAX_SUBMIT_ATTEMPTS_PER_SESSION;
  const lastOutcome = machine?.lastOutcome ?? null;
  const finalized =
    lastOutcome === OUTCOME_VALUES.COMPLETED ||
    lastOutcome === OUTCOME_VALUES.ESCALATED ||
    lastOutcome === OUTCOME_VALUES.ERROR;

  const steps = [];
  // Always lead with the auto-fill step — by the time we're here it's done.
  steps.push({ kind: 'auto_fill', label: 'Auto-fill', status: 'done' });

  for (let i = 0; i < submitAttempts.length; i++) {
    const attempt = submitAttempts[i];
    const outcome = attempt?.outcome;
    const isLast = i === submitAttempts.length - 1;
    if (outcome === SUBMIT_ATTEMPT_OUTCOMES.NO_ERRORS) {
      steps.push({
        kind: 'attempt',
        label: `Submit attempt ${attempt.attempt}`,
        detail: 'accepted',
        status: 'done',
      });
      continue;
    }
    if (outcome === SUBMIT_ATTEMPT_OUTCOMES.ERRORS_RETURNED) {
      const errs = Array.isArray(attempt.form_errors) ? attempt.form_errors : [];
      const top = errs[0]?.error_msg ?? `${errs.length} field error${errs.length === 1 ? '' : 's'}`;
      steps.push({
        kind: 'attempt',
        label: `Submit attempt ${attempt.attempt}`,
        detail: top.length > 60 ? top.slice(0, 60) + '…' : top,
        status: 'done',
      });
      // Auto-fix marker — only "in progress" when this is the LAST
      // attempt AND the loop hasn't finalized.
      if (isLast && !finalized) {
        const fixes = Array.isArray(attempt.fixes_tried) ? attempt.fixes_tried.length : 0;
        steps.push({
          kind: 'fixing',
          label: 'Auto-fix in progress',
          detail: fixes > 0 ? `${fixes} field${fixes === 1 ? '' : 's'}` : 'analyzing errors',
          status: 'in_progress',
        });
      }
      continue;
    }
    if (outcome === SUBMIT_ATTEMPT_OUTCOMES.SUBMIT_FAILED) {
      steps.push({
        kind: 'attempt',
        label: `Submit attempt ${attempt.attempt}`,
        detail: 'submit timed out',
        status: 'done',
      });
      continue;
    }
    // Unknown / mid-flight outcome
    steps.push({
      kind: 'attempt',
      label: `Submit attempt ${attempt.attempt}`,
      detail: outcome ? String(outcome) : 'in progress',
      status: isLast && !finalized ? 'in_progress' : 'done',
    });
  }

  // Tail: pending next attempt when we're mid-loop AND not finalized
  // AND under the cap.
  const currentAttempt = submitAttempts.length;
  if (!finalized && currentAttempt < maxAttempts) {
    const lastErrored = submitAttempts[submitAttempts.length - 1]?.outcome
      === SUBMIT_ATTEMPT_OUTCOMES.ERRORS_RETURNED;
    if (lastErrored) {
      steps.push({
        kind: 'pending',
        label: `Submit attempt ${currentAttempt + 1}`,
        status: 'pending',
      });
    }
  }

  return { currentAttempt, maxAttempts, finalized, steps };
}

/**
 * Pull the escalation reason out of the machine status if present.
 * Returns null when not escalated.
 *
 * @param {{ lastOutcome?: string | null, escalationReason?: any, submitAttemptsRun?: number | null }} machine
 */
export function escalationState(machine) {
  if (!machine) return null;
  const escalated = machine.lastOutcome === OUTCOME_VALUES.ESCALATED;
  if (!escalated && !machine.escalationReason) return null;
  const reason = machine.escalationReason || null;
  return {
    // [review H4] Report the true outcome flag — callers that switch
    // on `escalated` shouldn't get a false positive when the server
    // surfaces an escalationReason in advance of the outcome flip.
    escalated,
    code: reason?.code ?? 'unknown',
    detail: reason?.detail ?? null,
    triggered_by: reason?.triggered_by ?? 'machine',
    attempts_run: machine.submitAttemptsRun ?? null,
  };
}

/**
 * Decide what auto-Mark UX to trigger this poll tick.
 *
 *   - 'auto_redirect' — strong signal AND outcome=completed → navigate to
 *     /career/applied + toast
 *   - 'confirm_fallback' — completed but signal isn't strong (user_fallback
 *     or absent) AND it's the first poll tick we've seen this — prompt the
 *     user "did you really click Submit?"
 *   - 'none' — no decision; keep rendering whatever the current phase
 *     dictates
 *
 * `submitDetectedBy` is a STATUS-level field; the field doesn't exist on
 * the wire yet (live wiring to Phase 2/m5 detectSubmitSuccess is a
 * future cross-Room milestone). m10 ships the decision logic + a stable
 * read path so the field can be added without UI changes.
 *
 * @param {{ lastOutcome?: string | null }} machine
 * @param {string | null} submitDetectedBy
 * @param {boolean} alreadyHandled - caller-tracked single-shot guard
 * @returns {'auto_redirect' | 'confirm_fallback' | 'none'}
 */
export function autoMarkDecision(machine, submitDetectedBy, alreadyHandled) {
  if (alreadyHandled) return 'none';
  if (!machine) return 'none';
  if (machine.lastOutcome !== OUTCOME_VALUES.COMPLETED) return 'none';
  if (submitDetectedBy && STRONG_SUBMIT_SIGNALS.has(submitDetectedBy)) {
    return 'auto_redirect';
  }
  if (submitDetectedBy === 'user_fallback') {
    return 'confirm_fallback';
  }
  // No detector signal at all — current Mode 2 behaviour. Stay 'none'
  // and let the manual Mark Applied button work.
  return 'none';
}

/** Sentence-form summary of what's missing — used as a tooltip on the
 *  disabled Mark Applied button. Truncates after 3 entries with a
 *  "+ N more" tail to keep the tooltip readable. */
export function missingSummary(state) {
  if (!state || !Array.isArray(state.missing) || state.missing.length === 0) {
    return null;
  }
  const labels = state.missing.slice(0, 3).map((m) => m.label);
  const extra = state.missing.length - labels.length;
  const tail = extra > 0 ? ` + ${extra} more` : '';
  return `Still missing: ${labels.join(', ')}${tail}`;
}
