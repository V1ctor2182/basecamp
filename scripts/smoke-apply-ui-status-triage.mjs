#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step/m8:
// Apply.tsx Status board + Triage view data transforms.
//
// Exercises triage.mjs pure helpers via fixture envelopes — no React
// renderer, no live backend. The React component (Apply.tsx) just
// renders the output of these functions; locking them locks the UI.

import assert from 'node:assert/strict';

import {
  aggregateFields,
  computeStatusCounts,
  groupByAncestor,
  sortTriageEntries,
  buildTriageState,
  chipKindFor,
  CHIP_KINDS,
} from '../src/career/apply/triage.mjs';

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

// ── Helpers ─────────────────────────────────────────────────────────

function mkField(over) {
  return {
    refId: 'f1',
    label: 'Field',
    class: 'text',
    suggested_value: 'x',
    verify_status: 'verified',
    role: null,
    required: true,
    control_fingerprint: null,
    ...over,
  };
}

function mkSession(stepDrafts) {
  // stepDrafts is an array of { stepIdx, fields }
  const per_step_draft = {};
  for (const { stepIdx, fields } of stepDrafts) {
    per_step_draft[String(stepIdx)] = { step_idx: stepIdx, fields };
  }
  return {
    jobId: '0123456789ab',
    site_adapter: 'greenhouse',
    job_url: 'https://example.com/jobs/x',
    current_step: 0,
    total_steps: stepDrafts.length || null,
    per_step_draft,
    per_step_status: {},
    field_memory: {},
    started_at: '2026-05-28T10:00:00Z',
    last_activity_at: '2026-05-28T10:05:00Z',
    status: 'active',
    submit_attempts: [],
  };
}

// ── Exports ─────────────────────────────────────────────────────────

test('exports: CHIP_KINDS frozen + 3 entries in order', () => {
  assert.ok(Object.isFrozen(CHIP_KINDS));
  assert.deepEqual([...CHIP_KINDS], ['to_retry', 'unlabeled', 'manual']);
});

// ── chipKindFor — bucket classifier ─────────────────────────────────

test('chipKindFor: verified → null', () => {
  assert.equal(chipKindFor(mkField({ verify_status: 'verified' })), null);
});
test('chipKindFor: mismatch / fill_error → to_retry', () => {
  assert.equal(chipKindFor(mkField({ verify_status: 'mismatch' })), 'to_retry');
  assert.equal(chipKindFor(mkField({ verify_status: 'fill_error' })), 'to_retry');
});
test('chipKindFor: unverifiable → unlabeled', () => {
  assert.equal(chipKindFor(mkField({ verify_status: 'unverifiable' })), 'unlabeled');
});
test('chipKindFor: manual class (file / manual) always manual', () => {
  // [review C1] Real class enum from machine.mjs — only 'file' and
  // 'manual' (CAPTCHA emits class:'manual' at machine.mjs:371).
  assert.equal(chipKindFor(mkField({ class: 'file', verify_status: 'verified' })), 'manual');
  assert.equal(chipKindFor(mkField({ class: 'manual', verify_status: null })), 'manual');
  assert.equal(chipKindFor(mkField({ class: 'manual', verify_status: 'mismatch' })), 'manual');
});
test('chipKindFor [review C2/H4]: not_seen + manual verify_status → manual chip', () => {
  // not_seen is emitted at machine.mjs:345 when machine never even tried
  // the field. manual is emitted at machine.mjs:499 when the machine
  // bailed during fill (e.g., classifier returned ambiguous).
  assert.equal(chipKindFor(mkField({ class: 'open', verify_status: 'not_seen' })), 'manual');
  assert.equal(chipKindFor(mkField({ class: 'hard', verify_status: 'manual' })), 'manual');
});
test('chipKindFor: pre-verify (null status) → null', () => {
  assert.equal(chipKindFor(mkField({ verify_status: null })), null);
});

// ── case 1: 5/14 verified renders chips + pct ───────────────────────

test('case 1: 5/14 verified → pct=36 + chips populated', () => {
  const fields = [];
  for (let i = 0; i < 5; i++) {
    fields.push(mkField({ refId: `v${i}`, verify_status: 'verified' }));
  }
  for (let i = 0; i < 5; i++) {
    fields.push(mkField({ refId: `m${i}`, verify_status: 'mismatch' }));
  }
  for (let i = 0; i < 2; i++) {
    fields.push(mkField({ refId: `u${i}`, verify_status: 'unverifiable' }));
  }
  // 2 file fields (manual class) — always land in manual chip.
  for (let i = 0; i < 2; i++) {
    fields.push(mkField({ refId: `f${i}`, class: 'file', verify_status: null }));
  }
  const session = mkSession([{ stepIdx: 0, fields }]);
  const { entries: _, counts } = buildTriageState(session);
  assert.equal(counts.total, 14);
  assert.equal(counts.verified, 5);
  assert.equal(counts.pct, 36);
  assert.equal(counts.chips.to_retry, 5);
  assert.equal(counts.chips.unlabeled, 2);
  assert.equal(counts.chips.manual, 2);
});

// ── case 2: envelope update → recomputed counts ─────────────────────

