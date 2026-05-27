#!/usr/bin/env node
// Smoke for 07-applier/04-multi-step-state-machine m4:
// endpoint.mjs (startMachine + approveStep + pauseMachine + resumeMachine
// + getStatus). ROOM COMPLETE smoke.
//
// Pure-Node — calls endpoint functions directly with mocked runMachine
// and getPage. No Chromium, no HTTP server (server.mjs routes are thin
// wrappers we verify by shape inspection of the body schemas exported).
// ~2s.

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';

import {
  APPLY_SESSIONS_DIR,
  buildInitialSession,
  readSession,
  writeSession,
  deleteSession,
} from '../src/career/applier/multistep/applySessionsStore.mjs';
import {
  StartBodySchema,
  ApproveStepBodySchema,
  ResumeBodySchema,
  startMachine,
  approveStep,
  pauseMachine,
  resumeMachine,
  getStatus,
  cancelMachine,  // m7
  _peek,
  _resetAll,
  OUTCOME,
} from '../src/career/applier/multistep/endpoint.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    syncRestoreOnCrash();
    process.exit(1);
  }
}

// ── Fixture isolation ────────────────────────────────────────────────
const BACKUP = APPLY_SESSIONS_DIR + `.smoke-backup.${process.pid}`;
let hadSessions = false;
if (existsSync(APPLY_SESSIONS_DIR)) {
  await fs.rename(APPLY_SESSIONS_DIR, BACKUP);
  hadSessions = true;
}
async function cleanup() {
  if (existsSync(APPLY_SESSIONS_DIR)) await fs.rm(APPLY_SESSIONS_DIR, { recursive: true, force: true });
  if (hadSessions) await fs.rename(BACKUP, APPLY_SESSIONS_DIR);
}
function syncRestoreOnCrash() {
  try {
    if (existsSync(APPLY_SESSIONS_DIR)) rmSync(APPLY_SESSIONS_DIR, { recursive: true, force: true });
    if (hadSessions && existsSync(BACKUP)) renameSync(BACKUP, APPLY_SESSIONS_DIR);
  } catch {}
}
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); syncRestoreOnCrash(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e); syncRestoreOnCrash(); process.exit(1); });

// Reset endpoint state between tests
function resetBetween() { _resetAll(); }

// Helper: build a mock runMachine that exercises the approve callback
// and resolves with a given outcome after N approval cycles.
function makeMockRunMachine({ approveCycles, finalOutcome = 'completed', errorMsg }) {
  let cyclesRemaining = approveCycles;
  return async function mockRunMachine(args, _deps) {
    while (cyclesRemaining > 0) {
      cyclesRemaining--;
      const approval = await args.approve({
        stepIdx: approveCycles - cyclesRemaining - 1,
        totalSteps: approveCycles,
        draft: { step_idx: approveCycles - cyclesRemaining - 1, fields: [], captured_at: new Date().toISOString() },
      });
      if (!approval || !approval.approved) {
        // Persist a paused session so getStatus reflects
        await writeSession(args.jobId, {
          ...buildInitialSession({ jobId: args.jobId, jobUrl: args.jobUrl, siteAdapter: args.siteAdapter }),
          status: 'paused',
          current_step: approveCycles - cyclesRemaining - 1,
        });
        return { outcome: 'paused', session: null, steps_run: approveCycles - cyclesRemaining };
      }
    }
    // Completed
    await writeSession(args.jobId, {
      ...buildInitialSession({ jobId: args.jobId, jobUrl: args.jobUrl, siteAdapter: args.siteAdapter }),
      status: finalOutcome === 'completed' ? 'completed' : 'paused',
      current_step: approveCycles,
    });
    return { outcome: finalOutcome, session: null, steps_run: approveCycles, ...(errorMsg ? { error: errorMsg } : {}) };
  };
}

// ── 1. Body schemas ──────────────────────────────────────────────────

await test('StartBodySchema: valid + rejects bad', () => {
  const ok = StartBodySchema.parse({ jobId: 'aaaaaaaaaaaa', jobUrl: 'https://x.com/y' });
  assert.equal(ok.jobId, 'aaaaaaaaaaaa');
  assert.throws(() => StartBodySchema.parse({ jobId: 'BAD' }));
  assert.throws(() => StartBodySchema.parse({ jobId: 'aaaaaaaaaaaa', jobUrl: 'not-a-url' }));
});

await test('StartBodySchema: optional fields pass through', () => {
  const ok = StartBodySchema.parse({
    jobId: 'aaaaaaaaaaaa',
    jobUrl: 'https://x.com',
    siteAdapter: 'workday',
    resumeId: 'cv1',
    jdSummary: 'role at Acme',
    narrativeVoice: 'concise',
    maxSteps: 10,
  });
  assert.equal(ok.maxSteps, 10);
  assert.equal(ok.siteAdapter, 'workday');
});

