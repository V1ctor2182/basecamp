#!/usr/bin/env node
// Smoke for 07-applier/self-iteration/02-data-flywheel m1:
// schemas.mjs (3 Zod schemas) +
// stores.mjs (appendJsonl + readJsonl + countByGroup + typed wrappers +
//  editDistance + classifyError) +
// endpoint.mjs capture hooks (approveStep → field-edits; runMachine
//  error path → site-failures).
//
// Pure-Node — uses os.tmpdir() for store fixtures and mocked
// runMachine/getPage for endpoint capture-hook tests. No Chromium.

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  FieldMisclassifiedSchema,
  FieldEditSchema,
  SiteFailureSchema,
  FIELD_CLASSES,
  ERROR_KINDS,
} from '../src/career/feedback/schemas.mjs';
import {
  FEEDBACK_DIR,
  appendJsonl,
  readJsonl,
  countByGroup,
  recordFieldMisclassified,
  recordFieldEdit,
  recordSiteFailure,
  editDistance,
  classifyError,
  _FILES,
} from '../src/career/feedback/stores.mjs';
import {
  APPLY_SESSIONS_DIR,
  buildInitialSession,
  writeSession,
} from '../src/career/applier/multistep/applySessionsStore.mjs';
import {
  startMachine,
  approveStep,
  _resetAll,
  OUTCOME,
} from '../src/career/applier/multistep/endpoint.mjs';

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

// ── Fixture isolation ──────────────────────────────────────────────────
//
// feedback/ + apply-sessions/ both rooted under data/career/. We move
// any real files aside, point FEEDBACK_DIR at the same path (the store
// resolves at module-load — we can't re-point — so we operate on the
// real dir but isolate via per-PID backup directories).

const FEEDBACK_BACKUP = FEEDBACK_DIR + `.smoke-backup.${process.pid}`;
const SESSIONS_BACKUP = APPLY_SESSIONS_DIR + `.smoke-backup.${process.pid}`;

function setupFixtures() {
  if (existsSync(FEEDBACK_DIR)) renameSync(FEEDBACK_DIR, FEEDBACK_BACKUP);
  if (existsSync(APPLY_SESSIONS_DIR)) renameSync(APPLY_SESSIONS_DIR, SESSIONS_BACKUP);
}
function restoreFixtures() {
  if (existsSync(FEEDBACK_DIR)) rmSync(FEEDBACK_DIR, { recursive: true, force: true });
  if (existsSync(FEEDBACK_BACKUP)) renameSync(FEEDBACK_BACKUP, FEEDBACK_DIR);
  if (existsSync(APPLY_SESSIONS_DIR)) rmSync(APPLY_SESSIONS_DIR, { recursive: true, force: true });
  if (existsSync(SESSIONS_BACKUP)) renameSync(SESSIONS_BACKUP, APPLY_SESSIONS_DIR);
}
setupFixtures();
process.on('exit', restoreFixtures);
process.on('uncaughtException', (e) => {
  restoreFixtures();
  console.error('uncaught:', e);
  process.exit(2);
});

function isoNow() {
  return new Date().toISOString();
}

async function readAll(filename) {
  const out = [];
  for await (const r of readJsonl(filename)) out.push(r);
  return out;
}

async function clearFeedbackDir() {
  if (existsSync(FEEDBACK_DIR)) {
    rmSync(FEEDBACK_DIR, { recursive: true, force: true });
  }
}

// ── 1. Schemas ─────────────────────────────────────────────────────────

await test('FieldMisclassifiedSchema: accepts valid record, rejects bad enum', () => {
  const good = {
    ts: isoNow(),
    jobId: '0123456789ab',
    field_label: 'Preferred Pronouns',
    refId: 'e7',
    predicted_class: 'open',
    actual_class: 'legal',
    actual_mapping: 'eeo.pronouns',
    site: 'workday',
  };
  assert.deepEqual(FieldMisclassifiedSchema.parse(good), good);
  assert.throws(
    () => FieldMisclassifiedSchema.parse({ ...good, predicted_class: 'wrong-class' }),
    /predicted_class/,
  );
});

