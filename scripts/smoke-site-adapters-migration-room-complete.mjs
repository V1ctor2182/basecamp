#!/usr/bin/env node
// Smoke for 07-applier/06-site-adapters m3 (ROOM COMPLETE):
// Legacy multistep/siteAdapter.mjs facade preserves the public API after
// being migrated to YAML-backed via siteAdapters/loader.mjs +
// detector.mjs (m1). endpoint.mjs.startMachine now calls activateAdapter
// before runMachine and reverts in finally.
//
// Pure-Node — uses a mock runMachine to avoid Chromium / real Playwright.
// Verifies:
//   - Legacy contract: KNOWN_IDS / ADAPTERS / detectAdapter / getAdapter
//     / resolve*Hints all unchanged
//   - YAML-sourced hints match the previous inline registry's expectations
//   - Greenhouse / Ashby / Lever (single-step) URLs collapse to 'generic'
//   - getCompiledAdapter returns the m1 CompiledAdapter (new API)
//   - endpoint.mjs activates adapter before runMachine, deactivates after

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';

import {
  KNOWN_IDS,
  ADAPTERS,
  detectAdapter,
  getAdapter,
  getCompiledAdapter,
  getRegistry,
  resolveNextButtonHints,
  resolveProgressBarHints,
  resolveStepListHints,
  resolveSubmitHints,
} from '../src/career/applier/multistep/siteAdapter.mjs';
import {
  APPLY_SESSIONS_DIR,
  buildInitialSession,
  writeSession,
} from '../src/career/applier/multistep/applySessionsStore.mjs';
import { startMachine, _resetAll, OUTCOME } from '../src/career/applier/multistep/endpoint.mjs';
import { DETECTION_RULES } from '../src/career/applier/nonstandard/controlRouter.mjs';
import { _activeTokenCount } from '../src/career/applier/siteAdapters/activate.mjs';

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

// ── Apply-sessions fixture isolation (some tests write sessions) ────────
const BACKUP = APPLY_SESSIONS_DIR + `.smoke-m3-backup.${process.pid}`;
function setupFixture() {
  if (existsSync(APPLY_SESSIONS_DIR)) renameSync(APPLY_SESSIONS_DIR, BACKUP);
}
function restoreFixture() {
  if (existsSync(APPLY_SESSIONS_DIR)) rmSync(APPLY_SESSIONS_DIR, { recursive: true, force: true });
  if (existsSync(BACKUP)) renameSync(BACKUP, APPLY_SESSIONS_DIR);
}
setupFixture();
process.on('exit', restoreFixture);
process.on('uncaughtException', (e) => {
  restoreFixture();
  console.error('uncaught:', e);
  process.exit(2);
});

// ── 1. Legacy contract preserved ───────────────────────────────────────

await test('KNOWN_IDS unchanged after m3 migration', () => {
  assert.deepEqual(
    [...KNOWN_IDS],
    ['workday', 'icims', 'successfactors', 'generic'],
  );
});

await test('ADAPTERS has 4 entries with required legacy fields', () => {
  assert.equal(ADAPTERS.length, 4);
  for (const a of ADAPTERS) {
    assert.ok(KNOWN_IDS.includes(a.id), `id ${a.id} in KNOWN_IDS`);
    assert.ok(Array.isArray(a.nextButtonHints) && a.nextButtonHints.length >= 1);
    assert.ok(Array.isArray(a.progressBarHints));
    assert.ok(Array.isArray(a.stepListHints));
    assert.ok(Array.isArray(a.submitHints));
  }
});

await test('ADAPTERS hint arrays are deduped (no `_common.yml` merge dupes)', () => {
  const wd = ADAPTERS.find((a) => a.id === 'workday');
  const uniq = new Set(wd.nextButtonHints);
  assert.equal(uniq.size, wd.nextButtonHints.length, 'workday nextButtonHints unique');
});

await test('detectAdapter: Workday URLs → workday', () => {
  assert.equal(
    detectAdapter('https://anthropic.wd5.myworkdayjobs.com/External/job/ABC-123'),
    'workday',
  );
  assert.equal(detectAdapter('https://workdayjobs.com/...'), 'workday');
});

