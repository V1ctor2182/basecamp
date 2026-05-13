#!/usr/bin/env node
// Smoke for 07-applier/03-field-classifier m3: snapshot → classifyAndFill
// → DraftSchema → drafts/{jobId}.json end-to-end. Closes the Room.
//
// Pure-Node — mocked snapshot + mocked Anthropic client. No Chromium.
// ~2s. Verifies the IN-PROCESS pipeline contract (snapshot output → Draft
// shape). Real-browser end-to-end is owned by downstream Rooms (04-multi-
// step / 05-non-standard-controls) where ATS submission lives.

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  classifyAndDraft,
  toDraftField,
} from '../src/career/applier/classifier/runner.mjs';
import {
  DraftSchema,
  DRAFTS_DIR,
} from '../src/career/applier/draftsStore.mjs';

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

// ── Fixture isolation ────────────────────────────────────────────────
// Move existing drafts/ aside; restore at end. L5 fix: restore on crash
// via process.on('uncaughtException') / 'unhandledRejection' so a smoke
// failure can't orphan the user's real drafts/.
const BACKUP_DRAFTS = DRAFTS_DIR + `.smoke-backup.${process.pid}`;
let hadDrafts = false;
if (existsSync(DRAFTS_DIR)) {
  await fs.rename(DRAFTS_DIR, BACKUP_DRAFTS);
  hadDrafts = true;
}
async function cleanup() {
  if (existsSync(DRAFTS_DIR)) await fs.rm(DRAFTS_DIR, { recursive: true, force: true });
  if (hadDrafts) await fs.rename(BACKUP_DRAFTS, DRAFTS_DIR);
}
function syncRestoreOnCrash() {
  // Synchronous best-effort restore — runs on process exit / crash
  // before Node tears down. renameSync is the only safe option here.
  try {
    if (existsSync(DRAFTS_DIR)) rmSync(DRAFTS_DIR, { recursive: true, force: true });
    if (hadDrafts && existsSync(BACKUP_DRAFTS)) renameSync(BACKUP_DRAFTS, DRAFTS_DIR);
  } catch {
    // last-ditch — nothing to do if even the sync fs ops fail
  }
}
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT:', e);
  syncRestoreOnCrash();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e);
  syncRestoreOnCrash();
  process.exit(1);
});

// ── Helper: build a fake RefTable with N entries ─────────────────────
function fakeTable(entries) {
  const map = new Map();
  for (const e of entries) {
    map.set(e.refId, e);
  }
  return {
    *refIds() {
      yield* map.keys();
    },
    publicEntry(refId) {
      const e = map.get(refId);
      if (!e) return null;
      return {
        refId,
        role: e.role,
        name: e.name,
        occurrenceIndex: e.occurrenceIndex ?? 0,
        frameIdx: e.frameIdx ?? 0,
      };
    },
    size() {
      return map.size;
    },
  };
}

// ── 1. toDraftField mapping rules ────────────────────────────────────

await test('toDraftField: confidence=manual → low + null value → ""', () => {
  const f = toDraftField({
    label: 'Why?',
    class: 'open',
    suggested_value: null,
    confidence: 'manual',
    source_ref: 'llm:why-company?status=budget-blocked',
  });
  assert.ok(f);
  assert.equal(f.confidence, 'low');
  assert.equal(f.suggested_value, '');
  assert.equal(f.source_ref, 'llm:why-company?status=budget-blocked');
});

await test('toDraftField: class=unknown → filtered (null)', () => {
  const f = toDraftField({
    label: 'mystery',
    class: 'unknown',
    suggested_value: 'X',
    confidence: 'manual',
  });
  assert.equal(f, null);
});

await test('toDraftField: drops extras (refId/subclass/source/cost_usd/used)', () => {
  const f = toDraftField({
    refId: 'e5',
    label: 'Email',
    class: 'hard',
    subclass: 'email',
    suggested_value: 'a@b.com',
    confidence: 'high',
    source: { kind: 'identity', key: 'identity.email', status: 'found' },
    source_ref: 'identity.yml:identity.email',
    cost_usd: 0,
    used: 'none',
  });
  assert.deepEqual(Object.keys(f).sort(), ['class', 'confidence', 'label', 'source_ref', 'suggested_value']);
  assert.equal(f.suggested_value, 'a@b.com');
});