test('case 2: polling update — counts derived purely from session', () => {
  // First snapshot: 2 mismatch
  const before = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'mismatch' }),
    mkField({ refId: 'b', verify_status: 'mismatch' }),
  ] }]);
  const c1 = computeStatusCounts(aggregateFields(before));
  assert.equal(c1.verified, 0);
  assert.equal(c1.chips.to_retry, 2);
  // Second snapshot (after retry): 1 verified, 1 mismatch
  const after = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'mismatch' }),
  ] }]);
  const c2 = computeStatusCounts(aggregateFields(after));
  assert.equal(c2.verified, 1);
  assert.equal(c2.chips.to_retry, 1);
  assert.equal(c2.pct, 50);
});

// ── case 3: 9 fields sharing ancestor + failing → folded group ──────

test('case 3: 9 fields share ancestor "form.eeo" and fail → 1 batch group', () => {
  const eeoFields = [];
  for (let i = 0; i < 9; i++) {
    eeoFields.push(mkField({
      refId: `eeo_${i}`,
      verify_status: 'mismatch',
      control_fingerprint: { ancestors: ['form.eeo'], tag: 'select', role: 'combobox' },
    }));
  }
  // unrelated standalone
  eeoFields.push(mkField({
    refId: 'phone',
    verify_status: 'mismatch',
    control_fingerprint: { ancestors: ['form.contact'] },
  }));
  const session = mkSession([{ stepIdx: 0, fields: eeoFields }]);
  const { entries } = buildTriageState(session);
  const groups = entries.filter((e) => e.kind === 'group');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKey, 'form.eeo');
  assert.equal(groups[0].fields.length, 9);
  assert.ok(groups[0].batch_hint, 'batch hint should be non-empty');
  assert.match(groups[0].batch_hint, /did not land/i);
  const standalones = entries.filter((e) => e.kind === 'standalone');
  assert.equal(standalones.length, 1);
  assert.equal(standalones[0].field.refId, 'phone');
});

// ── case 4: single failing field → standalone, never group ──────────

test('case 4: single failing unlabeled field → standalone card', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'why', verify_status: 'unverifiable' }),
  ] }]);
  const { entries } = buildTriageState(session);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'standalone');
  assert.equal(entries[0].field.refId, 'why');
});

// ── case 5: all verified → empty triage list + 100% pct ─────────────

test('case 5: all verified → triage entries empty + pct=100', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'verified' }),
    mkField({ refId: 'c', verify_status: 'verified' }),
  ] }]);
  const { entries, counts } = buildTriageState(session);
  assert.equal(entries.length, 0);
  assert.equal(counts.verified, 3);
  assert.equal(counts.total, 3);
  assert.equal(counts.pct, 100);
  assert.equal(counts.chips.to_retry, 0);
});

// ── case 6: required > optional sort ────────────────────────────────

test('case 6 [P3-OQ7]: required > optional ordering', () => {
  const fields = [
    mkField({ refId: 'opt1', verify_status: 'mismatch', required: false }),
    mkField({ refId: 'req1', verify_status: 'mismatch', required: true }),
    mkField({ refId: 'opt2', verify_status: 'mismatch', required: false }),
    mkField({ refId: 'req2', verify_status: 'mismatch', required: true }),
  ];
  const session = mkSession([{ stepIdx: 0, fields }]);
  const { entries } = buildTriageState(session);
  // required entries first (req1, req2), then optional (opt1, opt2)
  assert.equal(entries.length, 4);
  assert.equal(entries[0].field.refId, 'req1');
  assert.equal(entries[1].field.refId, 'req2');
  assert.equal(entries[2].field.refId, 'opt1');
  assert.equal(entries[3].field.refId, 'opt2');
});

// ── case 7: stepIdx ordering preserved within tier ──────────────────

test('case 7: form order (stepIdx asc) preserved within required tier', () => {
  const session = mkSession([
    { stepIdx: 2, fields: [mkField({ refId: 'late', verify_status: 'mismatch' })] },
    { stepIdx: 0, fields: [mkField({ refId: 'early', verify_status: 'mismatch' })] },
    { stepIdx: 1, fields: [mkField({ refId: 'mid', verify_status: 'mismatch' })] },
  ]);
  const { entries } = buildTriageState(session);
  assert.equal(entries.map((e) => e.field.refId).join(','), 'early,mid,late');
});

// ── case 8: aggregateFields skips fields without refId ──────────────

test('case 8: aggregateFields drops entries without refId', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'ok' }),
    { label: 'no refId', class: 'text' },  // missing refId — excluded
    mkField({ refId: 'ok2' }),
  ] }]);
  const list = aggregateFields(session);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((f) => f.refId), ['ok', 'ok2']);
});

// ── case 9: groups inherit required tier from any member ────────────