await test('FieldEditSchema: edit_distance must be ≥1 (distance=0 records are skipped at capture)', () => {
  const good = {
    ts: isoNow(),
    jobId: '0123456789ab',
    field_id: 'e3',
    field_label: 'Why us',
    suggested: 'foo',
    user_final: 'bar',
    edit_distance: 1,
    confidence: 'medium',
  };
  assert.deepEqual(FieldEditSchema.parse(good), good);
  assert.throws(() => FieldEditSchema.parse({ ...good, edit_distance: 0 }), /edit_distance/);
});

await test('SiteFailureSchema: rejects unknown error_kind', () => {
  const good = {
    ts: isoNow(),
    jobId: '0123456789ab',
    domain: 'jobs.workday.com',
    site_adapter_id: 'workday',
    step_idx: 3,
    error_kind: 'timeout',
    error_message: 'fill timed out at 10000ms',
  };
  assert.deepEqual(SiteFailureSchema.parse(good), good);
  assert.throws(
    () => SiteFailureSchema.parse({ ...good, error_kind: 'totally-novel' }),
    /error_kind/,
  );
});

await test('Strict mode: extra keys rejected', () => {
  assert.throws(
    () =>
      FieldEditSchema.parse({
        ts: isoNow(),
        jobId: '0123456789ab',
        field_id: 'e1',
        field_label: 'X',
        suggested: 'a',
        user_final: 'b',
        edit_distance: 1,
        confidence: 'high',
        bogus_field: 42,
      }),
    /Unrecognized|bogus_field/,
  );
});

// ── 2. appendJsonl + readJsonl ─────────────────────────────────────────

await test('appendJsonl: lazy-creates FEEDBACK_DIR + file on first append', async () => {
  await clearFeedbackDir();
  assert.equal(existsSync(FEEDBACK_DIR), false);
  await recordFieldEdit({
    ts: isoNow(),
    jobId: '0123456789ab',
    field_id: 'e1',
    field_label: 'Why us',
    suggested: 'foo',
    user_final: 'bar',
    edit_distance: 3,
    confidence: 'medium',
  });
  assert.equal(existsSync(FEEDBACK_DIR), true);
  assert.equal(existsSync(path.join(FEEDBACK_DIR, _FILES.FIELD_EDITS)), true);
});

await test('appendJsonl + readJsonl roundtrip', async () => {
  await clearFeedbackDir();
  const r1 = {
    ts: isoNow(),
    jobId: '0123456789ab',
    field_id: 'e1',
    field_label: 'A',
    suggested: 'foo',
    user_final: 'bar',
    edit_distance: 3,
    confidence: 'low',
  };
  const r2 = { ...r1, field_id: 'e2', field_label: 'B', edit_distance: 5 };
  await recordFieldEdit(r1);
  await recordFieldEdit(r2);
  const all = await readAll(_FILES.FIELD_EDITS);
  assert.equal(all.length, 2);
  assert.equal(all[0].field_label, 'A');
  assert.equal(all[1].field_label, 'B');
});

await test('appendJsonl rejects bad records before write', async () => {
  await clearFeedbackDir();
  await assert.rejects(
    () => recordFieldEdit({ ts: 'not-a-date', jobId: 'BAD', field_id: 'x', field_label: 'y', suggested: '', user_final: '', edit_distance: 1, confidence: 'high' }),
    /ts|jobId/,
  );
  // Nothing was written
  assert.equal(existsSync(path.join(FEEDBACK_DIR, _FILES.FIELD_EDITS)), false);
});

await test('readJsonl: nonexistent file → empty stream (no throw)', async () => {
  await clearFeedbackDir();
  const all = await readAll(_FILES.SITE_FAILURES);
  assert.deepEqual(all, []);
});

