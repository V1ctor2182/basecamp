#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step/m11:
// 4 Recovery flows — pure helpers + 4 endpoint handlers + user_hints[]
// envelope schema extension.
//
// Fixture-driven; same pattern as smoke-apply-ui-field-cards.

process.env.SMOKE = '1';

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  shouldShowResumeCompress,
  shouldShowAltFormats,
  shouldShowIdentifyAts,
  shouldShowUserHint,
  altFormatLadder,
  parseUserHint,
  fieldRecoveryAffordances,
  RECOVERY_ATSES,
} from '../src/career/apply/recovery.mjs';

import {
  recoverResumeCompress as epResumeCompress,
  recoverAltFormats as epAltFormats,
  recoverIdentifyAts as epIdentifyAts,
  recoverUserHint as epUserHint,
  RecoverResumeCompressBodySchema,
  RecoverAltFormatsBodySchema,
  RecoverIdentifyAtsBodySchema,
  RecoverUserHintBodySchema,
} from '../src/career/applier/multistep/endpoint.mjs';

import {
  writeSession,
  readSession,
  APPLY_SESSIONS_DIR,
  USER_HINT_KINDS,
  USER_HINT_RESULTS,
} from '../src/career/applier/multistep/applySessionsStore.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

const JOB_ID = 'bbccddeeff00';

await fs.mkdir(APPLY_SESSIONS_DIR, { recursive: true });

async function writeFixtureSession(over = {}) {
  const session = {
    jobId: JOB_ID,
    site_adapter: 'generic',  // triggers Recovery 3
    job_url: 'https://example.com/jobs/y',
    current_step: 0,
    total_steps: 1,
    per_step_draft: {
      '0': {
        step_idx: 0,
        captured_at: '2026-05-30T10:00:00Z',
        fields: [
          { refId: 'phone', label: 'Phone', class: 'phone', suggested_value: '929-235-3841', verify_status: 'fill_error' },
          { refId: '__file_0', label: 'Resume', class: 'file', suggested_value: '/tmp/resume.pdf', verify_status: 'mismatch' },
        ],
      },
    },
    per_step_status: { '0': 'pending' },
    field_memory: {},
    started_at: '2026-05-30T10:00:00Z',
    last_activity_at: '2026-05-30T10:05:00Z',
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

// ── Schema exports ───────────────────────────────────────────────

await test('exports: USER_HINT_KINDS + USER_HINT_RESULTS + RECOVERY_ATSES frozen', () => {
  assert.ok(Object.isFrozen(USER_HINT_KINDS));
  assert.ok(Object.isFrozen(USER_HINT_RESULTS));
  assert.ok(Object.isFrozen(RECOVERY_ATSES));
  assert.deepEqual([...USER_HINT_KINDS], [
    'resume_compress', 'alt_format_choice', 'ats_identification', 'free_text',
  ]);
  assert.deepEqual([...RECOVERY_ATSES], [
    'greenhouse', 'lever', 'workday', 'icims', 'unknown', 'skip',
  ]);
});

// ── case 1: Resume compress trigger conditions ───────────────────

await test('case 1: shouldShowResumeCompress — too_large on resume slot', () => {
  const field = { refId: '__file_0', class: 'file' };
  assert.equal(shouldShowResumeCompress(field, [
    { field: '__file_0', error_code: 'too_large', error_msg: 'File too large' },
  ]), true);
  // Non-file field — never
  assert.equal(shouldShowResumeCompress({ refId: 'x', class: 'text' }, [
    { error_code: 'too_large' },
  ]), false);
  // Unrelated error — false
  assert.equal(shouldShowResumeCompress(field, [
    { error_code: 'required' },
  ]), false);
});

// [review H2] unattributed errors only resolve against resume slot
test('case 1b [H2]: unattributed too_large only matches resume slot', () => {
  const resume = { refId: '__file_0', class: 'file' };
  const passport = { refId: '__file_3', class: 'file' };
  const resumeBySubclass = { refId: '__file_1', class: 'file', subclass: 'resume' };
  const unattributed = [{ error_code: 'too_large', error_msg: 'File too large' }];
  // Resume slot (by refId convention) → true
  assert.equal(shouldShowResumeCompress(resume, unattributed), true);
  // Resume slot (by subclass='resume') → true
  assert.equal(shouldShowResumeCompress(resumeBySubclass, unattributed), true);
  // Other file field (passport) → false
  assert.equal(shouldShowResumeCompress(passport, unattributed), false);
});

// ── case 2: Resume compress endpoint POST → user_hints[] record ─

await test('case 2: recoverResumeCompress → 202 + user_hints entry persisted', async () => {
  await writeFixtureSession();
  const result = await epResumeCompress(JOB_ID, RecoverResumeCompressBodySchema.parse({ ref: '__file_0' }));
  assert.equal(result.status, 202);
  assert.equal(result.pending_wire, true);
  assert.equal(result.kind, 'resume_compress');

  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints.length, 1);
  assert.equal(persisted.user_hints[0].kind, 'resume_compress');
  assert.equal(persisted.user_hints[0].field_ref, '__file_0');
  assert.equal(persisted.user_hints[0].result, 'pending_wire');
  await cleanupSession();
});

// ── case 3: Resume compress retry → success path (stub) ─────────

await test('case 3: recoverResumeCompress idempotent — second call adds 2nd entry', async () => {
  await writeFixtureSession();
  await epResumeCompress(JOB_ID, RecoverResumeCompressBodySchema.parse({ ref: '__file_0' }));
  await epResumeCompress(JOB_ID, RecoverResumeCompressBodySchema.parse({ ref: '__file_0' }));
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints.length, 2);
  await cleanupSession();
});

