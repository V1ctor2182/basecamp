#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step/m14:
// submitDetectedBy signal flows through submitLoop → machine →
// endpoint.getStatus response.
//
// Pure-Node — exercises the plumbing via direct module calls. The
// actual Page interaction (URL change, text match, network listener)
// is covered by smoke-applier-submit-flow.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

import { runSubmitLoop } from '../src/career/applier/multistep/submitLoop.mjs';
import { dispatchLoopOutcome as _dispatch } from '../src/career/applier/multistep/machine.mjs';
import {
  writeSession,
  APPLY_SESSIONS_DIR,
} from '../src/career/applier/multistep/applySessionsStore.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

const JOB_ID = 'aacdef012345';

await fs.mkdir(APPLY_SESSIONS_DIR, { recursive: true });

async function writeFixtureSession(over = {}) {
  const session = {
    jobId: JOB_ID,
    site_adapter: 'generic',
    job_url: 'https://example.com/jobs/y',
    current_step: 0,
    total_steps: 1,
    per_step_draft: {
      '0': {
        step_idx: 0,
        captured_at: '2026-06-01T00:00:00Z',
        fields: [{ refId: 'email', class: 'open', label: 'Email', suggested_value: 'me@x.com' }],
      },
    },
    per_step_status: { '0': 'pending' },
    field_memory: {},
    started_at: '2026-06-01T00:00:00Z',
    last_activity_at: '2026-06-01T00:00:00Z',
    status: 'active',
    submit_attempts: [],
    user_hints: [],
    ...over,
  };
  await writeSession(JOB_ID, session);
  return session;
}

async function cleanupSession() {
  try { await fs.unlink(path.join(APPLY_SESSIONS_DIR, `${JOB_ID}.json`)); }
  catch { /* may not exist */ }
}

// ── case 1: submitLoop returns submit_detected_by ───────────────

await test('case 1: submitLoop submitted → submit_detected_by populated from _detectSubmitSuccess', async () => {
  const session = await writeFixtureSession();
  const mockPage = {};  // unused by mocks
  const loopRes = await runSubmitLoop({
    jobId: JOB_ID,
    session,
    page: mockPage,
    siteAdapter: 'generic',
    deps: {
      _submitForm: async () => ({ outcome: 'submitted', url_after: 'https://x/thank-you' }),
      _parseFormErrors: async () => [],
      _fixField: async () => ({ field: '', fix_name: '', result: '', success: true }),
      _detectSubmitSuccess: async () => 'url_pattern',
      _now: () => Date.now(),
      _sleep: () => Promise.resolve(),
    },
  });
  assert.equal(loopRes.outcome, 'submitted');
  assert.equal(loopRes.submit_detected_by, 'url_pattern');
  await cleanupSession();
});

// ── case 2: detector returns null → submit_detected_by null ─────

await test('case 2: detector returns null → loopRes.submit_detected_by=null', async () => {
  const session = await writeFixtureSession();
  const loopRes = await runSubmitLoop({
    jobId: JOB_ID,
    session,
    page: {},
    siteAdapter: 'generic',
    deps: {
      _submitForm: async () => ({ outcome: 'submitted' }),
      _parseFormErrors: async () => [],
      _fixField: async () => ({ field: '', fix_name: '', result: '', success: true }),
      _detectSubmitSuccess: async () => null,
      _now: () => Date.now(),
      _sleep: () => Promise.resolve(),
    },
  });
  assert.equal(loopRes.outcome, 'submitted');
  assert.equal(loopRes.submit_detected_by, null);
  await cleanupSession();
});

// ── case 3: detector throws → submit_detected_by null (graceful) ─

await test('case 3: detector throws → loopRes still submitted + detected_by null', async () => {
  const session = await writeFixtureSession();
  const loopRes = await runSubmitLoop({
    jobId: JOB_ID,
    session,
    page: {},
    siteAdapter: 'generic',
    deps: {
      _submitForm: async () => ({ outcome: 'submitted' }),
      _parseFormErrors: async () => [],
      _fixField: async () => ({ field: '', fix_name: '', result: '', success: true }),
      _detectSubmitSuccess: async () => { throw new Error('detector exploded'); },
      _now: () => Date.now(),
      _sleep: () => Promise.resolve(),
    },
  });
  // Detector errors must NOT derail the success path
  assert.equal(loopRes.outcome, 'submitted');
  assert.equal(loopRes.submit_detected_by, null);
  await cleanupSession();
});

// ── case 4: no _detectSubmitSuccess injected → null ─────────────

await test('case 4: missing detector dep → submit_detected_by=null', async () => {
  const session = await writeFixtureSession();
  const loopRes = await runSubmitLoop({
    jobId: JOB_ID,
    session,
    page: {},
    siteAdapter: 'generic',
    deps: {
      _submitForm: async () => ({ outcome: 'submitted' }),
      _parseFormErrors: async () => [],
      _fixField: async () => ({ field: '', fix_name: '', result: '', success: true }),
      // NO _detectSubmitSuccess
      _now: () => Date.now(),
      _sleep: () => Promise.resolve(),
    },
  });
  assert.equal(loopRes.outcome, 'submitted');
  assert.equal(loopRes.submit_detected_by, null);
  await cleanupSession();
});

// ── case 5: dispatchLoopOutcome forwards submit_detected_by ─────

await test('case 5: dispatchLoopOutcome forwards submit_detected_by via loopOutcomeMeta', () => {
  const dispatched = _dispatch({
    outcome: 'submitted',
    attempts_run: 1,
    final_session: { status: 'active' },
    submit_detected_by: 'thank_you_text',
  });
  assert.equal(dispatched.loopOutcomeMeta?.submit_detected_by, 'thank_you_text');
});

// ── case 6: dispatchLoopOutcome with no detector → meta=null ────

await test('case 6: dispatchLoopOutcome — null detected_by → no meta', () => {
  const dispatched = _dispatch({
    outcome: 'submitted',
    final_session: { status: 'active' },
    submit_detected_by: null,
  });
  // submit_detected_by present but null → meta has the field
  assert.equal(dispatched.loopOutcomeMeta?.submit_detected_by, null);
});

// ── case 7: dispatchLoopOutcome with detected_by UNDEFINED → no meta key ─

await test('case 7: dispatchLoopOutcome — undefined detected_by → no meta field', () => {
  const dispatched = _dispatch({
    outcome: 'submitted',
    final_session: { status: 'active' },
    // submit_detected_by intentionally absent
  });
  // Backward compat: when the field is absent (pre-m14 callers),
  // loopOutcomeMeta stays null so existing endpoint surface
  // doesn't get a stale null override.
  assert.equal(dispatched.loopOutcomeMeta, null);
});

// [review M2] unknown submitDetectedBy values get stripped to null with warn
await test('case 8 [M2]: dispatchLoopOutcome handles unknown signal — passes through to ctrl logic in endpoint', () => {
  const dispatched = _dispatch({
    outcome: 'submitted',
    final_session: { status: 'active' },
    submit_detected_by: 'future_phase_6_signal',
  });
  // Dispatcher forwards as-is; endpoint.mjs is responsible for the
  // enum check + console.warn drop-to-null (covered by manual inspection).
  assert.equal(dispatched.loopOutcomeMeta?.submit_detected_by, 'future_phase_6_signal');
});

if (failed > 0) {
  console.error(`\n❌ ${failed} failed (${passed} passed)`);
  process.exit(1);
}
console.log(`\n✅ ${passed} smoke tests passed`);