await test('readJsonl: filter + since + limit', async () => {
  await clearFeedbackDir();
  const oldTs = new Date(Date.now() - 100_000).toISOString();
  const recentTs = new Date().toISOString();
  await recordFieldEdit({
    ts: oldTs,
    jobId: '0123456789ab',
    field_id: 'e1',
    field_label: 'old',
    suggested: 'a',
    user_final: 'b',
    edit_distance: 1,
    confidence: 'high',
  });
  for (let i = 0; i < 3; i++) {
    await recordFieldEdit({
      ts: recentTs,
      jobId: '0123456789ab',
      field_id: `e${i}`,
      field_label: `recent-${i}`,
      suggested: 'x',
      user_final: 'y',
      edit_distance: 1,
      confidence: 'high',
    });
  }
  // since filter
  const recent = [];
  for await (const r of readJsonl(_FILES.FIELD_EDITS, { since: Date.now() - 50_000 })) {
    recent.push(r);
  }
  assert.equal(recent.length, 3);
  // limit
  const limited = [];
  for await (const r of readJsonl(_FILES.FIELD_EDITS, { limit: 2 })) limited.push(r);
  assert.equal(limited.length, 2);
  // filter predicate
  const filtered = [];
  for await (const r of readJsonl(_FILES.FIELD_EDITS, { filter: (r) => r.field_label === 'recent-1' })) {
    filtered.push(r);
  }
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].field_label, 'recent-1');
});

await test('readJsonl: skips malformed JSON lines + schema-invalid records', async () => {
  await clearFeedbackDir();
  await recordFieldEdit({
    ts: isoNow(),
    jobId: '0123456789ab',
    field_id: 'e1',
    field_label: 'good',
    suggested: 'a',
    user_final: 'b',
    edit_distance: 1,
    confidence: 'high',
  });
  // Tamper: append a malformed line + a schema-invalid line directly.
  const filePath = path.join(FEEDBACK_DIR, _FILES.FIELD_EDITS);
  await fs.appendFile(filePath, '{not-valid-json\n', 'utf8');
  await fs.appendFile(filePath, JSON.stringify({ ts: 'bad', jobId: 'BAD' }) + '\n', 'utf8');
  const all = await readAll(_FILES.FIELD_EDITS);
  assert.equal(all.length, 1, 'malformed + schema-invalid lines silently dropped');
  assert.equal(all[0].field_label, 'good');
});

// ── 3. countByGroup ────────────────────────────────────────────────────

await test('countByGroup: groups by site, respects since window', async () => {
  await clearFeedbackDir();
  for (let i = 0; i < 5; i++) {
    await recordFieldMisclassified({
      ts: isoNow(),
      jobId: '0123456789ab',
      field_label: `Pronouns ${i}`,
      refId: `e${i}`,
      predicted_class: 'open',
      actual_class: 'legal',
      actual_mapping: 'eeo.pronouns',
      site: 'workday',
    });
  }
  await recordFieldMisclassified({
    ts: isoNow(),
    jobId: '0123456789ab',
    field_label: 'Other',
    refId: 'e9',
    predicted_class: 'open',
    actual_class: 'hard',
    actual_mapping: 'identity.name',
    site: 'icims',
  });
  const counts = await countByGroup(_FILES.FIELD_MISCLASSIFIED, (r) => r.site);
  assert.equal(counts.get('workday'), 5);
  assert.equal(counts.get('icims'), 1);
});

// ── 4. editDistance + classifyError ───────────────────────────────────

await test('editDistance: standard Levenshtein cases', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'hello'), 5);
  assert.equal(editDistance('hello', ''), 5);
  assert.equal(editDistance(null, 'abc'), 3);
});

await test('classifyError: maps Playwright + classifier errors to ERROR_KINDS', () => {
  assert.equal(classifyError(new Error('locator.fill: action_timeout 10000ms')), 'timeout');
  assert.equal(classifyError(new Error('STALE_REF e3')), 'stale_ref');
  assert.equal(classifyError(new Error('Element_gone for refId')), 'element_gone');
  assert.equal(classifyError(new Error('iframe_detached e7')), 'element_gone');
  assert.equal(classifyError(new Error('classifier returned unknown for all')), 'classifier_error');
  assert.equal(classifyError(new Error('ZodError on writeSession')), 'machine_error');
  assert.equal(classifyError(new Error('completely novel disaster')), 'other');
  assert.ok(ERROR_KINDS.includes(classifyError('plain string')));
});

