// Master-tick scan scheduler. Polls every 60s: reads portals.yml cadence
// (hot-reload), reads scan-cadence-state.json, fires startScan({types: due})
// for any source-type whose cadence elapsed.
//
// Design decisions (locked at planning):
//   - per-source-type cadence, single master tick (OQ-1, OQ-2)
//   - catch-up on FIRST tick after boot, 60s after app.listen (OQ-3)
//   - hot-reload cadence each tick, no restart needed (OQ-5)
//   - 60s tick interval (OQ-6)
//   - DISABLE_SCAN_SCHEDULER=1 gates bootstrap from server.mjs (OQ-4)
//   - NEVER throws on tick: per-step errors warn + continue
//   - Mutex-aware: scan running OR enrich running → skip tick (no queueing —
//     re-evaluated next tick because cadence-state.last_run_at is unchanged)
//   - Errored types DON'T auto-retry until next full cadence period (m1's
//     recordCadenceError sets last_run_at, so isDue returns false)
//   - unref()'d interval handle: pending tick never blocks process exit
//
// Tests: smoke-scheduler.mjs uses the DI seam (_readPortals / _readCadenceState
// / _startScan / _isPipelineBusy / _now) so it doesn't spin a real interval
// or hit the live server.

import { readPortalsConfig } from './portalsLoader.mjs';
import { readCadenceState, cadenceToMs, isDue } from './cadenceState.mjs';
import { startScan, isPipelineBusy, ScanAlreadyRunningError } from './scanRunner.mjs';

const DEFAULT_TICK_MS = 60_000;

// Module-level state for the active scheduler. One scheduler per process —
// startScheduler is idempotent: a second call while an interval is active
// returns the controls bound to the ORIGINAL deps (not the second caller's),
// so the returned `tick` and the live setInterval execute against the same
// dep graph. To swap deps, call stopScheduler() first.
let _intervalHandle = null;
let _activeTick = null;

const DEFAULT_DEPS = {
  readPortals: readPortalsConfig,
  readCadenceState,
  startScan,
  isPipelineBusy,
  now: () => Date.now(),
};

function mergeDeps(opts) {
  return {
    readPortals: opts._readPortals ?? DEFAULT_DEPS.readPortals,
    readCadenceState: opts._readCadenceState ?? DEFAULT_DEPS.readCadenceState,
    startScan: opts._startScan ?? DEFAULT_DEPS.startScan,
    isPipelineBusy: opts._isPipelineBusy ?? DEFAULT_DEPS.isPipelineBusy,
    now: opts._now ?? DEFAULT_DEPS.now,
  };
}

// One pass of the scheduler. Exported via the returned object so smokes can
// invoke directly without spinning the timer. NEVER throws.
async function tickOnce(deps) {
  let portals;
  try {
    portals = await deps.readPortals();
  } catch (e) {
    console.warn('[scheduler] readPortals failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'portals-read-failed' };
  }

  const cadenceMap = cadenceToMs(portals?.scan_cadence ?? {});
  if (Object.keys(cadenceMap).length === 0) {
    return { fired: false, reason: 'cadence-empty' };
  }

  const sources = Array.isArray(portals?.sources) ? portals.sources : [];
  const activeTypes = Array.from(new Set(sources.map((s) => s?.type).filter((t) => typeof t === 'string')));
  if (activeTypes.length === 0) {
    return { fired: false, reason: 'no-active-sources' };
  }

  let state;
  try {
    state = await deps.readCadenceState();
  } catch (e) {
    // cadenceState.readCadenceState shouldn't throw, but defend anyway.
    console.warn('[scheduler] readCadenceState failed, skipping tick:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'state-read-failed' };
  }

  const now = deps.now();
  const dueTypes = activeTypes.filter((t) => cadenceMap[t] != null && isDue(t, state, cadenceMap, now));
  if (dueTypes.length === 0) {
    return { fired: false, reason: 'none-due' };
  }

  if (deps.isPipelineBusy()) {
    // Don't queue — next tick re-evaluates. cadence-state's last_run_at is
    // still stale so dueTypes will be the same (or larger) next tick.
    return { fired: false, reason: 'pipeline-busy', dueTypes };
  }

  try {
    deps.startScan({ types: dueTypes });
    return { fired: true, dueTypes };
  } catch (e) {
    // Race window: isPipelineBusy() returned false but another caller
    // (POST /scan, /enrich) grabbed the lock between then and startScan.
    // pipelineMutex's internal check throws ScanAlreadyRunningError.
    if (e instanceof ScanAlreadyRunningError) {
      return { fired: false, reason: 'race-busy', dueTypes };
    }
    console.warn('[scheduler] startScan threw unexpectedly:', String(e?.message ?? e).slice(0, 200));
    return { fired: false, reason: 'start-scan-threw', dueTypes };
  }
}

// Boots the scheduler. Idempotent: a second call while an interval is
// active returns the EXISTING tick (bound to the original deps), so the
// returned controls and the running interval can never get out of sync.
// To swap deps, callers must `stop()` first. Returns { tick, stop } —
// `tick` is the bound single-pass for tests/manual triggers, `stop`
// clears the interval.
export function startScheduler(opts = {}) {
  const tickMs = (() => {
    if (opts.tickMs == null) return DEFAULT_TICK_MS;
    if (typeof opts.tickMs !== 'number' || opts.tickMs <= 0) {
      console.warn(
        `[scheduler] invalid tickMs ${JSON.stringify(opts.tickMs)}, using default ${DEFAULT_TICK_MS}ms`
      );
      return DEFAULT_TICK_MS;
    }
    return opts.tickMs;
  })();

  if (_intervalHandle) {
    // Already running — return controls bound to the ORIGINAL deps so the
    // returned tick and the live interval execute against the same dep
    // graph. Caller must stop() first to swap deps.
    return { tick: _activeTick, stop: stopScheduler };
  }

  const deps = mergeDeps(opts);
  // Bound to the deps the caller passed — important for the smoke's DI mocks.
  // NEVER throws; the inner await chain is itself wrapped in tickOnce.
  const tick = async () => tickOnce(deps);
  _activeTick = tick;

  _intervalHandle = setInterval(() => {
    // Detach the promise — setInterval doesn't await it, so any unhandled
    // rejection inside tickOnce would crash. tickOnce is designed to never
    // throw, but defend anyway.
    tick().catch((e) => {
      console.warn('[scheduler] tick promise rejected:', String(e?.message ?? e).slice(0, 200));
    });
  }, tickMs);
  // Don't block process exit on a pending tick (mirror playwrightPool fix).
  if (typeof _intervalHandle.unref === 'function') _intervalHandle.unref();

  return { tick, stop: stopScheduler };
}

// Idempotent. Safe to call from SIGTERM handler whether or not the scheduler
// was started.
export function stopScheduler() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _activeTick = null;
}

// Test helper: returns true if the module currently holds an active interval.
// Used by the smoke's stop() assertion to verify clearInterval landed.
export function _isSchedulerActiveForTesting() {
  return _intervalHandle !== null;
}