// ── case 4: Alt formats trigger ─────────────────────────────────

await test('case 4: shouldShowAltFormats — phone subclass + invalid_format', () => {
  const phoneField = { refId: 'phone', class: 'phone' };
  assert.equal(shouldShowAltFormats(phoneField, [
    { field: 'phone', error_code: 'invalid_format' },
  ]), true);
  // No ladder for class=open
  assert.equal(shouldShowAltFormats({ refId: 'cover', class: 'open' }, [
    { error_code: 'invalid_format' },
  ]), false);
});

// [review H1] real-prod path: classifier emits class='hard' + subclass='phone'
test('case 4b [H1]: real-prod field shape class=hard + subclass=phone triggers altFormats', () => {
  const field = { refId: 'phone', class: 'hard', subclass: 'phone' };
  assert.equal(shouldShowAltFormats(field, [
    { field: 'phone', error_code: 'invalid_format' },
  ]), true);
});

// ── case 5: Alt formats POST with chosen value ──────────────────

await test('case 5: recoverAltFormats — chosen value recorded', async () => {
  await writeFixtureSession();
  const result = await epAltFormats(JOB_ID, RecoverAltFormatsBodySchema.parse({
    ref: 'phone',
    chosen: '(929) 235-3841',
  }));
  assert.equal(result.status, 202);
  assert.equal(result.chosen, '(929) 235-3841');
  assert.equal(result.pending_wire, true);
  const persisted = await readSession(JOB_ID);
  assert.match(persisted.user_hints[0].hint, /\(929\) 235-3841/);
  await cleanupSession();
});

// ── case 6: Alt format 2nd in ladder hypothetically wins (test the ladder) ──

await test('case 6: altFormatLadder returns 4-wide phone + 3-wide date + null otherwise', () => {
  const phone = altFormatLadder('phone');
  assert.equal(phone.length, 4);
  assert.ok(phone.includes('+19292353841'));
  const date = altFormatLadder('date');
  assert.equal(date.length, 3);
  assert.equal(altFormatLadder('open'), null);
  assert.equal(altFormatLadder(null), null);
});

// ── case 7: Identify ATS — generic adapter triggers UI ─────────

await test('case 7: shouldShowIdentifyAts — site_adapter=generic triggers', async () => {
  const session = { site_adapter: 'generic' };
  assert.equal(shouldShowIdentifyAts(session), true);
  assert.equal(shouldShowIdentifyAts({ site_adapter: 'workday' }), false);
  assert.equal(shouldShowIdentifyAts({}), false);
  assert.equal(shouldShowIdentifyAts(null), false);
});

// ── case 8: Identify ATS POST records user choice ──────────────

await test('case 8: recoverIdentifyAts greenhouse → recorded with kind=ats_identification', async () => {
  await writeFixtureSession();
  const result = await epIdentifyAts(JOB_ID, RecoverIdentifyAtsBodySchema.parse({ ats: 'greenhouse' }));
  assert.equal(result.status, 202);
  assert.equal(result.ats, 'greenhouse');
  assert.equal(result.pending_wire, true);
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints[0].kind, 'ats_identification');
  assert.match(persisted.user_hints[0].hint, /ats=greenhouse/);
  await cleanupSession();
});