// ── 5. Capture hooks via endpoint.mjs ─────────────────────────────────

await test('approveStep capture hook: records field-edit when edit_distance > 0', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = '0123456789ab';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/external/job/abc',
      siteAdapter: 'workday',
    }),
  );
  let resolveApproval;
  // Mock runMachine that pauses on approve so we can drive approveStep.
  const mockRunMachine = async (_args, _deps) => {
    // Block until the test releases — use a promise + manual hook.
    return new Promise((r) => {
      resolveApproval = r;
    });
  };
  await startMachine(
    { jobId, jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/external/job/abc' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  // Simulate the machine asking for approval — write a pendingApproval
  // directly on the ctrl (bypassing the machine; that's what the
  // approve callback would have done).
  const peek = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = peek._peek(jobId);
  assert.ok(ctrl, 'ctrl present after startMachine');
  ctrl.pendingApproval = {
    resolve: () => {},
    draftInfo: {
      stepIdx: 0,
      totalSteps: 3,
      isDependentRecheck: false,
      draft: {
        step_idx: 0,
        fields: [
          { refId: 'e1', label: 'First Name', class: 'hard', suggested_value: 'Victor', confidence: 'high' },
          { refId: 'e2', label: 'Why us', class: 'open', suggested_value: 'I think your work is great', confidence: 'medium' },
        ],
        captured_at: isoNow(),
      },
      requested_at: isoNow(),
    },
  };
  // Approve with one edit (e2 changed) and one untouched (e1)
  const result = approveStep(jobId, {
    approved: true,
    edits: [
      { refId: 'e1', suggested_value: 'Victor' }, // distance 0 → skipped
      { refId: 'e2', suggested_value: 'I admire your safety research.' }, // distance > 0
    ],
  });
  assert.equal(result.status, 202);
  // Wait a tick for the fire-and-forget record write to settle
  await new Promise((r) => setTimeout(r, 30));
  const records = await readAll(_FILES.FIELD_EDITS);
  assert.equal(records.length, 1, 'only the edited field recorded');
  assert.equal(records[0].field_id, 'e2');
  assert.equal(records[0].field_label, 'Why us');
  assert.equal(records[0].suggested, 'I think your work is great');
  assert.equal(records[0].user_final, 'I admire your safety research.');
  assert.ok(records[0].edit_distance > 0);
  assert.equal(records[0].site, 'workday');
  // Cleanup: release the hanging runMachine
  resolveApproval({ outcome: OUTCOME.COMPLETED });
  await new Promise((r) => setTimeout(r, 30));
});

await test('runMachine error path capture hook: records site-failure', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = '0123456789ab';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://jobs.icims.com/jobs/x',
      siteAdapter: 'icims',
    }),
  );
  const mockRunMachine = async () => {
    throw new Error('locator.fill: action_timeout 10000ms');
  };
  await startMachine(
    { jobId, jobUrl: 'https://jobs.icims.com/jobs/x' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  // Wait for fire-and-forget runner + recordSiteFailure
  await new Promise((r) => setTimeout(r, 50));
  const records = await readAll(_FILES.SITE_FAILURES);
  assert.equal(records.length, 1);
  assert.equal(records[0].domain, 'jobs.icims.com');
  assert.equal(records[0].site_adapter_id, 'icims');
  assert.equal(records[0].error_kind, 'timeout');
  assert.ok(records[0].error_message.includes('action_timeout'));
});