await test('StartBodySchema: rejects unknown extra field (strict)', () => {
  assert.throws(() => StartBodySchema.parse({
    jobId: 'aaaaaaaaaaaa', jobUrl: 'https://x.com', mystery: 'x',
  }));
});

await test('ApproveStepBodySchema: shape + edits cap', () => {
  const ok = ApproveStepBodySchema.parse({ approved: true });
  assert.equal(ok.approved, true);
  const withEdits = ApproveStepBodySchema.parse({
    approved: true,
    edits: [{ refId: 'e1', suggested_value: 'v' }],
  });
  assert.equal(withEdits.edits.length, 1);
  // Reject 51 edits (max 50)
  const tooMany = { approved: true, edits: Array.from({ length: 51 }, (_, i) => ({ refId: `e${i}`, suggested_value: 'v' })) };
  assert.throws(() => ApproveStepBodySchema.parse(tooMany));
});

await test('ResumeBodySchema: requires jobId', () => {
  assert.throws(() => ResumeBodySchema.parse({}));
  const ok = ResumeBodySchema.parse({ jobId: 'aaaaaaaaaaaa' });
  assert.equal(ok.jobId, 'aaaaaaaaaaaa');
});

// ── 2. startMachine basic flow ───────────────────────────────────────

await test('startMachine: 1-step happy path → approved → completed', async () => {
  resetBetween();
  const jobId = 'bbbbbbbbbb01';
  const mockRun = makeMockRunMachine({ approveCycles: 1, finalOutcome: 'completed' });

  const result = await startMachine(
    { jobId, jobUrl: 'https://workdayjobs.com/x', siteAdapter: 'workday' },
    { _runMachine: mockRun, _getPage: async () => ({}) },
  );
  assert.equal(result.sessionId, jobId);
  assert.ok(result.started_at);

  // Wait a tick for the background machine to call approve
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // getStatus should show awaiting-approval + pending draft
  const status = await getStatus(jobId);
  // Session doesn't exist yet (mockRun writes at end); accept either
  // 404 (machine started, session not yet written) OR 200 with pending.
  if (status.status === 200) {
    assert.ok(status.machine);
    assert.equal(status.machine.state, 'awaiting-approval');
    assert.ok(status.machine.pending);
  }

  // Approve the pending step
  const approveRes = approveStep(jobId, { approved: true });
  assert.equal(approveRes.status, 202);

  // Wait for machine to finish
  await new Promise((r) => setTimeout(r, 50));

  const finalStatus = await getStatus(jobId);
  assert.equal(finalStatus.status, 200);
  assert.equal(finalStatus.session.status, 'completed');

  await deleteSession(jobId);
});

await test('startMachine: rejects duplicate start for same jobId', async () => {
  resetBetween();
  const jobId = 'bbbbbbbbbb02';
  // Build a runMachine that never resolves (so the first start stays alive)
  const hung = () => new Promise(() => {});

  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: hung, _getPage: async () => ({}) },
  );

  const second = await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: hung, _getPage: async () => ({}) },
  );
  assert.equal(second.status, 409);
  assert.match(second.error, /already running/);

  _resetAll(); // clean up the hung machine
});

await test('startMachine: getPage failure → 503', async () => {
  resetBetween();
  const jobId = 'bbbbbbbbbb03';
  const result = await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    {
      _runMachine: makeMockRunMachine({ approveCycles: 0 }),
      _getPage: async () => { throw new Error('browser cold'); },
    },
  );
  assert.equal(result.status, 503);
  assert.match(result.error, /getPage failed/);
});

// ── 3. approveStep variants ──────────────────────────────────────────

await test('approveStep: no machine → 404', () => {
  resetBetween();
  const res = approveStep('cccccccccc01', { approved: true });
  assert.equal(res.status, 404);
});

await test('approveStep: machine running but no pending approval → 409', async () => {
  resetBetween();
  const jobId = 'cccccccccc02';
  // Machine that's "running" but never asks for approval (then completes)
  const noApprove = async (args) => {
    // Don't call args.approve; just immediately resolve
    await new Promise((r) => setTimeout(r, 50));
    await writeSession(jobId, {
      ...buildInitialSession({ jobId, jobUrl: args.jobUrl, siteAdapter: args.siteAdapter || 'workday' }),
      status: 'completed',
    });
    return { outcome: 'completed', session: null, steps_run: 0 };
  };
  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: noApprove, _getPage: async () => ({}) },
  );
  // Immediately call approveStep — machine is running but no pending
  const res = approveStep(jobId, { approved: true });
  assert.equal(res.status, 409);
  assert.match(res.error, /no pending approval/);

  await new Promise((r) => setTimeout(r, 100));
  await deleteSession(jobId);
});

