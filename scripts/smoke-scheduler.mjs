#!/usr/bin/env node
// Smoke for scan scheduler. DI-driven — no real timer, no real http, no real
// adapters. Validates due-detection, mutex skip, race tolerance, and the
// stop() lifecycle.

import assert from 'node:assert/strict';
import {
  startScheduler,
  stopScheduler,
  _isSchedulerActiveForTesting,
} from '../src/career/finder/scheduler.mjs';
import { ScanAlreadyRunningError } from '../src/career/finder/scanRunner.mjs';

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

// Each test makes its own mock deps + invokes tick() directly via the
// returned controls — no real setInterval to coordinate.
function makeDeps(over = {}) {
  const calls = { startScan: [], readPortals: 0, readCadenceState: 0, isPipelineBusy: 0 };
  return {
    calls,
    deps: {
      _readPortals: async () => {
        calls.readPortals++;
        return over.portals ?? { sources: [], scan_cadence: {} };
      },
      _readCadenceState: async () => {
        calls.readCadenceState++;
        return over.state ?? {};
      },
      _startScan: (opts) => {
        calls.startScan.push(opts);
        if (over.startScanThrows) throw over.startScanThrows;
      },
      _isPipelineBusy: () => {
        calls.isPipelineBusy++;
        return over.busy === true;
      },
      _now: () => over.now ?? Date.now(),
      // Use a huge tickMs so the auto-interval never fires during the test
      // (we only call tick() directly).
      tickMs: 24 * 60 * 60 * 1000,
    },
  };
}

// ── 1. No portals + no cadence → no_op ────────────────────────────────
await test('1. empty portals + no cadence → no fired scan, reason=cadence-empty', async () => {
  const { deps, calls } = makeDeps({});
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'cadence-empty');
    assert.equal(calls.startScan.length, 0);
  } finally {
    sched.stop();
  }
});

// ── 2. cadence present but no sources of that type → no_op ────────────
await test('2. cadence has type but no portals.source uses it → reason=none-due', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'github-md', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h', 'github-md': '24h' },
    },
    state: { 'github-md': { last_run_at: new Date().toISOString() } }, // just ran
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    // greenhouse cadence configured but activeTypes only has github-md → filtered out
    // github-md just ran → not due
    assert.equal(r.reason, 'none-due');
    assert.equal(calls.startScan.length, 0);
  } finally {
    sched.stop();
  }
});

// ── 3. type never run + non-zero cadence → due → _startScan called ────
await test('3. type never run → due → startScan called with [type]', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'Anthropic', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    },
    state: {}, // never run
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, true);
    assert.deepEqual(r.dueTypes, ['greenhouse']);
    assert.equal(calls.startScan.length, 1);
    assert.deepEqual(calls.startScan[0], { types: ['greenhouse'] });
  } finally {
    sched.stop();
  }
});

// ── 4. type just-ran (< cadence) → not due ────────────────────────────
await test('4. type just-ran (10s ago, cadence=60min) → not due', async () => {
  const now = Date.now();
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '60m' },
    },
    state: { greenhouse: { last_run_at: new Date(now - 10_000).toISOString() } },
    now,
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'none-due');
    assert.equal(calls.startScan.length, 0);
  } finally {
    sched.stop();
  }
});

// ── 5. multiple types due → single startScan with the array ───────────
await test('5. multiple types due → startScan called once with array', async () => {
  const now = Date.now();
  const { deps, calls } = makeDeps({
    portals: {
      sources: [
        { type: 'greenhouse', name: 'A', config: {} },
        { type: 'ashby', name: 'B', config: {} },
        { type: 'lever', name: 'C', config: {} },
      ],
      scan_cadence: { greenhouse: '60m', ashby: '60m', lever: '60m' },
    },
    state: {
      greenhouse: { last_run_at: new Date(now - 70 * 60_000).toISOString() }, // past-due
      ashby: { last_run_at: new Date(now - 70 * 60_000).toISOString() },
      // lever never run → due
    },
    now,
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, true);
    assert.equal(calls.startScan.length, 1);
    assert.equal(calls.startScan[0].types.length, 3);
    // Order isn't guaranteed but content is
    assert.deepEqual(new Set(calls.startScan[0].types), new Set(['greenhouse', 'ashby', 'lever']));
  } finally {
    sched.stop();
  }
});

// ── 6. mutex busy → skip tick ─────────────────────────────────────────
await test('6. isPipelineBusy=true → no startScan, reason=pipeline-busy', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    },
    state: {},
    busy: true,
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'pipeline-busy');
    assert.deepEqual(r.dueTypes, ['greenhouse']);
    assert.equal(calls.startScan.length, 0);
  } finally {
    sched.stop();
  }
});

// ── 7. portals read throws → tick is no-op + warn ─────────────────────
await test('7. _readPortals throws → no_op, reason=portals-read-failed (no throw out)', async () => {
  const calls = { startScan: [] };
  const sched = startScheduler({
    _readPortals: async () => {
      throw new Error('synthetic portals failure');
    },
    _readCadenceState: async () => ({}),
    _startScan: (opts) => calls.startScan.push(opts),
    _isPipelineBusy: () => false,
    tickMs: 24 * 60 * 60 * 1000,
  });
  // silence the expected warn during this test
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'portals-read-failed');
    assert.equal(calls.startScan.length, 0);
  } finally {
    console.warn = origWarn;
    sched.stop();
  }
});