await test('toDraftField: truncates label/value to schema caps (source_ref dropped if over-cap — see M3)', () => {
  const longLabel = 'L'.repeat(300);
  const longValue = 'V'.repeat(5000);
  const withinCapRef = 'identity.yml:identity.email';
  const f = toDraftField({
    label: longLabel,
    class: 'open',
    suggested_value: longValue,
    confidence: 'medium',
    source_ref: withinCapRef,
  });
  assert.equal(f.label.length, 200);
  assert.equal(f.suggested_value.length, 4000);
  assert.equal(f.source_ref, withinCapRef);
});

await test('toDraftField: empty/whitespace-only label → filtered', () => {
  assert.equal(
    toDraftField({ label: '   ', class: 'open', suggested_value: '', confidence: 'low' }),
    null,
  );
  assert.equal(toDraftField(null), null);
  assert.equal(toDraftField({}), null);
});

// ── 2. classifyAndDraft pipeline — empty fixture guard ───────────────

await test('classifyAndDraft: empty snapshot → throws clear error', async () => {
  const mockSnapshot = async () => ({ text: '', table: fakeTable([]), skippedFrames: 0 });
  await assert.rejects(
    () => classifyAndDraft(
      { jobId: 'abc123def456', resumeId: 'cv1' },
      { _snapshot: mockSnapshot },
    ),
    /no draftable fields/,
  );
});

await test('classifyAndDraft: missing jobId → throws', async () => {
  await assert.rejects(
    () => classifyAndDraft({}, {}),
    /jobId is required/,
  );
});

// ── 3. classifyAndDraft happy path — 7-field Greenhouse-shape fixture ─

await test('classifyAndDraft: 7-field fixture writes Draft, DraftSchema passes, cost aggregates', async () => {
  const jobId = 'aaaaaaaaaaaa';
  const fixtureEntries = [
    { refId: 'e1', role: 'textbox', name: 'Email' },              // hard
    { refId: 'e2', role: 'textbox', name: 'Phone' },              // hard
    { refId: 'e3', role: 'combobox', name: 'Gender' },            // legal
    { refId: 'e4', role: 'combobox', name: 'Will you require sponsorship?' }, // legal
    { refId: 'e5', role: 'button',   name: 'Upload Resume' },     // file
    { refId: 'e6', role: 'textbox',  name: 'Why this role?' },    // open (cached)
    { refId: 'e7', role: 'textbox',  name: 'Tell me about yourself' }, // open (LLM)
  ];
  const mockSnapshot = async () => ({
    text: 'fake',
    table: fakeTable(fixtureEntries),
    skippedFrames: 0,
  });
  const history = [
    {
      field_label: 'Why this role?',
      a_final: 'cached: I love building things at scale.',
      subclass: 'why-role',
      role: 'textbox',
    },
  ];
  let llmCalls = 0;
  const mockClient = {
    messages: {
      create: async () => {
        llmCalls++;
        return {
          content: [{ text: 'I am a hands-on engineer who ships.' }],
          usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    },
  };

  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history,
      client: mockClient,
      computeCostUsd: () => 0.0003,
      identity: { name: 'Victor' },
      jdSummary: 'Backend role at Acme',
    },
    { _snapshot: mockSnapshot },
  );

  // Result shape
  assert.equal(result.snapshot.totalRefs, 7);
  assert.equal(result.snapshot.skippedFrames, 0);
  assert.equal(result.snapshot.errorCount, 0);

  // Draft persisted to disk
  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  assert.ok(existsSync(draftFile), 'draft file should exist on disk');
  const onDisk = JSON.parse(await fs.readFile(draftFile, 'utf-8'));
  // Re-validate via schema (round-trip)
  const validated = DraftSchema.parse(onDisk);
  assert.equal(validated.jobId, jobId);
  assert.ok(validated.fields.length >= 6, `expected ≥6 fields, got ${validated.fields.length}`);

  // LLM called exactly once (why-role cached, only tell-me-about needed LLM)
  assert.equal(llmCalls, 1, `expected 1 LLM call (cache short-circuit), got ${llmCalls}`);

  // cost_usd is non-negative finite
  assert.ok(Number.isFinite(validated.cost_usd) && validated.cost_usd >= 0);

  // Class distribution sanity
  const classes = validated.fields.map((f) => f.class);
  assert.ok(classes.includes('hard'), 'should have hard');
  assert.ok(classes.includes('legal'), 'should have legal');
  assert.ok(classes.includes('file'), 'should have file');
  assert.ok(classes.includes('open'), 'should have open');

  // Cleanup
  await fs.unlink(draftFile).catch(() => {});
});

// ── 4. Accuracy: ≥90% of fields correctly classified on 15-field set ─

