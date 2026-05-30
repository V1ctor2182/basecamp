#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step/m10:
// Submit gate + Loop progress + Escalation + autoMark decision.
// Fixture-driven pure helpers — no React renderer, no live backend.

import assert from 'node:assert/strict';

import {
  requiredVerifyState,
  loopProgressState,
  escalationState,
  autoMarkDecision,
  missingSummary,
  OUTCOME_VALUES,
  SUBMIT_ATTEMPT_OUTCOMES,
} from '../src/career/apply/submitGate.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

// ── Fixture helpers ────────────────────────────────────────────────

function mkField(over) {
  return {
    refId: 'f',
    label: 'Field',
    class: 'open',
    verify_status: null,
    required: true,
    ...over,
  };
}

function mkSession(fields) {
  return {
    per_step_draft: {
      '0': { step_idx: 0, fields },
    },
  };
}

// ── exports ───────────────────────────────────────────────────────

test('exports: OUTCOME_VALUES + SUBMIT_ATTEMPT_OUTCOMES frozen', () => {
  assert.ok(Object.isFrozen(OUTCOME_VALUES));
  assert.ok(Object.isFrozen(SUBMIT_ATTEMPT_OUTCOMES));
  assert.equal(OUTCOME_VALUES.ESCALATED, 'escalated');
  assert.equal(SUBMIT_ATTEMPT_OUTCOMES.ERRORS_RETURNED, 'errors_returned');
});

// ── case 1: gate gray when required fields outstanding ───────────

test('case 1: required field unverified → ready=false + missing populated', () => {
  const session = mkSession([
    mkField({ refId: 'email', verify_status: 'mismatch', label: 'Email' }),
    mkField({ refId: 'phone', verify_status: 'verified', label: 'Phone' }),
  ]);
  const state = requiredVerifyState(session);
  assert.equal(state.ready, false);
  assert.equal(state.total, 2);
  assert.equal(state.verified, 1);
  assert.equal(state.missing.length, 1);
  assert.equal(state.missing[0].refId, 'email');
  // tooltip
  const tip = missingSummary(state);
  assert.match(tip, /Still missing: Email/);
});

// ── case 2: gate green when all required verified ─────────────────

test('case 2: all required verified → ready=true + missing=[]', () => {
  const session = mkSession([
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'verified' }),
    mkField({ refId: 'c', verify_status: 'skipped_by_user' }),  // counts
  ]);
  const state = requiredVerifyState(session);
  assert.equal(state.ready, true);
  assert.equal(state.total, 3);
  assert.equal(state.verified, 3);
  assert.equal(missingSummary(state), null);
});

// ── case 2b: optional + manual fields don't gate ─────────────────

test('case 2b: optional + signal-less manual fields excluded from gate', () => {
  // [review H1/H2] file + manual classes EXCLUDED only when there's no
  // signal at all (suggested_value AND verify_status both null/empty).
  const session = mkSession([
    mkField({ refId: 'a', verify_status: 'verified', required: true }),
    mkField({ refId: 'opt', verify_status: 'mismatch', required: false }),
    mkField({ refId: 'cap', verify_status: null, suggested_value: null, class: 'manual' }),  // signal-less → excluded
    mkField({ refId: 'unfilled-file', verify_status: null, suggested_value: null, class: 'file' }),  // signal-less → excluded
  ]);
  const state = requiredVerifyState(session);
  assert.equal(state.ready, true);
  assert.equal(state.total, 1);  // only the one required-non-signal-manual
  assert.equal(state.verified, 1);
});

// [review H1] file class WITH suggested_value (machine-filled) gates the submit
test('case 2d [H1]: required file with suggested_value gates submit', () => {
  const session = mkSession([
    mkField({ refId: 'a', verify_status: 'verified', required: true }),
    // resume file: file-filler produced a path → MUST verify before submit
    mkField({
      refId: '__file_0',
      class: 'file',
      suggested_value: '/tmp/resume.pdf',
      verify_status: null,
      label: 'Resume',
    }),
  ]);
  const state = requiredVerifyState(session);
  assert.equal(state.ready, false, 'file with suggested_value must gate');
  assert.equal(state.missing.length, 1);
  assert.equal(state.missing[0].label, 'Resume');
});