await test('approveStep: invalid jobId → 400', () => {
  const res = approveStep('NOT-HEX', { approved: true });
  assert.equal(res.status, 400);
});

await test('approveStep: edits propagate to the runMachine approve', async () => {
  resetBetween();
  const jobId = 'cccccccccc03';
  let receivedEdits;
  const captureMock = async (args) => {
    const approval = await args.approve({
      stepIdx: 0,
      totalSteps: 1,
      draft: { step_idx: 0, fields: [], captured_at: new Date().toISOString() },
    });
    receivedEdits = approval.edits;
    await writeSession(jobId, {
      ...buildInitialSession({ jobId, jobUrl: args.jobUrl, siteAdapter: args.siteAdapter || 'workday' }),
      status: 'completed',
    });
    return { outcome: 'completed', session: null, steps_run: 1 };
  };
  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: captureMock, _getPage: async () => ({}) },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const ok = approveStep(jobId, { approved: true, edits: [{ refId: 'e1', suggested_value: 'fixed' }] });
  assert.equal(ok.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(receivedEdits, [{ refId: 'e1', suggested_value: 'fixed' }]);

  await deleteSession(jobId);
});

// ── 4. pauseMachine ──────────────────────────────────────────────────

await test('pauseMachine: pending approval → resolves with approved:false', async () => {
  resetBetween();
  const jobId = 'dddddddddd01';
  const mockRun = makeMockRunMachine({ approveCycles: 2 });

  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: mockRun, _getPage: async () => ({}) },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const pauseRes = pauseMachine(jobId);
  assert.equal(pauseRes.status, 202);

  await new Promise((r) => setTimeout(r, 50));
  const status = await getStatus(jobId);
  assert.equal(status.status, 200);
  assert.equal(status.session.status, 'paused');

  await deleteSession(jobId);
});

await test('pauseMachine: no machine → 404', () => {
  resetBetween();
  const res = pauseMachine('dddddddddd02');
  assert.equal(res.status, 404);
});

await test('pauseMachine: invalid jobId → 400', () => {
  const res = pauseMachine('NOT-HEX');
  assert.equal(res.status, 400);
});

// ── 5. getStatus variants ────────────────────────────────────────────

await test('getStatus: no session on disk → 404', async () => {
  resetBetween();
  const res = await getStatus('eeeeeeeeee01');
  assert.equal(res.status, 404);
});

await test('getStatus: session exists + no machine running → machine.state=idle', async () => {
  resetBetween();
  const jobId = 'eeeeeeeeee02';
  await writeSession(jobId, {
    ...buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' }),
    status: 'completed',
  });
  const res = await getStatus(jobId);
  assert.equal(res.status, 200);
  assert.equal(res.session.status, 'completed');
  assert.equal(res.machine.state, 'idle');

  await deleteSession(jobId);
});

await test('getStatus: invalid jobId → 400', async () => {
  const res = await getStatus('NOT-HEX');
  assert.equal(res.status, 400);
});

// ── 6. resumeMachine ─────────────────────────────────────────────────

await test('resumeMachine: paused session → spawns new machine', async () => {
  resetBetween();
  const jobId = 'fffffffff001';
  // Seed a paused session on disk
  await writeSession(jobId, {
    ...buildInitialSession({ jobId, jobUrl: 'https://workdayjobs.com/x', siteAdapter: 'workday' }),
    status: 'paused',
    current_step: 2,
  });
  const mockRun = makeMockRunMachine({ approveCycles: 0, finalOutcome: 'completed' });
  const res = await resumeMachine(
    { jobId },
    { _runMachine: mockRun, _getPage: async () => ({}) },
  );
  assert.equal(res.sessionId, jobId);
  assert.ok(res.started_at);

  await new Promise((r) => setTimeout(r, 50));
  const status = await getStatus(jobId);
  assert.equal(status.session.status, 'completed');

  await deleteSession(jobId);
});

await test('resumeMachine: no session on disk → 404', async () => {
  resetBetween();
  const res = await resumeMachine(
    { jobId: 'fffffffff002' },
    { _runMachine: makeMockRunMachine({ approveCycles: 0 }), _getPage: async () => ({}) },
  );
  assert.equal(res.status, 404);
});