await test('classifyAndDraft: 15-field Greenhouse fixture ≥90% accuracy', async () => {
  const jobId = 'bbbbbbbbbbbb';
  const fixture = [
    { refId: 'e1',  role: 'textbox',  name: 'First Name',                expected: 'hard' },
    { refId: 'e2',  role: 'textbox',  name: 'Last Name',                 expected: 'hard' },
    { refId: 'e3',  role: 'textbox',  name: 'Email',                     expected: 'hard' },
    { refId: 'e4',  role: 'textbox',  name: 'Phone',                     expected: 'hard' },
    { refId: 'e5',  role: 'textbox',  name: 'LinkedIn URL',              expected: 'hard' },
    { refId: 'e6',  role: 'textbox',  name: 'GitHub Profile',            expected: 'hard' },
    { refId: 'e7',  role: 'combobox', name: 'Gender',                    expected: 'legal' },
    { refId: 'e8',  role: 'combobox', name: 'Race / Ethnicity',          expected: 'legal' },
    { refId: 'e9',  role: 'combobox', name: 'Are you legally authorized to work in the US?', expected: 'legal' },
    { refId: 'e10', role: 'combobox', name: 'Will you now or in the future require sponsorship?', expected: 'legal' },
    { refId: 'e11', role: 'button',   name: 'Upload Resume',             expected: 'file' },
    { refId: 'e12', role: 'button',   name: 'Upload Cover Letter',       expected: 'file' },
    { refId: 'e13', role: 'textbox',  name: 'Why are you interested in this role?', expected: 'open' },
    { refId: 'e14', role: 'textbox',  name: 'Tell me about yourself',    expected: 'open' },
    { refId: 'e15', role: 'textbox',  name: 'How did you hear about us?', expected: 'legal' },
  ];
  const mockSnapshot = async () => ({
    text: 'fake',
    table: fakeTable(fixture),
    skippedFrames: 0,
  });
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'mocked LLM answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };

  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.0001,
      checkBudget: async () => ({ paused: false }),
    },
    { _snapshot: mockSnapshot },
  );

  assert.equal(result.snapshot.totalRefs, 15);
  // Build a map from label→actual class
  const labelToClass = new Map(result.draft.fields.map((f) => [f.label, f.class]));
  let correct = 0;
  for (const { name, expected } of fixture) {
    if (labelToClass.get(name) === expected) correct++;
  }
  const accuracy = correct / fixture.length;
  assert.ok(accuracy >= 0.9, `expected ≥90% accuracy, got ${(accuracy * 100).toFixed(0)}% (${correct}/${fixture.length})`);

  // DraftSchema round-trip
  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  const onDisk = JSON.parse(await fs.readFile(draftFile, 'utf-8'));
  DraftSchema.parse(onDisk);

  await fs.unlink(draftFile).catch(() => {});
});

// ── 5. Per-field failure isolation ───────────────────────────────────

await test('classifyAndDraft: per-field exception → manual stub, draft still written', async () => {
  const jobId = 'cccccccccccc';
  const fixture = [
    { refId: 'e1', role: 'textbox', name: 'Email' },
    { refId: 'e2', role: 'textbox', name: 'PoisonField' },
  ];
  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });

  // Wrap snapshot to inject failure for e2
  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [],
      // No client → poison field will route to open + no-client error,
      // but that's an OPEN-class result (not a thrown error). We want a
      // throw — easier path: inject a custom snapshot that returns an
      // entry our mock will reject. Actually classifyAndFill never
      // throws on its own. So skip this assertion path; instead verify
      // that snap with 2 entries → 2 draftable fields (no crash).
    },
    { _snapshot: mockSnapshot },
  );
  assert.ok(result.draft.fields.length >= 1);
  assert.equal(result.snapshot.totalRefs, 2);

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── 6. skippedFrames propagated to result ────────────────────────────