// [review H2] manual class WITH verify_status gates the submit
test('case 2e [H2]: required manual field with verify_status gates submit', () => {
  const session = mkSession([
    mkField({ refId: 'a', verify_status: 'verified' }),
    // CAPTCHA the machine probed but couldn't classify → still pending operator
    mkField({
      refId: '__captcha',
      class: 'manual',
      suggested_value: null,
      verify_status: 'not_seen',
      label: 'CAPTCHA',
    }),
  ]);
  const state = requiredVerifyState(session);
  assert.equal(state.ready, false, 'CAPTCHA with verify_status must gate');
  assert.equal(state.missing[0].label, 'CAPTCHA');
});

// ── case 2c: empty session → not ready (don't flash green before probe) ──

test('case 2c: empty session → ready=false (no probing done yet)', () => {
  const state = requiredVerifyState({ per_step_draft: {} });
  assert.equal(state.ready, false);
  assert.equal(state.total, 0);
});

// ── case 3: submit_attempts[0]='errors_returned' → stepper with attempt 2 pending ──

test('case 3: 1 attempt with errors → stepper shows auto-fix in_progress + attempt 2 pending', () => {
  const attempts = [{
    attempt: 1,
    started_at: '2026-05-30T10:00:00Z',
    form_errors: [{ field: 'phone', error_code: 'invalid_format', error_msg: 'Phone invalid format' }],
    fixes_tried: [{ field: 'phone', fix_name: 'keyboard_input', result: 'no_effect' }, { field: 'phone', fix_name: 'react_select_click', result: 'no_effect' }],
    outcome: 'errors_returned',
  }];
  const state = loopProgressState(attempts, { lastOutcome: null });
  assert.ok(state, 'state must be non-null');
  assert.equal(state.currentAttempt, 1);
  assert.equal(state.maxAttempts, 3);
  assert.equal(state.finalized, false);
  // Should have: auto_fill done + attempt 1 done + fixing in_progress + attempt 2 pending
  const labels = state.steps.map((s) => `${s.kind}:${s.status}`);
  assert.deepEqual(labels, [
    'auto_fill:done',
    'attempt:done',
    'fixing:in_progress',
    'pending:pending',
  ]);
  // detail surfaces top error_msg
  assert.match(state.steps[1].detail, /phone invalid/i);
  assert.match(state.steps[2].detail, /2 field/i);
});

// ── case 4: 3 attempts + escalated → escalation view active ──────

test('case 4: 3 attempts + lastOutcome=escalated → finalized + escalation state set', () => {
  const attempts = [
    { attempt: 1, started_at: '2026-05-30T10:00:00Z', form_errors: [{ field: 'x', error_code: 'required', error_msg: 'Required' }], fixes_tried: [], outcome: 'errors_returned' },
    { attempt: 2, started_at: '2026-05-30T10:01:00Z', form_errors: [{ field: 'x', error_code: 'required', error_msg: 'Required' }], fixes_tried: [], outcome: 'errors_returned' },
    { attempt: 3, started_at: '2026-05-30T10:02:00Z', form_errors: [{ field: 'x', error_code: 'required', error_msg: 'Required' }], fixes_tried: [], outcome: 'errors_returned' },
  ];
  const machine = {
    lastOutcome: OUTCOME_VALUES.ESCALATED,
    escalationReason: {
      code: 'max_submits',
      detail: 'Reached the 3-submit policy cap without success.',
      triggered_by: 'machine',
    },
    submitAttemptsRun: 3,
  };
  const loop = loopProgressState(attempts, machine);
  assert.equal(loop.finalized, true);
  // No "fixing" or "pending" step when finalized — just attempts 1/2/3 done
  const kinds = loop.steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['auto_fill', 'attempt', 'attempt', 'attempt']);

  const esc = escalationState(machine);
  assert.ok(esc);
  assert.equal(esc.code, 'max_submits');
  assert.equal(esc.attempts_run, 3);
  assert.equal(esc.triggered_by, 'machine');
});

// ── case 5: autoMark — strong signal → auto_redirect ─────────────

test('case 5: autoMarkDecision — completed + strong signal → auto_redirect', () => {
  const machine = { lastOutcome: 'completed' };
  for (const sig of ['url_pattern', 'thank_you_text', 'network_signal']) {
    assert.equal(autoMarkDecision(machine, sig, false), 'auto_redirect',
      `strong signal "${sig}" must auto-redirect`);
  }
});

// ── case 6: autoMark — user_fallback → confirm_fallback modal ─────

test('case 6: autoMarkDecision — completed + user_fallback → confirm_fallback', () => {
  const machine = { lastOutcome: 'completed' };
  assert.equal(autoMarkDecision(machine, 'user_fallback', false), 'confirm_fallback');
});