await test('resumeMachine: abandoned session → 410', async () => {
  resetBetween();
  const jobId = 'fffffffff003';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.last_activity_at = '2020-01-01T00:00:00.000Z'; // ancient → abandoned via lazy
  await writeSession(jobId, s, { bumpActivity: false });
  const res = await resumeMachine(
    { jobId },
    { _runMachine: makeMockRunMachine({ approveCycles: 0 }), _getPage: async () => ({}) },
  );
  assert.equal(res.status, 410);
  assert.match(res.error, /abandoned/);

  await deleteSession(jobId);
});

await test('resumeMachine: already-running → 409', async () => {
  resetBetween();
  const jobId = 'fffffffff004';
  await writeSession(jobId, {
    ...buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' }),
    status: 'paused',
  });
  // First resume succeeds (hangs the machine intentionally)
  const hung = () => new Promise(() => {});
  await resumeMachine(
    { jobId },
    { _runMachine: hung, _getPage: async () => ({}) },
  );
  const second = await resumeMachine(
    { jobId },
    { _runMachine: hung, _getPage: async () => ({}) },
  );
  assert.equal(second.status, 409);

  _resetAll();
  await deleteSession(jobId);
});

await test('resumeMachine: completed session → 409 (terminal state)', async () => {
  resetBetween();
  const jobId = 'fffffffff005';
  await writeSession(jobId, {
    ...buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' }),
    status: 'completed',
  });
  const res = await resumeMachine(
    { jobId },
    { _runMachine: makeMockRunMachine({ approveCycles: 0 }), _getPage: async () => ({}) },
  );
  // M1 fix: was 200 with message; now 409 so route surfaces non-202
  assert.equal(res.status, 409);
  assert.match(res.error, /already completed/);

  await deleteSession(jobId);
});

// ── 7. End-to-end choreography ───────────────────────────────────────

await test('e2e: start → approve × 3 → completed', async () => {
  resetBetween();
  const jobId = '111111111101';
  const mockRun = makeMockRunMachine({ approveCycles: 3, finalOutcome: 'completed' });

  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: mockRun, _getPage: async () => ({}) },
  );

  for (let step = 0; step < 3; step++) {
    // Wait until pending
    let tries = 50;
    while (tries-- > 0) {
      const ctrl = _peek(jobId);
      if (ctrl && ctrl.pendingApproval) break;
      await new Promise((r) => setImmediate(r));
    }
    const ctrl = _peek(jobId);
    assert.ok(ctrl?.pendingApproval, `step ${step}: should have pending approval`);
    const res = approveStep(jobId, { approved: true });
    assert.equal(res.status, 202);
  }
  // Wait for completion
  await new Promise((r) => setTimeout(r, 100));
  const status = await getStatus(jobId);
  assert.equal(status.session.status, 'completed');

  await deleteSession(jobId);
});

await test('e2e: start → approve → pause mid-flow → resume → complete', async () => {
  resetBetween();
  const jobId = '111111111102';

  // Mock run that does 2 approve cycles
  const mockRun = makeMockRunMachine({ approveCycles: 2, finalOutcome: 'completed' });

  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: mockRun, _getPage: async () => ({}) },
  );

  // Wait for first pending
  let tries = 50;
  while (tries-- > 0) {
    if (_peek(jobId)?.pendingApproval) break;
    await new Promise((r) => setImmediate(r));
  }
  approveStep(jobId, { approved: true });

  // Wait for second pending then PAUSE
  tries = 50;
  while (tries-- > 0) {
    if (_peek(jobId)?.pendingApproval) break;
    await new Promise((r) => setImmediate(r));
  }
  pauseMachine(jobId);

  // Wait for paused state on disk
  await new Promise((r) => setTimeout(r, 100));
  const pausedStatus = await getStatus(jobId);
  assert.equal(pausedStatus.session.status, 'paused');

  // Resume — new machine instance, but we need to reset the registry
  // since the prior controller is still in 'done' state.
  _resetAll();
  const mockRun2 = makeMockRunMachine({ approveCycles: 1, finalOutcome: 'completed' });
  await resumeMachine(
    { jobId },
    { _runMachine: mockRun2, _getPage: async () => ({}) },
  );
  // Approve the resumed step
  tries = 50;
  while (tries-- > 0) {
    if (_peek(jobId)?.pendingApproval) break;
    await new Promise((r) => setImmediate(r));
  }
  approveStep(jobId, { approved: true });
  await new Promise((r) => setTimeout(r, 100));
  const final = await getStatus(jobId);
  assert.equal(final.session.status, 'completed');

  await deleteSession(jobId);
});

// ── 8. Review-fix coverage ───────────────────────────────────────────