await test('case 8b: recoverIdentifyAts — "I don\'t know" still records', async () => {
  await writeFixtureSession();
  const result = await epIdentifyAts(JOB_ID, RecoverIdentifyAtsBodySchema.parse({ ats: 'unknown' }));
  assert.equal(result.status, 202);
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints[0].kind, 'ats_identification');
  assert.match(persisted.user_hints[0].hint, /ats=unknown/);
  await cleanupSession();
});

await test('case 8c: recoverIdentifyAts — invalid ats rejected by Zod', () => {
  assert.throws(
    () => RecoverIdentifyAtsBodySchema.parse({ ats: 'foobar' }),
    /Invalid/,
  );
});

// ── case 9: User hint trigger conditions ───────────────────────

await test('case 9: shouldShowUserHint — fill_error / all_strategies_failed', () => {
  assert.equal(shouldShowUserHint({ verify_status: 'fill_error' }), true);
  assert.equal(shouldShowUserHint({ verify_status: 'all_strategies_failed' }), true);
  assert.equal(shouldShowUserHint({ verify_status: 'verified' }), false);
  assert.equal(shouldShowUserHint({ verify_status: 'mismatch' }), false);
});

// ── case 10: parseUserHint — strong + medium + null ────────────

await test('case 10: parseUserHint covers 4 strong patterns + medium + null', () => {
  // strong
  assert.deepEqual(parseUserHint('I had to scroll inside the dropdown'),
    { strategy: 'keyboard_input', confidence: 'high' });
  assert.deepEqual(parseUserHint('Click the first option'),
    { strategy: 'role_locator_click', confidence: 'high' });
  assert.deepEqual(parseUserHint('open the control then type'),
    { strategy: 'react_select_click', confidence: 'high' });
  assert.deepEqual(parseUserHint('use the popup'),
    { strategy: 'aria_combobox', confidence: 'high' });
  // medium fallbacks
  assert.equal(parseUserHint('you have to type it').strategy, 'keyboard_input');
  assert.equal(parseUserHint('Click on it').strategy, 'role_locator_click');
  // unparseable
  assert.equal(parseUserHint('it just works in safari'), null);
  assert.equal(parseUserHint(''), null);
  assert.equal(parseUserHint(null), null);
});

// [review M1] tightened regex — these MUST NOT match the strong patterns
test('case 10b [M1]: parseUserHint regex precision', () => {
  // "click somewhere first" used to false-positive into role_locator_click
  const sw = parseUserHint('I had to click somewhere first');
  // Either medium 'click' → role_locator_click OR null — NOT high confidence
  assert.ok(sw === null || sw.confidence !== 'high',
    `"click somewhere first" must not be high-confidence; got ${JSON.stringify(sw)}`);
  // double-click and right-click → null (no strategy slot)
  assert.equal(parseUserHint('double-click then type'), null);
  assert.equal(parseUserHint('right click and pick the option'), null);
  // explicit option noun still high
  assert.equal(parseUserHint('Click the first match').confidence, 'high');
  assert.equal(parseUserHint('click the first one').confidence, 'high');
});

// ── case 11: User hint POST — parseable → pending_wire ─────────

await test('case 11: recoverUserHint — parseable hint → pending_wire', async () => {
  await writeFixtureSession();
  const result = await epUserHint(JOB_ID, RecoverUserHintBodySchema.parse({
    ref: 'phone',
    hint: 'scroll inside the dropdown to find it',
  }));
  assert.equal(result.status, 202);
  assert.equal(result.parsed_strategy, 'keyboard_input');
  assert.equal(result.parse_confidence, 'high');
  assert.equal(result.pending_wire, true);
  assert.equal(result.result, 'pending_wire');
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints[0].kind, 'free_text');
  assert.equal(persisted.user_hints[0].attempted_strategy, 'keyboard_input');
  await cleanupSession();
});

// ── case 12: User hint POST — unparseable → recorded_only ──────

await test('case 12: recoverUserHint — unparseable hint → recorded_only', async () => {
  await writeFixtureSession();
  const result = await epUserHint(JOB_ID, RecoverUserHintBodySchema.parse({
    ref: 'phone',
    hint: 'it just works in safari',
  }));
  assert.equal(result.status, 202);
  assert.equal(result.parsed_strategy, null);
  assert.equal(result.pending_wire, false);
  assert.equal(result.result, 'recorded_only');
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints[0].attempted_strategy, null);
  assert.equal(persisted.user_hints[0].result, 'recorded_only');
  await cleanupSession();
});