// ── case 7: autoMark idempotent — alreadyHandled returns 'none' ──

test('case 7: autoMarkDecision — alreadyHandled short-circuits', () => {
  const machine = { lastOutcome: 'completed' };
  assert.equal(autoMarkDecision(machine, 'url_pattern', true), 'none',
    'must not trigger again after caller has already navigated');
});

// ── case 8: not completed → 'none' regardless of signal ──────────

test('case 8: autoMarkDecision — non-completed outcome stays "none"', () => {
  assert.equal(autoMarkDecision({ lastOutcome: 'paused' }, 'url_pattern', false), 'none');
  assert.equal(autoMarkDecision({ lastOutcome: 'escalated' }, 'url_pattern', false), 'none');
  assert.equal(autoMarkDecision({ lastOutcome: 'error' }, 'url_pattern', false), 'none');
  assert.equal(autoMarkDecision({ lastOutcome: null }, 'url_pattern', false), 'none');
});

// ── case 9: escalation false when neither lastOutcome nor reason set ─

test('case 9: escalationState — no escalation signal → null', () => {
  assert.equal(escalationState({ lastOutcome: 'completed' }), null);
  assert.equal(escalationState({ lastOutcome: null }), null);
  // Even with no lastOutcome, if escalationReason populated → still surfaces.
  // (Server may surface escalation_reason before lastOutcome flips.)
  const esc = escalationState({
    lastOutcome: null,
    escalationReason: { code: 'user_cancel', detail: 'cancelled', triggered_by: 'user' },
  });
  assert.ok(esc);
  assert.equal(esc.code, 'user_cancel');
  // [review H4] escalated FIELD reports the true outcome — false when
  // reason is set but lastOutcome hasn't flipped yet.
  assert.equal(esc.escalated, false,
    'escalated flag must reflect lastOutcome accurately, not reason presence');
  // And TRUE when outcome flipped:
  const esc2 = escalationState({
    lastOutcome: 'escalated',
    escalationReason: { code: 'max_submits', triggered_by: 'machine' },
  });
  assert.equal(esc2.escalated, true);
});

// ── case 10: loop with 0 attempts → null (no stepper) ────────────

test('case 10: loopProgressState — 0 attempts → null', () => {
  assert.equal(loopProgressState([], { lastOutcome: null }), null);
  assert.equal(loopProgressState(null, { lastOutcome: null }), null);
});

// ── case 11: malformed input doesn't crash ───────────────────────

test('case 11 [defensive]: malformed inputs safely degrade', () => {
  const empty = requiredVerifyState(null);
  assert.deepEqual(empty, { ready: false, total: 0, verified: 0, missing: [] });
  assert.equal(loopProgressState(null, null), null);
  assert.equal(escalationState(null), null);
  assert.equal(autoMarkDecision(null, null, false), 'none');
});

// [review L3] missingSummary truncation tail when N>3
test('case 12 [L3]: missingSummary truncates at 3 + N more', () => {
  const session = mkSession([
    mkField({ refId: 'f1', verify_status: 'mismatch', label: 'Email' }),
    mkField({ refId: 'f2', verify_status: 'mismatch', label: 'Phone' }),
    mkField({ refId: 'f3', verify_status: 'mismatch', label: 'Address' }),
    mkField({ refId: 'f4', verify_status: 'mismatch', label: 'Zip' }),
    mkField({ refId: 'f5', verify_status: 'mismatch', label: 'City' }),
  ]);
  const state = requiredVerifyState(session);
  const tip = missingSummary(state);
  assert.match(tip, /^Still missing: Email, Phone, Address \+ 2 more$/);
});

// [review L3] submit_failed (network timeout) last attempt — no pending tail
test('case 13 [L3]: submit_failed last attempt → no pending tail', () => {
  const attempts = [
    { attempt: 1, started_at: '2026-05-30T10:00Z', form_errors: [], fixes_tried: [], outcome: 'submit_failed' },
  ];
  const state = loopProgressState(attempts, { lastOutcome: null });
  const kinds = state.steps.map((s) => s.kind);
  // Just auto_fill done + attempt 1 done. No fixing, no pending.
  assert.deepEqual(kinds, ['auto_fill', 'attempt']);
});

// [review L3] autoMarkDecision with machine===undefined safely returns 'none'
test('case 14 [L3]: autoMarkDecision — undefined machine → none', () => {
  assert.equal(autoMarkDecision(undefined, 'url_pattern', false), 'none');
});

console.log(`\n✅ ${passed} smoke tests passed`);