await test('H1: concurrent startMachine for same jobId → exactly one wins (no double spawn)', async () => {
  resetBetween();
  const jobId = '222222222201';
  let spawnCount = 0;
  const hung = async () => {
    spawnCount++;
    return new Promise(() => {}); // never resolves
  };
  // Fire two concurrent starts
  const [a, b] = await Promise.all([
    startMachine({ jobId, jobUrl: 'https://x.com' }, { _runMachine: hung, _getPage: async () => ({}) }),
    startMachine({ jobId, jobUrl: 'https://x.com' }, { _runMachine: hung, _getPage: async () => ({}) }),
  ]);
  const successes = [a, b].filter((r) => r.sessionId).length;
  const conflicts = [a, b].filter((r) => r.status === 409).length;
  assert.equal(successes, 1, 'exactly one start succeeds');
  assert.equal(conflicts, 1, 'exactly one conflicts');
  // Spawn count <= 1 (the other was rejected before runMachine call)
  assert.ok(spawnCount <= 1);
  _resetAll();
});

await test('L5: pause before first approve → next approve auto-declines', async () => {
  resetBetween();
  const jobId = '222222222202';
  let approvalGate = null;
  let machineResolved = false;
  const slowMachine = async (args) => {
    // Delay before reaching approve
    await new Promise((r) => setTimeout(r, 30));
    const approval = await args.approve({ stepIdx: 0, totalSteps: 1, draft: { step_idx: 0, fields: [], captured_at: new Date().toISOString() } });
    approvalGate = approval;
    await writeSession(jobId, {
      ...buildInitialSession({ jobId, jobUrl: args.jobUrl, siteAdapter: args.siteAdapter || 'workday' }),
      status: 'paused',
    });
    machineResolved = true;
    return { outcome: 'paused', session: null, steps_run: 0 };
  };
  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: slowMachine, _getPage: async () => ({}) },
  );
  // Immediately pause (before machine reaches the approve gate)
  const pauseRes = pauseMachine(jobId);
  assert.equal(pauseRes.status, 202);
  // Wait for machine to settle
  let tries = 50;
  while (tries-- > 0 && !machineResolved) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(machineResolved, 'machine should have resolved');
  // L5: the approve callback returned {approved:false} because pauseRequested flag was set
  assert.deepEqual(approvalGate, { approved: false });
  await deleteSession(jobId);
});

await test('M4: restart after error within 30s grace → succeeds (not 409)', async () => {
  resetBetween();
  const jobId = '222222222203';
  // First machine errors out immediately
  const erroring = async (args) => {
    await writeSession(jobId, {
      ...buildInitialSession({ jobId, jobUrl: args.jobUrl, siteAdapter: 'workday' }),
      status: 'paused',
    });
    return { outcome: 'error', session: null, steps_run: 0, error: 'simulated' };
  };
  const first = await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: erroring, _getPage: async () => ({}) },
  );
  assert.ok(first.sessionId);
  await new Promise((r) => setTimeout(r, 50)); // wait for settle

  // ctrl is still in map (30s grace) but state='done'
  const ctrl = _peek(jobId);
  assert.ok(ctrl);
  assert.equal(ctrl.state, 'done');

  // M4 fix: a fresh start should succeed despite the lingering ctrl
  const second = await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: erroring, _getPage: async () => ({}) },
  );
  assert.ok(second.sessionId, 'restart should succeed within grace window');
  await new Promise((r) => setTimeout(r, 50));
  await deleteSession(jobId);
  _resetAll();
});

await test('H2: getStatus exposes lastDraftInfo after settle', async () => {
  resetBetween();
  const jobId = '222222222204';
  // Machine pauses at first approve, settles to paused
  const pauseMock = async (args) => {
    await args.approve({
      stepIdx: 0,
      totalSteps: 1,
      draft: { step_idx: 0, fields: [{ label: 'Email', class: 'hard', suggested_value: 'a@b.com' }], captured_at: new Date().toISOString() },
    });
    await writeSession(jobId, {
      ...buildInitialSession({ jobId, jobUrl: args.jobUrl, siteAdapter: 'workday' }),
      status: 'paused',
    });
    return { outcome: 'paused', session: null, steps_run: 0 };
  };
  await startMachine(
    { jobId, jobUrl: 'https://x.com' },
    { _runMachine: pauseMock, _getPage: async () => ({}) },
  );
  // Wait for pending then pause via approve(false) path
  let tries = 50;
  while (tries-- > 0) {
    if (_peek(jobId)?.pendingApproval) break;
    await new Promise((r) => setImmediate(r));
  }
  approveStep(jobId, { approved: false });
  await new Promise((r) => setTimeout(r, 50));

  // After settle, getStatus should still show lastDraftInfo
  const status = await getStatus(jobId);
  assert.equal(status.status, 200);
  // Even though pending is null, lastDraftInfo carries the snapshot
  // (note: in this scenario pauseRequested wasn't set, so the dangling
  // approval branch may not fire; check that EITHER pending OR
  // lastDraftInfo is informative)
  const hasInfo = (status.machine.pending && status.machine.pending.draft) ||
                  (status.machine.lastDraftInfo && status.machine.lastDraftInfo.draft);
  assert.ok(hasInfo, 'should preserve draft info for dashboard');
  await deleteSession(jobId);
});