await test('detectAdapter: iCIMS URLs → icims', () => {
  assert.equal(detectAdapter('https://jobs.icims.com/jobs/12345/apply'), 'icims');
  assert.equal(detectAdapter('https://example-tenant.icims.com/jobs/X'), 'icims');
});

await test('detectAdapter: SuccessFactors URLs → successfactors', () => {
  assert.equal(detectAdapter('https://career5.successfactors.com/career/jobReqId=1'), 'successfactors');
});

await test('detectAdapter: Greenhouse / Ashby / Lever (single-step) → generic (NOT their own id)', () => {
  // The new YAML registry has greenhouse/ashby/lever as full adapters, but
  // the multi-step state machine only consumes the 4 multi-step IDs. Those
  // single-step ATS URLs MUST collapse to 'generic' for the legacy contract.
  assert.equal(detectAdapter('https://boards.greenhouse.io/anthropic/jobs/123'), 'generic');
  assert.equal(detectAdapter('https://jobs.ashbyhq.com/openai/abc'), 'generic');
  assert.equal(detectAdapter('https://jobs.lever.co/coinbase/xyz'), 'generic');
});

await test('detectAdapter: unknown / empty / non-string → generic', () => {
  assert.equal(detectAdapter('https://example.com/careers'), 'generic');
  assert.equal(detectAdapter(''), 'generic');
  assert.equal(detectAdapter(null), 'generic');
  assert.equal(detectAdapter(undefined), 'generic');
  assert.equal(detectAdapter(42), 'generic');
});

await test('getAdapter: known id returns descriptor; unknown throws', () => {
  assert.equal(getAdapter('workday').id, 'workday');
  assert.equal(getAdapter('generic').id, 'generic');
  // Single-step IDs are NOT exposed via legacy getAdapter — those flow
  // through 01-mode1-simplify-hybrid, not the multi-step machine.
  assert.throws(() => getAdapter('lever'), /unknown adapter/);
  assert.throws(() => getAdapter('greenhouse'), /unknown adapter/);
});

await test('resolveNextButtonHints: id-or-descriptor parity', () => {
  const a = getAdapter('workday');
  assert.deepEqual(resolveNextButtonHints('workday'), a.nextButtonHints);
  assert.deepEqual(resolveNextButtonHints(a), a.nextButtonHints);
});

await test('resolveProgressBarHints + resolveStepListHints + resolveSubmitHints', () => {
  const a = getAdapter('workday');
  assert.deepEqual(resolveProgressBarHints('workday'), a.progressBarHints);
  assert.deepEqual(resolveStepListHints('workday'), a.stepListHints);
  assert.deepEqual(resolveSubmitHints('workday'), a.submitHints);
});

await test('Workday hints match pre-migration inline registry contract', () => {
  const wd = getAdapter('workday');
  // Pre-migration: nextButtonHints = ['Next', 'Save and Continue', 'Continue']
  // After migration (deduped): contains those + _common's appended values.
  for (const required of ['Next', 'Save and Continue', 'Continue']) {
    assert.ok(wd.nextButtonHints.includes(required), `missing "${required}"`);
  }
  for (const required of ['Submit', 'Submit Application']) {
    assert.ok(wd.submitHints.includes(required), `missing "${required}"`);
  }
});

await test('iCIMS hints match pre-migration', () => {
  const ic = getAdapter('icims');
  for (const required of ['Next', 'Continue', 'Save & Continue']) {
    assert.ok(ic.nextButtonHints.includes(required), `missing "${required}"`);
  }
});

await test('SuccessFactors hints match pre-migration', () => {
  const sf = getAdapter('successfactors');
  for (const required of ['Next', 'Continue', 'Forward']) {
    assert.ok(sf.nextButtonHints.includes(required), `missing "${required}"`);
  }
});

// ── 2. New API: getCompiledAdapter + getRegistry ───────────────────────

await test('getCompiledAdapter by legacy id → m1 CompiledAdapter', () => {
  const wd = getCompiledAdapter('workday');
  assert.equal(wd.id, 'workday');
  assert.ok(wd.detection.urlRegexes.length > 0);
  // workday.controls intentionally empty (REVIEW C2 — MuiPickersDay was wrong)
  // — verify the shape exists for activateAdapter though.
  assert.equal(typeof wd.controls, 'object');
});

