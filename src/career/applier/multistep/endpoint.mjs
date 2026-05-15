// HTTP endpoint orchestrator for Mode 2 multi-step state machine.
//
// 07-applier/04-multi-step-state-machine m4.
//
// Wraps m3's runMachine with a pending-Promise approve resolver:
//   - POST /multi-step/start kicks runMachine in the background
//   - When runMachine calls approve(...), the endpoint stashes a
//     pending promise on a per-jobId controller record
//   - POST /multi-step/:jobId/approve-step resolves that promise
//   - GET  /multi-step/:jobId/status returns session state + pending draft
//   - POST /multi-step/:jobId/pause resolves the pending approval with
//     { approved: false } so the machine bails cleanly to paused
//   - POST /multi-step/:jobId/resume reads the session, validates not
//     abandoned (>24h), spawns a new runMachine from the saved state
//
// Production wiring uses runtime/browser.mjs getPage() — m4 does NOT
// own the browser lifecycle (that's 02-playwright-runtime). Smoke
// injects _runMachine + _getPage for pure-Node tests.

import { z } from 'zod';
import {
  readSession,
  JOB_ID_RE,
  SITE_ADAPTERS,
  ABANDON_AFTER_MS,
} from './applySessionsStore.mjs';
import { runMachine as realRunMachine, OUTCOME } from './machine.mjs';
// 07-applier/05-non-standard-controls m4 wiring: machine.mjs's
// PROVISIONAL defaultFillField is REPLACED by nonstandardFillField in
// production. Smoke tests can still pass `_fillField` in
// deps._machineDeps to override (the merge below preserves that).
// Importing this module also registers all m1-m4 strategies +
// detection rules into the controlRouter as a side effect — this is
// the single canonical entry point the application server uses.
import { nonstandardFillField } from '../nonstandard/nonstandardFillField.mjs';
import '../nonstandard/strategies/datePickers.mjs';
import '../nonstandard/strategies/addressControls.mjs';
import '../nonstandard/strategies/selectionControls.mjs';
import '../nonstandard/strategies/specialControls.mjs';

// ── In-memory controller registry ───────────────────────────────────
//
// One controller per active jobId. Holds:
//   - pendingApproval: { resolve, reject, draftInfo } | null
//   - state: 'starting' | 'awaiting-approval' | 'running' | 'done'
//   - lastOutcome: OUTCOME.* | null (set when runMachine resolves)
//   - lastError: string | null
//
// Cleared when runMachine settles.

/** @type {Map<string, object>} */
const _machines = new Map();

// ── Body schemas ────────────────────────────────────────────────────

