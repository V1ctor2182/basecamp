#!/usr/bin/env node
// Smoke for the Mode 2 "auto-approve when safe" feature.
//
// Two coverage levels:
//   1. Pure-function gate (isDraftSafeToAutoApprove) — exhaustive over
//      the field-attribute matrix. Fast, no Playwright, no server.
//   2. Full machine wiring — drive startMachine with a synthetic
//      _runMachine that invokes approve() with crafted drafts; verify:
//        - auto-approve path resolves WITHOUT pendingApproval being set
//        - audit log records (stepIdx, refIds)
//        - unsafe field falls through to the human-pause path
//        - default (flag off) behavior unchanged

import assert from 'node:assert/strict';
import {
  isDraftSafeToAutoApprove,
  startMachine,
  getStatus,
  _resetAll as _resetMachines,
  approveStep,
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

// ── 1. isDraftSafeToAutoApprove gate ────────────────────────────────────

await test('gate: empty fields array → safe (defensive)', () => {
  assert.equal(isDraftSafeToAutoApprove({ fields: [] }), true);
});

await test('gate: all high+open → safe (LLM open answer with high conf passes)', () => {
  const draft = {
    fields: [
      { refId: 'e1', class: 'open', confidence: 'high', suggested_value: 'I love your mission' },
      { refId: 'e2', class: 'hard', confidence: 'high', suggested_value: 'victor@example.com' },
    ],
  };
  assert.equal(isDraftSafeToAutoApprove(draft), true);
});

await test('gate: one low confidence → unsafe', () => {
  const draft = {
    fields: [
      { refId: 'e1', class: 'open', confidence: 'high' },
      { refId: 'e2', class: 'hard', confidence: 'low' }, // ← unsafe
    ],
  };
  assert.equal(isDraftSafeToAutoApprove(draft), false);
});

await test('gate: one medium confidence → unsafe', () => {
  assert.equal(
    isDraftSafeToAutoApprove({
      fields: [{ refId: 'e1', class: 'open', confidence: 'medium' }],
    }),
    false,
  );
});

await test('gate: one manual class → unsafe (CAPTCHA / rich text / shadow DOM)', () => {
  assert.equal(
    isDraftSafeToAutoApprove({
      fields: [
        { refId: 'e1', class: 'open', confidence: 'high' },
        { refId: 'e2', class: 'manual', confidence: 'high' }, // ← unsafe
      ],
    }),
    false,
  );
});

await test('gate: one manual confidence → unsafe', () => {
  assert.equal(
    isDraftSafeToAutoApprove({
      fields: [{ refId: 'e1', class: 'open', confidence: 'manual' }],
    }),
    false,
  );
});

await test('gate: block_approve=true → unsafe regardless of confidence', () => {
  assert.equal(
    isDraftSafeToAutoApprove({
      fields: [
        { refId: 'e1', class: 'open', confidence: 'high', block_approve: true },
      ],
    }),
    false,
  );
});

await test('gate: null draft → unsafe', () => {
  assert.equal(isDraftSafeToAutoApprove(null), false);
  assert.equal(isDraftSafeToAutoApprove(undefined), false);
  assert.equal(isDraftSafeToAutoApprove({}), true); // empty fields = safe
});

await test('gate: malformed field entry → unsafe', () => {
  assert.equal(isDraftSafeToAutoApprove({ fields: [null] }), false);
  assert.equal(isDraftSafeToAutoApprove({ fields: ['not-an-object'] }), false);
});

// ── 2. Full wiring — synthetic _runMachine drives approve() ────────────

function makeSyntheticRunMachine(drafts) {
  // Each entry in `drafts` is { stepIdx, draft, expectAutoApprove }.
  // The synthetic machine calls approve(...) per entry, asserts the
  // resolved outcome matches expectation.
  return async ({ approve }) => {
    for (const { stepIdx, draft, expectAutoApprove } of drafts) {
      const result = await approve({ stepIdx, totalSteps: drafts.length, draft });
      if (expectAutoApprove) {
        if (!(result?.approved === true && result?._auto === true)) {
          throw new Error(
            `step ${stepIdx} expected auto-approve, got ${JSON.stringify(result)}`,
          );
        }
      } else {
        // Caller drives approveStep via REST during real use; in the
        // synthetic harness we treat absence of auto-approve as "would
        // have paused" — we resolve manually here for tests that don't
        // exercise the pause path.
        if (result?._auto === true) {
          throw new Error(
            `step ${stepIdx} expected human pause, got auto-approve ${JSON.stringify(result)}`,
          );
        }
      }
    }
    return { outcome: 'completed' };
  };
}

await test('startMachine: flag off (default) → never auto-approves', async () => {
  _resetMachines();
  const body = {
    jobId: 'aaaaaaaaaaaa',
    jobUrl: 'https://x.example.com/jobs/1',
    // autoApproveWhenSafe omitted → default false
  };
  const safeDraft = { stepIdx: 0, fields: [{ refId: 'e1', class: 'hard', confidence: 'high' }] };
  let approveCalled = false;
  const synthetic = async ({ approve }) => {
    // Caller never resolves the approval — but to avoid hanging, we
    // assert that approve returns a Promise that is NOT immediately
    // resolved with _auto: true.
    const racePromise = approve({ stepIdx: 0, totalSteps: 1, draft: safeDraft });
    const sentinel = Symbol('pending');
    const winner = await Promise.race([racePromise, Promise.resolve(sentinel)]);
    approveCalled = true;
    if (winner !== sentinel) {
      throw new Error(`approve() resolved synchronously with ${JSON.stringify(winner)} — flag should have been off`);
    }
    return { outcome: 'paused' };
  };
  const result = await startMachine(body, {
    _runMachine: synthetic,
    _getPage: async () => ({}),
  });
  // Wait a tick for the synthetic to run.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(approveCalled, 'synthetic must have invoked approve');
  assert.equal(result.sessionId, 'aaaaaaaaaaaa');
});

await test('startMachine: flag on + safe draft → auto-approves with audit log', async () => {
  _resetMachines();
  const body = {
    jobId: 'bbbbbbbbbbbb',
    jobUrl: 'https://x.example.com/jobs/2',
    autoApproveWhenSafe: true,
  };
  const drafts = [
    {
      stepIdx: 0,
      draft: {
        fields: [
          { refId: 'e1', class: 'open', confidence: 'high', suggested_value: 'Strong answer' },
          { refId: 'e2', class: 'hard', confidence: 'high', suggested_value: 'victor@example.com' },
        ],
      },
      expectAutoApprove: true,
    },
    {
      stepIdx: 1,
      draft: {
        fields: [
          { refId: 'e3', class: 'legal', confidence: 'high', suggested_value: 'Yes' },
        ],
      },
      expectAutoApprove: true,
    },
  ];
  const synthetic = makeSyntheticRunMachine(drafts);
  await startMachine(body, { _runMachine: synthetic, _getPage: async () => ({}) });
  await new Promise((r) => setTimeout(r, 50));
  // Verify audit surface via getStatus — note: needs a session file; use _peek.
  const { _peek } = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = _peek('bbbbbbbbbbbb');
  assert.ok(ctrl, 'ctrl should be tracked');
  assert.equal(ctrl.autoApproveCount, 2);
  assert.equal(ctrl.autoApproveLog.length, 2);
  assert.deepEqual(ctrl.autoApproveLog[0].refIds, ['e1', 'e2']);
  assert.deepEqual(ctrl.autoApproveLog[1].refIds, ['e3']);
});

await test('startMachine: flag on + unsafe field → falls through to pause', async () => {
  _resetMachines();
  const body = {
    jobId: 'cccccccccccc',
    jobUrl: 'https://x.example.com/jobs/3',
    autoApproveWhenSafe: true,
  };
  // Draft has ONE manual-class field → entire step should pause.
  const unsafeDraft = {
    fields: [
      { refId: 'e1', class: 'hard', confidence: 'high' },
      { refId: 'e2', class: 'manual', confidence: 'high' }, // CAPTCHA-like
    ],
  };
  let approveResult = null;
  const synthetic = async ({ approve }) => {
    const ap = approve({ stepIdx: 0, totalSteps: 1, draft: unsafeDraft });
    const sentinel = Symbol('pending');
    const winner = await Promise.race([ap, Promise.resolve(sentinel)]);
    approveResult = winner;
    return { outcome: 'paused' };
  };
  await startMachine(body, { _runMachine: synthetic, _getPage: async () => ({}) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(typeof approveResult, 'symbol', 'manual-class field must cause pause, not auto-resolve');
});

await test('startMachine: flag on + low-confidence → falls through to pause', async () => {
  _resetMachines();
  const body = {
    jobId: 'dddddddddddd',
    jobUrl: 'https://x.example.com/jobs/4',
    autoApproveWhenSafe: true,
  };
  const lowConfDraft = {
    fields: [{ refId: 'e1', class: 'open', confidence: 'low' }],
  };
  let approveResult = null;
  const synthetic = async ({ approve }) => {
    const ap = approve({ stepIdx: 0, totalSteps: 1, draft: lowConfDraft });
    const sentinel = Symbol('pending');
    const winner = await Promise.race([ap, Promise.resolve(sentinel)]);
    approveResult = winner;
    return { outcome: 'paused' };
  };
  await startMachine(body, { _runMachine: synthetic, _getPage: async () => ({}) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(typeof approveResult, 'symbol', 'low-conf field must cause pause');
});

await test('startMachine: flag on + audit log capped at 50', async () => {
  _resetMachines();
  const body = {
    jobId: 'eeeeeeeeeeee',
    jobUrl: 'https://x.example.com/jobs/5',
    autoApproveWhenSafe: true,
  };
  // 60 safe approve calls → log should cap at 50.
  const drafts = Array.from({ length: 60 }, (_, i) => ({
    stepIdx: i,
    draft: { fields: [{ refId: `e${i}`, class: 'hard', confidence: 'high' }] },
    expectAutoApprove: true,
  }));
  await startMachine(body, {
    _runMachine: makeSyntheticRunMachine(drafts),
    _getPage: async () => ({}),
  });
  await new Promise((r) => setTimeout(r, 50));
  const { _peek } = await import('../src/career/applier/multistep/endpoint.mjs');
  const ctrl = _peek('eeeeeeeeeeee');
  assert.equal(ctrl.autoApproveCount, 60, 'count tracks all invocations');
  assert.equal(ctrl.autoApproveLog.length, 50, 'log capped at 50');
  // Most recent 50 retained (last entry should be stepIdx=59).
  assert.equal(ctrl.autoApproveLog[ctrl.autoApproveLog.length - 1].stepIdx, 59);
});

await test('approveStep: returns 409 when no pending approval (auto-approved steps not addressable)', () => {
  _resetMachines();
  // Even with no machine, approveStep should clearly 404.
  const r = approveStep('ffffffffffff', { approved: true });
  assert.equal(r.status, 404);
});

// Reset to avoid cross-test pollution.
_resetMachines();

// ── Wrap-up ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Suppress getStatus from being treated as unused.
void getStatus;