// ── case 13: fieldRecoveryAffordances composes ────────────────

await test('case 13: fieldRecoveryAffordances — phone with invalid_format + fill_error', () => {
  const field = { refId: 'phone', class: 'phone', verify_status: 'fill_error' };
  const submitAttempts = [{
    form_errors: [{ field: 'phone', error_code: 'invalid_format' }],
    fixes_tried: [],
    outcome: 'errors_returned',
  }];
  const aff = fieldRecoveryAffordances(field, submitAttempts);
  assert.equal(aff.altFormats, true);
  assert.equal(aff.altLadder.length, 4);
  assert.equal(aff.userHint, true);  // fill_error trigger
  assert.equal(aff.resumeCompress, false);
});

// ── case 14: schema migration — pre-m11 session loads with user_hints=[] ─

await test('case 14: pre-m11 session (no user_hints) loads with default []', async () => {
  // Write a session without user_hints — Zod .default([]) should backfill
  // on the next read.
  const sessionFile = path.join(APPLY_SESSIONS_DIR, `${JOB_ID}.json`);
  const minimal = {
    jobId: JOB_ID,
    site_adapter: 'generic',
    job_url: 'https://example.com/jobs/z',
    current_step: 0,
    total_steps: 1,
    per_step_draft: { '0': { step_idx: 0, captured_at: '2026-05-30T10:00:00Z', fields: [] } },
    per_step_status: { '0': 'pending' },
    field_memory: {},
    started_at: '2026-05-30T10:00:00Z',
    last_activity_at: '2026-05-30T10:05:00Z',
    status: 'active',
    submit_attempts: [],
    // NO user_hints
  };
  await fs.writeFile(sessionFile, JSON.stringify(minimal, null, 2));
  const loaded = await readSession(JOB_ID);
  assert.deepEqual(loaded.user_hints, []);
  await cleanupSession();
});

// ── case 15: concurrent recovery POSTs both persist (C1 from m9 review) ─

await test('case 15: concurrent recoverUserHint + recoverIdentifyAts both persist', async () => {
  await writeFixtureSession();
  const [r1, r2] = await Promise.all([
    epUserHint(JOB_ID, RecoverUserHintBodySchema.parse({ ref: 'phone', hint: 'click first option' })),
    epIdentifyAts(JOB_ID, RecoverIdentifyAtsBodySchema.parse({ ats: 'lever' })),
  ]);
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  const persisted = await readSession(JOB_ID);
  assert.equal(persisted.user_hints.length, 2,
    'both concurrent recovery hints must persist (withSessionLock)');
  const kinds = persisted.user_hints.map((h) => h.kind).sort();
  assert.deepEqual(kinds, ['ats_identification', 'free_text']);
  await cleanupSession();
});

// ── case 16: invalid jobId / missing session paths ────────────

await test('case 16: error paths — invalid jobId 400, missing session 404', async () => {
  await cleanupSession();
  const r1 = await epUserHint('not-hex', RecoverUserHintBodySchema.parse({ ref: 'x', hint: 'h' }));
  assert.equal(r1.status, 400);
  const r2 = await epIdentifyAts(JOB_ID, RecoverIdentifyAtsBodySchema.parse({ ats: 'workday' }));
  assert.equal(r2.status, 404);
});

// [review L3] cap overflow surfaces SESSION_MAX_USER_HINTS, not a generic 500
await test('case 17 [L3]: user_hints cap exhaustion → 500 with SESSION_MAX_USER_HINTS', async () => {
  const { MAX_USER_HINTS } = await import('../src/career/applier/multistep/applySessionsStore.mjs');
  // Pre-fill MAX_USER_HINTS entries
  const fullHints = Array.from({ length: MAX_USER_HINTS }, (_, i) => ({
    kind: 'free_text',
    field_ref: 'phone',
    hint: `pre-existing #${i}`,
    timestamp: new Date().toISOString(),
    attempted_strategy: null,
    result: 'recorded_only',
  }));
  await writeFixtureSession({ user_hints: fullHints });
  const result = await epUserHint(JOB_ID, RecoverUserHintBodySchema.parse({
    ref: 'phone',
    hint: 'should fail with cap',
  }));
  assert.equal(result.status, 500);
  assert.match(result.error, /cap reached/i);
  await cleanupSession();
});

console.log(`\n✅ ${passed} smoke tests passed`);