export const StartBodySchema = z
  .object({
    jobId: z.string().regex(JOB_ID_RE, 'jobId must match 12-hex'),
    jobUrl: z.string().url(),
    siteAdapter: z.enum(SITE_ADAPTERS).optional(),
    resumeId: z.string().min(1).max(64).optional(),
    jdSummary: z.string().max(20000).optional(),
    narrativeVoice: z.string().max(20000).optional(),
    maxSteps: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const ApproveStepBodySchema = z
  .object({
    approved: z.boolean(),
    edits: z
      .array(
        z.object({
          refId: z.string().min(1).max(64),
          suggested_value: z.string().max(8000).nullable(),
        }).strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

export const ResumeBodySchema = z
  .object({
    jobId: z.string().regex(JOB_ID_RE, 'jobId must match 12-hex'),
  })
  .strict();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Spawn a new multi-step machine in the background. Returns immediately;
 * the machine progresses async and pauses at each approval step.
 *
 * @param {object} body — already-parsed StartBodySchema output
 * @param {object} [deps]
 * @param {Function} [deps._runMachine] — defaults to m3's runMachine
 * @param {Function} [deps._getPage] — () => Promise<Page>; defaults
 *   to runtime/browser.mjs getPage (m4 doesn't own browser lifecycle)
 * @param {object} [deps._machineDeps] — passed through to runMachine's
 *   deps slot (for injecting _snapshot / _fillField / etc in smoke)
 * @returns {Promise<{ sessionId: string, started_at: string } | { error, status }>}
 */
export async function startMachine(body, deps = {}) {
  const { jobId, jobUrl, siteAdapter, resumeId, jdSummary, narrativeVoice, maxSteps } = body;

  // M4 fix from review: if a prior machine has settled (state='done')
  // but is lingering in the 30s grace window, allow restart by sweeping
  // it. Otherwise an immediate retry after error confusingly returns 409.
  const existing = _machines.get(jobId);
  if (existing && existing.state !== 'done') {
    return { status: 409, error: `machine already running for jobId ${jobId}` };
  }
  if (existing) _machines.delete(jobId);

  // H1 fix from review: reserve the slot SYNCHRONOUSLY before any await
  // so two concurrent startMachine calls for the same jobId can't both
  // pass the duplicate check. If getPage then fails, release the slot.
  const ctrl = {
    state: 'starting',
    pendingApproval: null,
    lastOutcome: null,
    lastError: null,
    lastDraftInfo: null, // H2: preserved snapshot of last draft when machine settles
    pauseRequested: false, // L5: flag for pause-before-first-approve
    started_at: new Date().toISOString(),
  };
  _machines.set(jobId, ctrl);

  // Acquire page (production via getPage; smoke injects mock)
  let page;
  try {
    page = await (deps._getPage ? deps._getPage() : defaultGetPage());
  } catch (err) {
    _machines.delete(jobId); // release reserved slot
    return { status: 503, error: `getPage failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }

  const approve = (approvalReq) => {
    // L5 fix from review: if pause was requested before any approval
    // gate was reached, auto-decline this approval so the machine bails
    // cleanly. Without this, pauseMachine on a freshly-started machine
    // would silently no-op.
    if (ctrl.pauseRequested) {
      ctrl.pauseRequested = false;
      return Promise.resolve({ approved: false });
    }
    return new Promise((resolve) => {
      ctrl.pendingApproval = {
        resolve,
        draftInfo: {
          stepIdx: approvalReq.stepIdx,
          totalSteps: approvalReq.totalSteps,
          isDependentRecheck: !!approvalReq.isDependentRecheck,
          draft: approvalReq.draft,
          requested_at: new Date().toISOString(),
        },
      };
      ctrl.state = 'awaiting-approval';
    });
  };

  const runMachineFn = deps._runMachine || realRunMachine;
  const detectedAdapter = siteAdapter || detectAdapterForUrl(jobUrl);

  // Fire-and-forget. Errors land in ctrl.lastError so getStatus reflects.
  (async () => {
    try {
      ctrl.state = 'running';
      // m4 (05-non-standard-controls): inject nonstandardFillField as
      // the default _fillField. Smoke tests pass their own
      // _machineDeps._fillField which wins via spread order.
      const machineDeps = {
        _fillField: nonstandardFillField,
        ...(deps._machineDeps || {}),
      };
      const result = await runMachineFn(
        {
          jobId,
          jobUrl,
          siteAdapter: detectedAdapter,
          resumeId,
          page,
          approve,
          classifierCtx: { jdSummary, narrativeVoice },
          maxSteps,
          createIfMissing: true,
        },
        machineDeps,
      );
      ctrl.lastOutcome = result.outcome;
      ctrl.lastError = result.error || null;
      ctrl.state = 'done';
    } catch (err) {
      ctrl.lastOutcome = OUTCOME.ERROR;
      ctrl.lastError = String(err?.message ?? err).slice(0, 300);
      ctrl.state = 'done';
    } finally {
      // Resolve any dangling approval so callers don't hang forever.
      // H2 fix from review: snapshot draftInfo to lastDraftInfo so
      // getStatus can still report "errored at step N" after settle.
      if (ctrl.pendingApproval) {
        ctrl.lastDraftInfo = ctrl.pendingApproval.draftInfo;
        try {
          ctrl.pendingApproval.resolve({ approved: false });
        } catch {}
        ctrl.pendingApproval = null;
      }
      // Keep ctrl in the map briefly so getStatus can report the
      // terminal outcome; clean up after a grace window so the next
      // start for the same jobId can proceed.
      setTimeout(() => {
        if (_machines.get(jobId) === ctrl) _machines.delete(jobId);
      }, 30_000).unref?.();
    }
  })();

  return { sessionId: jobId, started_at: ctrl.started_at };
}

/**
 * Resolve a pending approval. Returns 404 if no machine; 409 if no
 * pending approval (machine is busy filling / clicking Next).
 */
export function approveStep(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  const ctrl = _machines.get(jobId);
  if (!ctrl) {
    return { status: 404, error: `no machine running for jobId ${jobId}` };
  }
  const pending = ctrl.pendingApproval;
  if (!pending) {
    return { status: 409, error: 'no pending approval — machine is between steps' };
  }
  // H2: snapshot draftInfo so getStatus can show "errored/paused at step N"
  // after the controller's pending is cleared.
  ctrl.lastDraftInfo = pending.draftInfo;
  ctrl.pendingApproval = null;
  ctrl.state = 'running';
  pending.resolve({ approved: body.approved, edits: body.edits });
  return { status: 202, sessionId: jobId };
}

/**
 * Pause an in-flight machine. Resolves any pending approval with
 * { approved: false } so the machine bails cleanly to paused.
 */
export function pauseMachine(jobId) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  const ctrl = _machines.get(jobId);
  if (!ctrl) {
    return { status: 404, error: `no machine running for jobId ${jobId}` };
  }
  if (ctrl.pendingApproval) {
    ctrl.lastDraftInfo = ctrl.pendingApproval.draftInfo; // H2 snapshot
    ctrl.pendingApproval.resolve({ approved: false });
    ctrl.pendingApproval = null;
  } else {
    // L5 fix: pause-before-first-approve — set flag so the next approve
    // call (when the machine reaches an approval gate) immediately
    // auto-declines.
    ctrl.pauseRequested = true;
  }
  return { status: 202, sessionId: jobId };
}

/**
 * Resume a paused session. Reads from disk; rejects 410 on abandoned
 * (>24h idle). Spawns runMachine from saved current_step.
 */
export async function resumeMachine(body, deps = {}) {
  const { jobId } = body;
  if (_machines.has(jobId)) {
    return { status: 409, error: `machine already running for jobId ${jobId}` };
  }
  let session;
  try {
    session = await readSession(jobId);
  } catch (err) {
    return { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (!session) {
    return { status: 404, error: `no session found for jobId ${jobId}` };
  }
  if (session.status === 'abandoned') {
    return { status: 410, error: 'session abandoned (>24h idle); start a new machine' };
  }
  if (session.status === 'completed') {
    // M1 fix from review: completed is a terminal state — surface as
    // 409 so the route returns a non-202 status with a clear message
    // (was previously a silent 202 with undefined started_at).
    return { status: 409, error: 'session already completed; cannot resume' };
  }
  // Spawn from saved state — startMachine handles INIT, runMachine
  // reads the existing session and picks up from current_step.
  return startMachine(
    {
      jobId,
      jobUrl: session.job_url,
      siteAdapter: session.site_adapter,
      maxSteps: undefined,
    },
    deps,
  );
}

/**
 * Snapshot of session state + in-memory machine controller status.
 *
 * @returns {Promise<{
 *   status: number,
 *   sessionId?: string,
 *   session?: object,
 *   machine?: {state, lastOutcome, lastError, pending?},
 *   error?: string,
 * }>}
 */
export async function getStatus(jobId) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  let session;
  try {
    session = await readSession(jobId);
  } catch (err) {
    return { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (!session) {
    return { status: 404, error: `no session found for jobId ${jobId}` };
  }
  const ctrl = _machines.get(jobId);
  const machine = ctrl
    ? {
        state: ctrl.state,
        lastOutcome: ctrl.lastOutcome,
        lastError: ctrl.lastError,
        pending: ctrl.pendingApproval ? ctrl.pendingApproval.draftInfo : null,
        // H2: surface lastDraftInfo so dashboard can show "errored at step N"
        // after the machine has settled and pendingApproval was wiped.
        lastDraftInfo: ctrl.lastDraftInfo || null,
      }
    : { state: 'idle', lastOutcome: null, lastError: null, pending: null, lastDraftInfo: null };

  return {
    status: 200,
    sessionId: jobId,
    session: redactSession(session),
    machine,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function redactSession(session) {
  // Currently no PII redaction — session is already sanitized (no raw
  // Locators / backend ids). Future hook for masking sensitive values.
  return session;
}

// Lazy-imported default for production; smoke always injects _getPage
async function defaultGetPage() {
  const { getPage } = await import('../runtime/browser.mjs');
  return getPage();
}

function detectAdapterForUrl(jobUrl) {
  // Defer to siteAdapter — but lazy-import to avoid forcing siteAdapter
  // into the smoke's mock path when caller passes explicit siteAdapter.
  try {
    // Synchronous fall-back: simple substring match (URL.hostname has been
    // exhaustively tested in m2's siteAdapter, but importing it here
    // would force a synchronous-only path — caller can pass siteAdapter
    // explicitly to skip this.)
    const lower = String(jobUrl).toLowerCase();
    if (lower.includes('myworkdayjobs.com') || lower.includes('workdayjobs.com')) return 'workday';
    if (lower.includes('icims.com')) return 'icims';
    if (lower.includes('successfactors.com')) return 'successfactors';
  } catch {}
  return 'generic';
}

// ── Test hooks ──────────────────────────────────────────────────────

/**
 * Inspect the in-memory machine registry. For smoke + diagnostics.
 */
export function _peek(jobId) {
  return _machines.get(jobId) || null;
}

/**
 * Reset the in-memory registry. Smoke-only.
 */
export function _resetAll() {
  for (const ctrl of _machines.values()) {
    if (ctrl.pendingApproval) {
      try {
        ctrl.pendingApproval.resolve({ approved: false });
      } catch {}
    }
  }
  _machines.clear();
}

export { OUTCOME };