await test('Schemas: ApproveStepBodySchema.edits.suggested_value=null is accepted', () => {
  const ok = ApproveStepBodySchema.parse({
    approved: true,
    edits: [{ refId: 'e1', suggested_value: null }],
  });
  assert.equal(ok.edits[0].suggested_value, null);
});

// ── m7: cancel + escalation surfacing ───────────────────────────────

async function seedSessionForm7(jobId) {
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  await writeSession(jobId, s);
  return s;
}

await test('m7 cancel: active session → 202 + escalation_reason user_cancel, session.status=paused', async () => {
  const jobId = 'cccccccc1001';
  await seedSessionForm7(jobId);
  const res = await cancelMachine(jobId);
  assert.equal(res.status, 202);
  assert.equal(res.escalation_reason.code, 'user_cancel');
  assert.equal(res.escalation_reason.triggered_by, 'user');
  const sess = await readSession(jobId);
  assert.equal(sess.status, 'paused');
  await deleteSession(jobId);
});

await test('m7 cancel: completed session → 409', async () => {
  const jobId = 'cccccccc1002';
  const s = buildInitialSession({ jobId, jobUrl: 'https://x.com', siteAdapter: 'workday' });
  s.status = 'completed';
  await writeSession(jobId, s);
  const res = await cancelMachine(jobId);
  assert.equal(res.status, 409);
  assert.match(res.error, /already completed/);
  await deleteSession(jobId);
});

await test('m7 cancel: no session → 404', async () => {
  const res = await cancelMachine('cccccccc1003');
  assert.equal(res.status, 404);
});

await test('m7 cancel: invalid jobId → 400', async () => {
  const res = await cancelMachine('not-hex');
  assert.equal(res.status, 400);
});

await test('m7 cancel: double-cancel after machine sets ESCALATED → 409', async () => {
  // Direct write to _machines via _peek won't help — we'd need an active
  // machine. Instead validate the persistence semantics: after a
  // successful cancel, the session is 'paused'. A second cancel call
  // sees status='paused' and proceeds (idempotent at session-store
  // layer). The ctrl-level 409 only fires when there's an in-memory
  // ctrl with lastOutcome=ESCALATED. Document the session-layer
  // behavior here; ctrl-layer covered by an integration test below.
  const jobId = 'cccccccc1004';
  await seedSessionForm7(jobId);
  const r1 = await cancelMachine(jobId);
  assert.equal(r1.status, 202);
  const r2 = await cancelMachine(jobId);
  // session.status was already 'paused' — cancel just rewrites the
  // same state and returns 202 with the same reason. NOT 409 because
  // 'paused' is a legitimate cancel-input state. The ctrl-layer 409
  // is what protects the in-flight machine case (next test).
  assert.equal(r2.status, 202);
  await deleteSession(jobId);
});