await test('getCompiledAdapter for "generic" legacy id → default adapter from new schema', () => {
  const generic = getCompiledAdapter('generic');
  assert.equal(generic.id, 'default', "facade's 'generic' legacy id maps to m1 schema's 'default'");
});

await test('getCompiledAdapter by URL returns greenhouse adapter (single-step)', () => {
  // detectAdapter returns 'generic' for greenhouse URLs (legacy contract),
  // but getCompiledAdapter sees the TRUE match — so endpoint.mjs activates
  // the greenhouse-specific hints even though the machine sees 'generic'.
  const gh = getCompiledAdapter('https://boards.greenhouse.io/anthropic/jobs/123');
  assert.equal(gh.id, 'greenhouse');
});

await test('getCompiledAdapter: unknown id throws', () => {
  assert.throws(() => getCompiledAdapter('totally-bogus-id'), /unknown id/);
});

await test('getCompiledAdapter: empty / null → default adapter', () => {
  assert.equal(getCompiledAdapter('').id, 'default');
  assert.equal(getCompiledAdapter(null).id, 'default');
});

await test('getRegistry: exposes underlying m1 registry', () => {
  const reg = getRegistry();
  assert.ok(reg.adapters.length >= 3, 'has workday/icims/successfactors + single-step');
  assert.equal(reg.default.id, 'default');
});

// ── 3. endpoint.mjs activates adapter before runMachine ────────────────

await test('endpoint.startMachine: activates adapter + reverts on completion', async () => {
  _resetAll();
  const baselineRules = DETECTION_RULES.length;
  const baselineTokens = _activeTokenCount();

  let machineSawSiteAdapter = null;
  let mockRanMachine = false;
  const mockRunMachine = async (args) => {
    mockRanMachine = true;
    machineSawSiteAdapter = args.siteAdapter;
    // During run, activation should be live → an extra token + extra rules
    assert.equal(_activeTokenCount(), baselineTokens + 1, 'token live during run');
    // Workday YAML's date_picker control adds 1 rule
    assert.ok(DETECTION_RULES.length > baselineRules, 'rules live during run');
    return { outcome: OUTCOME.COMPLETED, error: null };
  };

  // Pre-create the session file so startMachine doesn't reject for the
  // multi-step machine's createIfMissing path that needs apply-sessions/.
  const jobId = '0123456789ab';
  await writeSession(jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/External/job/abc',
      siteAdapter: 'workday',
    }),
  );

  const result = await startMachine(
    {
      jobId,
      jobUrl: 'https://anthropic.wd5.myworkdayjobs.com/External/job/abc',
    },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  assert.equal(result.sessionId, jobId);

  // Allow the fire-and-forget runner to drain.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(mockRanMachine, true, 'mock runMachine called');
  assert.equal(machineSawSiteAdapter, 'workday', 'workday detected from URL');
  assert.equal(_activeTokenCount(), baselineTokens, 'token reverted after completion');
  assert.equal(DETECTION_RULES.length, baselineRules, 'rules cleaned after completion');
});

await test('endpoint.startMachine: reverts adapter on runMachine throw', async () => {
  _resetAll();
  const baselineRules = DETECTION_RULES.length;
  const baselineTokens = _activeTokenCount();

  const jobId = 'ab0123456789';
  await writeSession(jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://jobs.icims.com/jobs/x',
      siteAdapter: 'icims',
    }),
  );

  const mockRunMachine = async () => {
    throw new Error('synthetic apply failure');
  };
  await startMachine(
    { jobId, jobUrl: 'https://jobs.icims.com/jobs/x' },
    { _runMachine: mockRunMachine, _getPage: async () => ({ __mock: 'page' }) },
  );
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(_activeTokenCount(), baselineTokens, 'token reverted on throw');
  assert.equal(DETECTION_RULES.length, baselineRules, 'rules cleaned on throw');
});