// ── 8. malformed cadence string → that type skipped, others proceed ───
await test('8. malformed cadence skipped via cadenceToMs warn; valid types proceed', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [
        { type: 'greenhouse', name: 'A', config: {} },
        { type: 'ashby', name: 'B', config: {} },
      ],
      scan_cadence: { greenhouse: 'nonsense', ashby: '72h' },
    },
    state: {}, // both never run
  });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const sched = startScheduler(deps);
    try {
      const r = await sched.tick();
      assert.equal(r.fired, true);
      // Only ashby should fire (greenhouse cadence was bad → cadenceToMs dropped it)
      assert.deepEqual(calls.startScan[0].types, ['ashby']);
    } finally {
      sched.stop();
    }
  } finally {
    console.warn = origWarn;
  }
});

// ── 9. stop() clears interval ─────────────────────────────────────────
await test('9. stop() clears interval (verify via _isSchedulerActiveForTesting)', () => {
  // Use real (huge) tickMs so the interval is registered.
  const sched = startScheduler({
    _readPortals: async () => ({ sources: [], scan_cadence: {} }),
    _readCadenceState: async () => ({}),
    _startScan: () => {},
    _isPipelineBusy: () => false,
    tickMs: 60 * 60 * 1000, // 1 hour, won't fire during test
  });
  assert.equal(_isSchedulerActiveForTesting(), true, 'scheduler should be active after start');
  sched.stop();
  assert.equal(_isSchedulerActiveForTesting(), false, 'scheduler should be inactive after stop');
});

// ── 9b. Idempotent re-start: second call returns ORIGINAL deps' tick ──
await test('9b. second startScheduler call returns ORIGINAL deps (review fix)', async () => {
  const calls1 = { startScan: 0 };
  const calls2 = { startScan: 0 };
  const sched1 = startScheduler({
    _readPortals: async () => ({
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    }),
    _readCadenceState: async () => ({}),
    _startScan: () => { calls1.startScan++; },
    _isPipelineBusy: () => false,
    tickMs: 60 * 60 * 1000,
  });
  // Second call WHILE first interval is still active — different deps.
  const sched2 = startScheduler({
    _readPortals: async () => ({
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    }),
    _readCadenceState: async () => ({}),
    _startScan: () => { calls2.startScan++; }, // DIFFERENT mock
    _isPipelineBusy: () => false,
    tickMs: 60 * 60 * 1000,
  });
  // The returned tick from sched2 must invoke calls1.startScan (NOT calls2)
  // because the running interval is bound to sched1's deps. Pre-fix this
  // would have invoked calls2.startScan, creating dep-graph drift.
  await sched2.tick();
  assert.equal(calls1.startScan, 1, 'sched2.tick should invoke sched1 deps (bound to interval)');
  assert.equal(calls2.startScan, 0, 'sched2 deps should be ignored — interval is from sched1');
  sched2.stop(); // also cleans up sched1's interval (single module-level handle)
});

// ── 9c. tickMs=0 falls back to default with warn ──────────────────────
await test('9c. tickMs=0 falls back to default + warns (review fix)', () => {
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const sched = startScheduler({
      _readPortals: async () => ({ sources: [], scan_cadence: {} }),
      _readCadenceState: async () => ({}),
      _startScan: () => {},
      _isPipelineBusy: () => false,
      tickMs: 0,
    });
    assert.ok(warned >= 1, 'expected console.warn for invalid tickMs=0');
    sched.stop();
  } finally {
    console.warn = origWarn;
  }
});

// ── 10. cadence type with no active source → filtered out ─────────────
await test('10. cadence has type X but no portals.source uses X → X not in dueTypes', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'A', config: {} }],
      scan_cadence: { greenhouse: '72h', 'unused-type': '24h' },
    },
    state: {},
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, true);
    assert.deepEqual(r.dueTypes, ['greenhouse']);
    // 'unused-type' should NOT appear because no source.type === 'unused-type'
  } finally {
    sched.stop();
  }
});

// ── 11. Race: isPipelineBusy=false but startScan throws ScanAlreadyRunning
await test('11. startScan throws ScanAlreadyRunningError → reason=race-busy, no propagate', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    },
    state: {},
    startScanThrows: new ScanAlreadyRunningError({ running: true }),
  });
  const sched = startScheduler(deps);
  try {
    const r = await sched.tick();
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'race-busy');
    assert.deepEqual(r.dueTypes, ['greenhouse']);
    // calls.startScan still records the attempt
    assert.equal(calls.startScan.length, 1);
  } finally {
    sched.stop();
  }
});

// ── 12. startScan throws non-ScanAlreadyRunningError → reason=start-scan-threw
await test('12. startScan throws unexpected error → caught, reason=start-scan-threw', async () => {
  const { deps, calls } = makeDeps({
    portals: {
      sources: [{ type: 'greenhouse', name: 'X', config: {} }],
      scan_cadence: { greenhouse: '72h' },
    },
    state: {},
    startScanThrows: new TypeError('synthetic unexpected error'),
  });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const sched = startScheduler(deps);
    try {
      const r = await sched.tick();
      assert.equal(r.fired, false);
      assert.equal(r.reason, 'start-scan-threw');
    } finally {
      sched.stop();
    }
  } finally {
    console.warn = origWarn;
  }
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