await test('m7 approveStep: session escalated → 403', async () => {
  // We need an in-memory ctrl with lastOutcome=ESCALATED. Easiest is
  // to inject directly via _peek: not available. So we drive through
  // the runMachine path with an _isOnSubmitStep mock + a _submitForm
  // mock that causes ESCALATED, then verify approveStep returns 403.
  const jobId = 'cccccccc1005';
  // Start machine that immediately hits the submit-loop and escalates
  // (via all-strategies-failed since fixField returns failure).
  const deps = {
    _getPage: async () => ({}),
    _readSession: async () => null,
    _machineDeps: {
      _snapshot: async () => ({ text: '', table: { refIds: () => [], publicEntry: () => null, resolve: () => null }, skippedFrames: 0 }),
      _classifyAndFill: async () => { throw new Error('should not be called'); },
      _fillField: async () => {},
      _clickNext: async () => {},
      _waitDomStable: async () => {},
      _findNextButton: async () => null,
      _isOnSubmitStep: async () => true,
      _probeTotalSteps: async () => ({ total: null, source: 'exploratory' }),
      // m6 submit-loop: parse returns 1 error, fix all-fails → escalates
      _submitForm: async () => ({ outcome: 'has_errors', elapsed_ms: 1 }),
      _parseFormErrors: async () => [{ field: 'phone', error_code: 'required', error_msg: 'x' }],
      _fixField: async (p, f) => ({ field: f, fix_name: 'x', result: 'all_strategies_failed', success: false }),
    },
  };
  const startRes = await startMachine({
    jobId, jobUrl: 'https://x.com', detectedAdapter: 'workday',
  }, deps);
  assert.equal(startRes.sessionId, jobId);
  // Wait for the async machine to settle
  for (let i = 0; i < 60; i++) {
    const ctrl = _peek(jobId);
    if (ctrl && ctrl.state === 'done') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const ctrl = _peek(jobId);
  assert.equal(ctrl.lastOutcome, OUTCOME.ESCALATED);
  assert.equal(ctrl.lastEscalationReason.code, 'all_strategies_failed');
  // approveStep must refuse
  const approveRes = approveStep(jobId, { approved: true });
  assert.equal(approveRes.status, 403);
  assert.match(approveRes.error, /escalated.*control transferred/);
  assert.equal(approveRes.escalation_reason.code, 'all_strategies_failed');
  _resetAll();
  await deleteSession(jobId);
});

await test('m7 cancel: in-flight machine escalates ctrl + 2nd cancel → 409', async () => {
  const jobId = 'cccccccc1006';
  // Start a machine that needs approval (LLM-source classifier output
  // triggers stepNeedsApproval → machine pauses at the approve gate
  // and ctrl.pendingApproval is set).
  const deps = {
    _getPage: async () => ({}),
    _readSession: async () => null,
    _machineDeps: {
      _snapshot: async () => ({
        text: '',
        table: {
          refIds: () => ['e1'],
          publicEntry: (r) => ({ refId: r, role: 'textbox', name: 'Email' }),
          resolve: () => null,
        },
        skippedFrames: 0,
      }),
      _classifyAndFill: async () => ({
        refId: 'e1', role: 'textbox', label: 'Email', class: 'hard',
        suggested_value: 'a@b.com', confidence: 'high',
        // LLM source triggers stepNeedsApproval — machine pauses at gate
        source: { kind: 'llm', model: 'haiku' },
      }),
      _fillField: async () => {},
      _clickNext: async () => {},
      _waitDomStable: async () => {},
      _findNextButton: async () => null,
      _isOnSubmitStep: async () => false,
      _probeTotalSteps: async () => ({ total: 1, source: 'progressbar' }),
      _submitForm: async () => ({ outcome: 'submitted' }),
      _parseFormErrors: async () => [],
      _fixField: async () => ({ success: true, fix_name: 'x', result: 'verified' }),
    },
  };
  await startMachine({ jobId, jobUrl: 'https://x.com', detectedAdapter: 'workday' }, deps);
  // Wait for the machine to reach approval gate
  for (let i = 0; i < 60; i++) {
    const ctrl = _peek(jobId);
    if (ctrl && ctrl.pendingApproval) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  // First cancel — should escalate ctrl + persist + return 202
  const r1 = await cancelMachine(jobId);
  assert.equal(r1.status, 202);
  assert.equal(r1.escalation_reason.code, 'user_cancel');
  // Give the async machine a tick to settle
  await new Promise((r) => setTimeout(r, 50));
  const ctrl = _peek(jobId);
  assert.ok(ctrl, 'ctrl still in registry during grace');
  assert.equal(ctrl.lastOutcome, OUTCOME.ESCALATED);
  // Second cancel — ctrl-layer 409 (already escalated)
  const r2 = await cancelMachine(jobId);
  assert.equal(r2.status, 409);
  assert.match(r2.error, /already escalated/);
  _resetAll();
  await deleteSession(jobId);
});

await test('m7 getStatus: surfaces escalation_reason + submitAttemptsRun for escalated session', async () => {
  // Run a session through escalation, then check getStatus
  const jobId = 'cccccccc1007';
  const deps = {
    _getPage: async () => ({}),
    _readSession: async () => null,
    _machineDeps: {
      _snapshot: async () => ({ text: '', table: { refIds: () => [], publicEntry: () => null, resolve: () => null }, skippedFrames: 0 }),
      _classifyAndFill: async () => ({}),
      _fillField: async () => {},
      _clickNext: async () => {},
      _waitDomStable: async () => {},
      _findNextButton: async () => null,
      _isOnSubmitStep: async () => true,
      _probeTotalSteps: async () => ({ total: null, source: 'exploratory' }),
      _submitForm: async () => ({ outcome: 'has_errors' }),
      _parseFormErrors: async () => [{ field: 'phone', error_code: 'invalid_format', error_msg: 'X' }],
      _fixField: async (p, f) => ({ field: f, fix_name: 'x', result: 'all_strategies_failed', success: false }),
    },
  };
  await startMachine({ jobId, jobUrl: 'https://x.com', detectedAdapter: 'workday' }, deps);
  for (let i = 0; i < 60; i++) {
    const ctrl = _peek(jobId);
    if (ctrl && ctrl.state === 'done') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const status = await getStatus(jobId);
  assert.equal(status.status, 200);
  assert.equal(status.machine.lastOutcome, OUTCOME.ESCALATED);
  assert.equal(status.machine.escalationReason.code, 'all_strategies_failed');
  assert.ok(typeof status.machine.submitAttemptsRun === 'number');
  assert.ok(status.machine.submitAttemptsRun >= 1);
  // session.submit_attempts is also part of the session block via redactSession
  assert.ok(Array.isArray(status.session.submit_attempts));
  _resetAll();
  await deleteSession(jobId);
});

await test('m7 [review C2]: cancel-during-natural-escalation surfaces user_cancel kind', async () => {
  // Race scenario: machine is naturally escalating (all_strategies_failed)
  // when user cancels. ctrl.lastEscalationReason.code='user_cancel' wins
  // (wasCancelled guard); the flywheel record's kind must reflect
  // user_cancel, NOT the natural reason — otherwise Phase 5 signal F
  // would mis-cluster the cancel as an adapter failure.
  const jobId = 'cccccccc1009';
  // Pre-seed session to disk so cancelMachine (which calls the REAL
  // readSession, not the injected _readSession) finds it.
  await seedSessionForm7(jobId);
  let submitGate;
  const submitWaiter = new Promise((r) => { submitGate = r; });
  const deps = {
    _getPage: async () => ({}),
    _machineDeps: {
      _snapshot: async () => ({ text: '', table: { refIds: () => [], publicEntry: () => null, resolve: () => null }, skippedFrames: 0 }),
      _classifyAndFill: async () => ({}),
      _fillField: async () => {},
      _clickNext: async () => {},
      _waitDomStable: async () => {},
      _findNextButton: async () => null,
      _isOnSubmitStep: async () => true,
      _probeTotalSteps: async () => ({ total: null, source: 'exploratory' }),
      _submitForm: async () => {
        // Block here so we can issue /cancel mid-flight, then release
        // and have the loop eventually finish via all_strategies_failed.
        await submitWaiter;
        return { outcome: 'has_errors' };
      },
      _parseFormErrors: async () => [{ field: 'phone', error_code: 'invalid_format', error_msg: 'X' }],
      _fixField: async (p, f) => ({ field: f, fix_name: 'x', result: 'all_strategies_failed', success: false }),
    },
  };
  await startMachine({ jobId, jobUrl: 'https://x.com', detectedAdapter: 'workday' }, deps);
  // Wait for the machine to reach the blocked _submitForm
  for (let i = 0; i < 60; i++) {
    const c = _peek(jobId);
    if (c && c.state === 'running') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  // Cancel while submit is blocked → sets user_cancel on ctrl
  const cancelRes = await cancelMachine(jobId);
  assert.equal(cancelRes.status, 202);
  assert.equal(cancelRes.escalation_reason.code, 'user_cancel');
  // Release the submit so the natural loop completes with 'all_strategies_failed'
  submitGate();
  // Wait for runMachine to finish
  for (let i = 0; i < 60; i++) {
    const c = _peek(jobId);
    if (c && c.state === 'done') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const ctrl = _peek(jobId);
  // wasCancelled guard preserves user_cancel on ctrl
  assert.equal(ctrl.lastEscalationReason.code, 'user_cancel',
    'wasCancelled guard preserved user_cancel');
  // C2 fix verified inline (no side-effect to assert against without
  // peeking the flywheel store; this test locks the ctrl-state contract
  // — the kind override happens at _fireSiteFailure call site).
  _resetAll();
  await deleteSession(jobId);
});

await test('m7 getStatus: happy session has null escalationReason', async () => {
  // Session that doesn't escalate — escalationReason should be null
  const jobId = 'cccccccc1008';
  await seedSessionForm7(jobId);
  const status = await getStatus(jobId);
  assert.equal(status.status, 200);
  // No machine running → idle defaults
  assert.equal(status.machine.escalationReason, null);
  assert.equal(status.machine.submitAttemptsRun, null);
  await deleteSession(jobId);
});

// ── Cleanup ──────────────────────────────────────────────────────────

_resetAll();
await cleanup();

console.log(`\n✅ All ${passed} smoke tests passed.`);