await test('endpoint.startMachine: __SMOKE_skipAdapterActivation bypasses activation (smoke override)', async () => {
  _resetAll();
  const baselineRules = DETECTION_RULES.length;
  const baselineTokens = _activeTokenCount();

  const jobId = 'fedcba987654';
  await writeSession(jobId,
    buildInitialSession({
      jobId,
      jobUrl: 'https://boards.greenhouse.io/anthropic/jobs/1',
      siteAdapter: 'generic',
    }),
  );
  let machineSawTokens = -1;
  await startMachine(
    { jobId, jobUrl: 'https://boards.greenhouse.io/anthropic/jobs/1' },
    {
      __SMOKE_skipAdapterActivation: true,
      _runMachine: async () => {
        machineSawTokens = _activeTokenCount();
        return { outcome: OUTCOME.COMPLETED };
      },
      _getPage: async () => ({ __mock: 'page' }),
    },
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(machineSawTokens, baselineTokens, 'no activation when _skipAdapterActivation set');
  assert.equal(DETECTION_RULES.length, baselineRules);
});

// ── 4. ROOM COMPLETE rollups ──────────────────────────────────────────

await test('Verify ROOM COMPLETE rollups (8 YAMLs total: 5 from m1 + 3 from m3)', () => {
  const reg = getRegistry();
  const ids = [...reg.adapters.map((a) => a.id), reg.default.id].sort();
  assert.deepEqual(
    ids,
    ['ashby', 'default', 'greenhouse', 'icims', 'lever', 'successfactors', 'workday'].sort(),
    '7 non-_common YAMLs registered',
  );
});

// ── Review-driven regression tests ────────────────────────────────────

await test('REVIEW C1 (m3): workday.yml known_fields maps_to point at REAL legal.yml keys', () => {
  // Pre-fix: 'legal.work_auth' / 'legal.sponsorship' didn't exist in
  // legal.yml. Verify the corrected paths against the actual qa-bank YAML.
  const wd = getCompiledAdapter('workday');
  const mapsList = wd.known_fields.map((kf) => kf.maps_to);
  assert.ok(
    mapsList.includes('work_authorization.authorized_us_yes_no'),
    'workday must reference real legal.yml key authorized_us_yes_no',
  );
  assert.ok(
    mapsList.includes('work_authorization.requires_sponsorship_now'),
    'workday must reference real legal.yml key requires_sponsorship_now',
  );
  // Old broken paths must NOT appear.
  assert.equal(
    mapsList.includes('legal.work_auth'),
    false,
    'pre-fix broken path "legal.work_auth" removed',
  );
});

await test('REVIEW C2 (m3): workday.yml controls.date_picker removed (MuiPickersDay was wrong)', () => {
  const wd = getCompiledAdapter('workday');
  assert.deepEqual(
    wd.controls,
    {},
    'workday controls intentionally empty — was MuiPickersDay (not real)',
  );
});

await test('REVIEW C4 (m3): _common.yml Forward removed — only successfactors gets it', () => {
  const wd = getAdapter('workday');
  assert.equal(wd.nextButtonHints.includes('Forward'), false, 'workday no longer claims Forward');
  const ic = getAdapter('icims');
  assert.equal(ic.nextButtonHints.includes('Forward'), false, 'icims no longer claims Forward');
  // SuccessFactors declares Forward in its own YAML
  const sf = getAdapter('successfactors');
  assert.ok(sf.nextButtonHints.includes('Forward'), 'successfactors still has Forward');
});

await test('REVIEW C5 (m3): getCompiledAdapter strict URL detection (`://` not `.`)', () => {
  // Pre-fix: a non-URL id with a `.` like `foo.bar` was routed to detector
  // and silently returned `default` instead of throwing "unknown id".
  assert.throws(
    () => getCompiledAdapter('foo.bar'),
    /unknown id/,
    'dotted id falls through to id branch + throws',
  );
  // URLs still detect correctly
  assert.equal(
    getCompiledAdapter('https://boards.greenhouse.io/x').id,
    'greenhouse',
  );
});

await test('REVIEW C3 (m3): siteAdapter._loadError exposed for diagnostics', async () => {
  // _loadError is null in happy path; we just verify the export exists.
  const mod = await import('../src/career/applier/multistep/siteAdapter.mjs');
  assert.ok('_loadError' in mod, '_loadError exported for boot diagnostics');
  // On a healthy load it should be null.
  assert.equal(mod._loadError, null);
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