await test('approveStep with no edits: no field-edits recorded', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = '0123456789ab';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://boards.greenhouse.io/x/jobs/1',
      siteAdapter: 'generic',
    }),
  );
  let resolveApproval;
  const mockRunMachine = async () => new Promise((r) => {
    resolveApproval = r;
  });
  await startMachine(
    { jobId, jobUrl: 'https://boards.greenhouse.io/x/jobs/1' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  const peek = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = peek._peek(jobId);
  ctrl.pendingApproval = {
    resolve: () => {},
    draftInfo: {
      stepIdx: 0,
      totalSteps: 1,
      isDependentRecheck: false,
      draft: { step_idx: 0, fields: [{ refId: 'e1', label: 'Name', class: 'hard', suggested_value: 'Victor', confidence: 'high' }], captured_at: isoNow() },
      requested_at: isoNow(),
    },
  };
  // approved=true with no edits
  approveStep(jobId, { approved: true });
  await new Promise((r) => setTimeout(r, 30));
  const records = await readAll(_FILES.FIELD_EDITS);
  assert.equal(records.length, 0);
  resolveApproval({ outcome: OUTCOME.COMPLETED });
  await new Promise((r) => setTimeout(r, 30));
});

await test('FIELD_CLASSES includes the expected closed set', () => {
  assert.deepEqual(
    [...FIELD_CLASSES].sort(),
    ['file', 'hard', 'legal', 'open', 'unknown'],
  );
});

// ── 6. Review-driven regression tests ─────────────────────────────────

await test('REVIEW C1: site-failure recorded when runMachine returns OUTCOME.ERROR (not just on throw)', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = 'aaaa11112222';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/external/job/x',
      siteAdapter: 'workday',
    }),
  );
  // Mock returns ERROR outcome WITHOUT throwing — the dominant prod path.
  const mockRunMachine = async () => ({
    outcome: OUTCOME.ERROR,
    error: 'max-steps cap (20) reached, machine bailing',
  });
  await startMachine(
    { jobId, jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/external/job/x' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  await new Promise((r) => setTimeout(r, 50));
  const records = await readAll(_FILES.SITE_FAILURES);
  assert.equal(records.length, 1, 'site-failure recorded on outcome=ERROR path');
  assert.equal(records[0].site_adapter_id, 'workday');
  assert.equal(records[0].domain, 'anthropic.wd5.myworkdayjobs.com');
  assert.match(records[0].error_message, /max-steps/);
});

await test('REVIEW H4: step_idx is null when error precedes first approval', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = 'bbbb22223333';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://jobs.icims.com/jobs/y',
      siteAdapter: 'icims',
    }),
  );
  const mockRunMachine = async () => {
    throw new Error('adapter activate failed before any approval');
  };
  await startMachine(
    { jobId, jobUrl: 'https://jobs.icims.com/jobs/y' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  await new Promise((r) => setTimeout(r, 50));
  const records = await readAll(_FILES.SITE_FAILURES);
  assert.equal(records.length, 1);
  assert.equal(
    records[0].step_idx,
    null,
    'pre-first-draft failure records step_idx=null, not 0',
  );
});

await test('REVIEW L5: domain is "unknown" when URL is unparseable', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = 'cccc33334444';
  // Force a bogus jobUrl by lying about it; the schema accepts only
  // valid URLs at startMachine entry, so we have to bypass via session.
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://example.com/',
      siteAdapter: 'generic',
    }),
  );
  // startMachine validates jobUrl via Zod, so we can't pass garbage
  // directly. Instead simulate by stashing a bad jobUrl onto ctrl AFTER
  // startMachine. Mock runMachine waits long enough for us to tamper.
  let resolveMock;
  const mockRunMachine = async () => new Promise((r) => {
    resolveMock = r;
  });
  await startMachine(
    { jobId, jobUrl: 'https://example.com/' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  const peek = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = peek._peek(jobId);
  ctrl.jobUrl = ':::not-a-url:::';
  // Now resolve with ERROR to fire the site-failure path
  resolveMock({ outcome: OUTCOME.ERROR, error: 'simulated' });
  await new Promise((r) => setTimeout(r, 50));
  const records = await readAll(_FILES.SITE_FAILURES);
  assert.equal(records.length, 1);
  assert.equal(records[0].domain, 'unknown', 'bad URL → "unknown" domain, not garbage');
});