test('case 9: a group containing any required field sorts in required tier', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    // standalone OPTIONAL
    mkField({ refId: 'opt', verify_status: 'mismatch', required: false }),
    // group of 2: one required, one optional — group sorts as required
    mkField({
      refId: 'g1',
      verify_status: 'mismatch',
      required: false,
      control_fingerprint: { ancestors: ['form.eeo'] },
    }),
    mkField({
      refId: 'g2',
      verify_status: 'mismatch',
      required: true,
      control_fingerprint: { ancestors: ['form.eeo'] },
    }),
  ] }]);
  const { entries } = buildTriageState(session);
  // First entry should be the group (required tier wins), second is the optional standalone
  assert.equal(entries[0].kind, 'group');
  assert.equal(entries[0].groupKey, 'form.eeo');
  assert.equal(entries[1].kind, 'standalone');
  assert.equal(entries[1].field.refId, 'opt');
});

// [review M7] empty session — no draft entries at all
test('case 10 [M7]: empty per_step_draft → empty entries + zero counts', () => {
  const session = mkSession([]);
  const { entries, counts } = buildTriageState(session);
  assert.deepEqual(entries, []);
  assert.equal(counts.total, 0);
  assert.equal(counts.verified, 0);
  assert.equal(counts.pct, null);
  assert.deepEqual(counts.chips, { to_retry: 0, unlabeled: 0, manual: 0 });
});

// [review M8] malformed input doesn't crash
test('case 11 [M8]: session=null / undefined → safe defaults', () => {
  for (const bad of [null, undefined, {}, { per_step_draft: null }]) {
    const r = buildTriageState(bad);
    assert.deepEqual(r.entries, []);
    assert.equal(r.counts.total, 0);
  }
});

// [review M9] every verify_status the backend emits is classified
test('case 12 [M9]: all real verify_status values from machine.mjs routed', () => {
  // Real emitted values: 'verified', 'mismatch', 'fill_error',
  // 'unverifiable', 'not_seen', 'manual' (plus null pre-verify).
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'mismatch' }),
    mkField({ refId: 'c', verify_status: 'fill_error' }),
    mkField({ refId: 'd', verify_status: 'unverifiable' }),
    mkField({ refId: 'e', verify_status: 'not_seen' }),
    mkField({ refId: 'f', verify_status: 'manual' }),
  ] }]);
  const { counts } = buildTriageState(session);
  assert.equal(counts.verified, 1);
  assert.equal(counts.chips.to_retry, 2);   // mismatch + fill_error
  assert.equal(counts.chips.unlabeled, 1);  // unverifiable
  assert.equal(counts.chips.manual, 2);     // not_seen + manual
  assert.equal(counts.total, 6);            // none of these are dark
});

// [review H1] composite (stepIdx, refId) keys avoid collision on synthetic refs
test('case 13 [H1]: refId collisions across steps use composite key', () => {
  const session = mkSession([
    { stepIdx: 0, fields: [mkField({ refId: '__file_0', class: 'file' })] },
    { stepIdx: 1, fields: [mkField({ refId: '__file_0', class: 'file' })] },
    { stepIdx: 2, fields: [mkField({ refId: '__captcha', class: 'manual' })] },
  ]);
  const list = aggregateFields(session);
  // Both __file_0 entries should be present with distinct composite keys.
  assert.equal(list.length, 3);
  const keys = list.map((f) => f.key);
  assert.deepEqual(new Set(keys).size, 3, 'composite keys must be globally unique');
  assert.ok(keys.includes('0::__file_0'));
  assert.ok(keys.includes('1::__file_0'));
});

// [review M10] composability — counts.total + chips agree with aggregate
test('case 14 [M10]: computeStatusCounts ≡ aggregateFields scan', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'mismatch' }),
    mkField({ refId: 'c', class: 'file' }),
  ] }]);
  const list = aggregateFields(session);
  const c = computeStatusCounts(list);
  // total = verified + chips
  const chipSum = c.chips.to_retry + c.chips.unlabeled + c.chips.manual;
  assert.equal(c.total, c.verified + chipSum,
    `total must equal verified + all-chips; got total=${c.total}, verified=${c.verified}, chipSum=${chipSum}`);
});

// [review C2] dark-count regression — not_seen used to vanish from total
test('case 15 [C2 regression]: not_seen counted in total + manual chip', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'a', verify_status: 'verified' }),
    mkField({ refId: 'b', verify_status: 'not_seen' }),
  ] }]);
  const { counts } = buildTriageState(session);
  assert.equal(counts.verified, 1);
  assert.equal(counts.total, 2, 'not_seen must contribute to total');
  assert.equal(counts.chips.manual, 1, 'not_seen must land in manual chip');
});

// [review H2 + buildTriageState fix] manual entries DO NOT appear in entries
test('case 16: manual entries surface only in chips, not in triage entries', () => {
  const session = mkSession([{ stepIdx: 0, fields: [
    mkField({ refId: 'cap', class: 'manual', verify_status: 'not_seen' }),
    mkField({ refId: 'mis', verify_status: 'mismatch' }),
  ] }]);
  const { entries, counts } = buildTriageState(session);
  assert.equal(counts.chips.manual, 1);
  assert.equal(counts.chips.to_retry, 1);
  // Only the mismatch entry should appear in triage cards.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'standalone');
  assert.equal(entries[0].field.refId, 'mis');
});

// ── Done ────────────────────────────────────────────────────────────

console.log(`\n✅ ${passed} smoke tests passed`);