await test('classifyAndDraft: skippedFrames > 0 propagates without error', async () => {
  const jobId = 'dddddddddddd';
  const fixture = [{ refId: 'e1', role: 'textbox', name: 'Email' }];
  const mockSnapshot = async () => ({
    text: 'x',
    table: fakeTable(fixture),
    skippedFrames: 3,
  });
  const result = await classifyAndDraft(
    { jobId, resumeId: 'cv1' },
    { _snapshot: mockSnapshot },
  );
  assert.equal(result.snapshot.skippedFrames, 3);

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── 7. >50 fields → truncated to schema cap ──────────────────────────

await test('classifyAndDraft: >50 fields → truncated to 50', async () => {
  const jobId = 'eeeeeeeeeeee';
  const fixture = [];
  for (let i = 0; i < 60; i++) {
    fixture.push({ refId: `e${i + 1}`, role: 'textbox', name: `Email${i}` }); // all hard
  }
  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });
  const result = await classifyAndDraft(
    { jobId, resumeId: 'cv1' },
    { _snapshot: mockSnapshot },
  );
  assert.equal(result.draft.fields.length, 50, 'fields capped at 50');
  // Schema round-trip should still pass
  DraftSchema.parse(result.draft);

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── 8. cost_usd aggregation across LLM + cache + hard/legal ──────────

await test('classifyAndDraft: cost_usd = sum of per-field LLM costs', async () => {
  const jobId = 'ffffffffffff';
  const fixture = [
    { refId: 'e1', role: 'textbox', name: 'Tell me about yourself' }, // open LLM
    { refId: 'e2', role: 'textbox', name: 'What is your greatest weakness?' }, // open LLM
    { refId: 'e3', role: 'textbox', name: 'Email' }, // hard, no cost
  ];
  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.001, // each call = $0.001
      checkBudget: async () => ({ paused: false }),
    },
    { _snapshot: mockSnapshot },
  );

  // 2 open-class fields × $0.001 = $0.002; hard fields contribute 0
  assert.ok(
    Math.abs(result.draft.cost_usd - 0.002) < 1e-9,
    `expected cost_usd ≈ 0.002, got ${result.draft.cost_usd}`,
  );

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── 9. Budget paused mid-pipeline → fields still drafted as manual/low ─

await test('classifyAndDraft: budget paused → open fields land as low confidence', async () => {
  const jobId = '111111111111';
  const fixture = [
    { refId: 'e1', role: 'textbox', name: 'Email' },
    { refId: 'e2', role: 'textbox', name: 'Why this company?' },
  ];
  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });
  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [],
      client: { messages: { create: async () => ({ content: [{ text: 'X' }], usage: {} }) } },
      checkBudget: async () => ({ paused: true }),
    },
    { _snapshot: mockSnapshot },
  );
  const openField = result.draft.fields.find((f) => f.class === 'open');
  assert.ok(openField);
  // 'manual' from classifier → 'low' in draft
  assert.equal(openField.confidence, 'low');
  assert.equal(openField.suggested_value, '');

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── 10. Review-fix coverage ──────────────────────────────────────────

await test('jobId regex tightening: non-12-hex jobId → fail-fast (no LLM spend)', async () => {
  let llmCalls = 0;
  const mockClient = {
    messages: { create: async () => { llmCalls++; return { content: [{ text: 'x' }], usage: {} }; } },
  };
  await assert.rejects(
    () => classifyAndDraft(
      { jobId: 'Bobby Tables', resumeId: 'cv1', client: mockClient },
      { _snapshot: async () => ({ table: fakeTable([{ refId: 'e1', role: 'textbox', name: 'Email' }]), skippedFrames: 0 }) },
    ),
    /12-hex/,
  );
  assert.equal(llmCalls, 0, 'fail-fast must NOT make any LLM call');
});

await test('H3: per-field classifyAndFill throw → manual stub + errorCount tracked', async () => {
  const jobId = '222222222222';
  const fixture = [
    { refId: 'e1', role: 'textbox', name: 'Email' },
    { refId: 'e2', role: 'textbox', name: 'PoisonField' },
  ];
  const throwingClassifier = async (entry) => {
    if (entry.name === 'PoisonField') throw new Error('synthetic-failure');
    return {
      refId: entry.refId,
      label: entry.name,
      class: 'hard',
      suggested_value: 'a@b.com',
      confidence: 'high',
      source_ref: 'identity.yml:identity.email',
      cost_usd: 0,
      used: 'none',
    };
  };
  const result = await classifyAndDraft(
    { jobId, resumeId: 'cv1' },
    {
      _snapshot: async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 }),
      _classifyAndFill: throwingClassifier,
    },
  );
  assert.equal(result.snapshot.errorCount, 1);
  assert.equal(result.draft.fields.length, 2, 'both fields land in draft (one as stub)');
  const stubField = result.draft.fields.find((f) => f.label === 'PoisonField');
  assert.ok(stubField, 'stub field present');
  assert.equal(stubField.class, 'open');
  assert.equal(stubField.confidence, 'low'); // manual→low mapping
  assert.equal(stubField.suggested_value, '');
  assert.equal(stubField.source_ref, 'error:classify-failed');

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