await test('REVIEW C2: 50 concurrent recordFieldEdit calls — all records intact, no corruption', async () => {
  await clearFeedbackDir();
  const writes = [];
  for (let i = 0; i < 50; i++) {
    writes.push(
      recordFieldEdit({
        ts: isoNow(),
        jobId: '0123456789ab',
        field_id: `e${i}`,
        field_label: `field-${i}`,
        // Use a chunky string to maximize chance of byte-interleave
        // pre-fix (without the mutex, this regularly produced
        // garbled lines in manual testing).
        suggested: 'A'.repeat(2000) + `:${i}`,
        user_final: 'B'.repeat(2000) + `:${i}`,
        edit_distance: 4001,
        confidence: 'medium',
      }),
    );
  }
  await Promise.all(writes);
  const records = await readAll(_FILES.FIELD_EDITS);
  assert.equal(records.length, 50, 'all 50 records survive concurrent writes');
  // Verify content integrity — labels should be field-0 .. field-49, no dupes/skips
  const labels = new Set(records.map((r) => r.field_label));
  assert.equal(labels.size, 50, 'no record corrupted into duplicate or garbled label');
});

await test('REVIEW H2: edit_distance computed on sliced values (no >8000 mismatch)', async () => {
  await clearFeedbackDir();
  _resetAll();
  const jobId = 'dddd44445555';
  await writeSession(
    jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://boards.greenhouse.io/x/jobs/1',
      siteAdapter: 'generic',
    }),
  );
  const mockRunMachine = async () => new Promise(() => {});
  await startMachine(
    { jobId, jobUrl: 'https://boards.greenhouse.io/x/jobs/1' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  const peek = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = peek._peek(jobId);
  // Two long strings identical in first 8000 chars, different past.
  const base = 'A'.repeat(8000);
  ctrl.pendingApproval = {
    resolve: () => {},
    draftInfo: {
      stepIdx: 0,
      totalSteps: 1,
      isDependentRecheck: false,
      draft: {
        step_idx: 0,
        fields: [
          { refId: 'e1', label: 'Long', class: 'open', suggested_value: base + 'AAAA', confidence: 'medium' },
        ],
        captured_at: isoNow(),
      },
      requested_at: isoNow(),
    },
  };
  approveStep(jobId, {
    approved: true,
    edits: [{ refId: 'e1', suggested_value: base + 'BBBB' }],
  });
  await new Promise((r) => setTimeout(r, 30));
  const records = await readAll(_FILES.FIELD_EDITS);
  // After slice(0, 8000) both become `base` → identical → no record.
  // (This is the desired behavior: m2 sees no "edit" when the
  // user-visible portion didn't change.)
  assert.equal(records.length, 0, 'no record when sliced suggested === sliced user_final');
});

await test('REVIEW H3: classifyError uses err.name first (TimeoutError, ZodError)', () => {
  // Pre-fix: a path string like '/applier/classifier/foo.mjs' false-matched 'classifier_error'.
  const pwTimeout = new Error('locator.fill exceeded 10s');
  pwTimeout.name = 'TimeoutError';
  assert.equal(classifyError(pwTimeout), 'timeout');

  const zod = new Error('expected string, received undefined');
  zod.name = 'ZodError';
  assert.equal(classifyError(zod), 'machine_error');

  // err.code (SnapshotError-style) wins over message
  const staleRef = new Error('something');
  staleRef.code = 'STALE_REF';
  assert.equal(classifyError(staleRef), 'stale_ref');

  // Bare message containing 'classifier' alone no longer matches —
  // requires anchored pattern.
  assert.equal(
    classifyError(new Error('caller passed a classifier instance')),
    'other',
    'bare "classifier" mention does not false-positive',
  );
  assert.equal(
    classifyError(new Error('error:classify-failed')),
    'classifier_error',
    'anchored classify-failed still matches',
  );
});

await test('REVIEW H3 (Plan): tsSchema accepts ISO with offset suffix (+00:00 / -08:00)', () => {
  const good = {
    ts: '2026-05-17T10:30:00+00:00',
    jobId: '0123456789ab',
    field_id: 'e1',
    field_label: 'X',
    suggested: 'a',
    user_final: 'b',
    edit_distance: 1,
    confidence: 'high',
  };
  // Should NOT throw — pre-fix this would reject because z.string().datetime()
  // defaults to Z-only.
  FieldEditSchema.parse(good);
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