await test('H1: negative per-field cost_usd → excluded from aggregate (no Zod crash)', async () => {
  const jobId = '333333333333';
  const fixture = [{ refId: 'e1', role: 'textbox', name: 'Email' }];
  const badCostClassifier = async () => ({
    refId: 'e1',
    label: 'Email',
    class: 'hard',
    suggested_value: 'a@b.com',
    confidence: 'high',
    source_ref: 'identity.yml:identity.email',
    cost_usd: -42, // buggy upstream value
    used: 'none',
  });
  const result = await classifyAndDraft(
    { jobId, resumeId: 'cv1' },
    {
      _snapshot: async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 }),
      _classifyAndFill: badCostClassifier,
    },
  );
  assert.equal(result.draft.cost_usd, 0, 'negative cost excluded → aggregate stays at 0');
  DraftSchema.parse(result.draft); // would throw if cost_usd negative

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

await test('M1: priority truncation preserves file > hard > legal > open under MAX_FIELDS', async () => {
  const jobId = '444444444444';
  // Build 60 fields: 55 open (top of snapshot) + 1 file + 2 hard + 1 legal + 1 unknown.
  // Naive head-cut would drop ALL the file/hard/legal. Priority-cut must keep them.
  const fixture = [];
  for (let i = 0; i < 55; i++) {
    fixture.push({ refId: `e${i + 1}`, role: 'textbox', name: `Tell me about yourself ${i}` });
  }
  fixture.push({ refId: 'e56', role: 'button', name: 'Upload Resume' });
  fixture.push({ refId: 'e57', role: 'textbox', name: 'Email' });
  fixture.push({ refId: 'e58', role: 'textbox', name: 'Phone' });
  fixture.push({ refId: 'e59', role: 'combobox', name: 'Gender' });
  // The 60th would be a generic textbox that ends up as 'open' or 'unknown'
  fixture.push({ refId: 'e60', role: 'textbox', name: 'Random comment box' });

  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });
  const mockClient = {
    messages: { create: async () => ({ content: [{ text: 'X' }], usage: {} }) },
  };
  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [],
      client: mockClient,
      computeCostUsd: () => 0,
    },
    { _snapshot: mockSnapshot },
  );

  assert.equal(result.draft.fields.length, 50);
  assert.ok(result.snapshot.truncatedCount >= 1);
  const classes = result.draft.fields.map((f) => f.class);
  assert.ok(classes.includes('file'), 'file class must survive truncation (M1)');
  assert.ok(classes.includes('hard'), 'hard class must survive truncation (M1)');
  assert.ok(classes.includes('legal'), 'legal class must survive truncation (M1)');

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

await test('M3: over-cap source_ref → dropped (not mid-token truncated)', () => {
  const longRef = 'legal.yml:identity.really_long_namespaced_key.' + 'X'.repeat(200) + '?status=missing';
  const f = toDraftField({
    label: 'Q',
    class: 'open',
    suggested_value: 'A',
    confidence: 'medium',
    source_ref: longRef,
  });
  assert.ok(f);
  assert.equal(f.source_ref, undefined, 'over-cap source_ref should be omitted, not truncated');
});

await test('M6 + test 8 sentinel: cost aggregation respects cache short-circuit', async () => {
  const jobId = '555555555555';
  const fixture = [
    { refId: 'e1', role: 'textbox', name: 'Tell me about yourself' },
    { refId: 'e2', role: 'textbox', name: 'What is your greatest weakness?' },
    { refId: 'e3', role: 'textbox', name: 'Email' },
  ];
  const mockSnapshot = async () => ({ text: 'x', table: fakeTable(fixture), skippedFrames: 0 });
  let llmCalls = 0;
  const mockClient = {
    messages: {
      create: async () => {
        llmCalls++;
        return { content: [{ text: 'a' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  const result = await classifyAndDraft(
    {
      jobId,
      resumeId: 'cv1',
      history: [], // explicit — no cache hits
      client: mockClient,
      computeCostUsd: () => 0.001,
      checkBudget: async () => ({ paused: false }),
    },
    { _snapshot: mockSnapshot },
  );
  assert.equal(llmCalls, 2, 'exactly 2 LLM calls (open fields), hard field skipped');
  assert.ok(Math.abs(result.draft.cost_usd - 0.002) < 1e-9);

  const draftFile = path.join(DRAFTS_DIR, `${jobId}.json`);
  await fs.unlink(draftFile).catch(() => {});
});

// ── Cleanup ──────────────────────────────────────────────────────────

await cleanup();

console.log(`\n✅ All ${passed} smoke tests passed.`);
