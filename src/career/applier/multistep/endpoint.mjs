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
// 07-applier/06-site-adapters m3 wiring: per-ATS adapter activation
// pushes adapter.controls into 05's DETECTION_RULES and known_fields
// into 03-classifier for the duration of this apply. Token reverted in
// the finally block of the fire-and-forget runner so DETECTION_RULES
// returns to baseline whether the apply succeeds, errors, or is paused.
import { detectAdapter, getCompiledAdapter } from './siteAdapter.mjs';
import { activateAdapter } from '../siteAdapters/activate.mjs';
// 07-applier/self-iteration/02-data-flywheel m1 — capture hooks. The
// flywheel records two events at the multi-step endpoint boundary:
//   ① approve-step: when user edits a draft suggested_value, append a
//      field-edits record (m2 induction reads these for narrative style).
//   ② runMachine error path: append a site-failures record so m2 can
//      propose a new site-adapter YAML when a domain hits ≥5 failures.
// Stores are append-only JSONL; capture failures are best-effort
// (caught + logged; never break the apply).
import {
  recordFieldEdit,
  recordSiteFailure,
  editDistance,
  classifyError,
} from '../../feedback/stores.mjs';

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
    // Per-apply override of preferences.applier.auto_approve_when_safe.
    // Default off; HTTP layer reads preferences.yml and forwards.
    autoApproveWhenSafe: z.boolean().optional(),
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
  // Optional "auto-approve when safe" mode (preferences.applier.auto_approve_when_safe).
  // Passed via body.autoApproveWhenSafe by the HTTP layer (server.mjs reads
  // preferences.yml and forwards the flag) OR via deps for smoke tests.
  // Default off — every existing apply path is unaffected.
  const autoApproveWhenSafe =
    typeof body.autoApproveWhenSafe === 'boolean'
      ? body.autoApproveWhenSafe
      : !!deps.autoApproveWhenSafe;

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
    // 02-data-flywheel m1: stashed so the capture hooks (approveStep,
    // error path) can attribute records without re-reading the session
    // file. siteAdapter populated after detection further below; jobUrl
    // mirrored here for the runMachine error catch.
    siteAdapter: null,
    jobUrl,
    // Auto-approve telemetry: count + list of (stepIdx, refIds) that
    // were resolved without operator review. Surfaced on status response
    // for post-apply audit.
    autoApproveWhenSafe,
    autoApproveCount: 0,
    autoApproveLog: [],
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
    // Auto-approve when safe (preferences.applier.auto_approve_when_safe).
    // Strict gate — every field must satisfy ALL of:
    //   - confidence === 'high'
    //   - class !== 'manual'    (no CAPTCHA / rich text / shadow DOM)
    //   - !block_approve         (no 05-non-standard-controls C2 block)
    // Any failing field falls through to the normal human-approval path.
    // Audit log records which (stepIdx, refIds) were auto-approved so
    // post-apply review can spot drift.
    if (ctrl.autoApproveWhenSafe && isDraftSafeToAutoApprove(approvalReq.draft)) {
      const fields = (approvalReq.draft && approvalReq.draft.fields) || [];
      ctrl.autoApproveCount += 1;
      ctrl.autoApproveLog.push({
        stepIdx: approvalReq.stepIdx,
        isDependentRecheck: !!approvalReq.isDependentRecheck,
        refIds: fields.map((f) => f.refId),
        at: new Date().toISOString(),
      });
      // Cap log to last 50 entries — multi-step Workday can have many
      // safe approvals across 5+ steps; we don't need unbounded growth.
      if (ctrl.autoApproveLog.length > 50) {
        ctrl.autoApproveLog.splice(0, ctrl.autoApproveLog.length - 50);
      }
      return Promise.resolve({ approved: true, edits: [], _auto: true });
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

  /**
   * Strict safety gate — see comment in `approve` above. Exported (via
   * helper at end of file) so smoke tests can drive the logic without
   * spinning up a full machine.
   * @param {{fields?: Array<object>}} draft
   * @returns {boolean}
   */
  // (helper defined at module scope below to avoid closure capture in tests)

  const runMachineFn = deps._runMachine || realRunMachine;
  // m3 (06-site-adapters): detectAdapter now goes through the YAML-backed
  // facade. Caller-supplied siteAdapter still wins; otherwise the facade
  // maps the URL onto the legacy 'workday'|'icims'|'successfactors'|'generic'
  // enum (single-step ATS like greenhouse collapse to 'generic' for the
  // multi-step state machine). Activation uses the TRUE compiled adapter
  // (getCompiledAdapter(jobUrl)) so single-step ATS hints DO take effect
  // even though the machine treats them as 'generic'.
  const detectedAdapter = siteAdapter || detectAdapter(jobUrl);
  // 02-data-flywheel m1: stash the detected adapter id on the ctrl
  // so the runMachine error path's site-failure record knows which
  // adapter (and therefore which site-adapter YAML) to attribute to.
  ctrl.siteAdapter = detectedAdapter;
  /** @type {import('../siteAdapters/activate.mjs').DeactivationToken|null} */
  let activationToken = null;
  // REVIEW M2/H3 fix: rename the test-only bypass from `_skipAdapterActivation`
  // to `__SMOKE_skipAdapterActivation` so a future caller forwarding
  // request body fields into deps can't accidentally trigger it. The
  // underscore-prefixed convention pairs with `_runMachine` / `_getPage`
  // / `_machineDeps` for the machine layer; the double-underscore +
  // SMOKE prefix makes the intent unmistakable.
  if (!deps.__SMOKE_skipAdapterActivation) {
    try {
      const compiled = getCompiledAdapter(jobUrl);
      activationToken = activateAdapter(compiled);
    } catch (err) {
      // REVIEW L3 fix: don't swallow silently — surface to stderr so
      // a misconfigured YAML doesn't quietly disable per-ATS hints.
      // The apply can still proceed without activation.
      console.warn('startMachine: activateAdapter failed, proceeding without per-ATS hints:', err.message);
      activationToken = null;
    }
  }

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
      // REVIEW C1 (adv) fix CRITICAL: runMachine reports MOST internal
      // errors via `result.outcome === OUTCOME.ERROR` WITHOUT throwing
      // (max-steps, Next-click failed, persist failed, etc.). Without
      // this branch, the site-failure flywheel would record almost
      // nothing in production — the smoke only passed because the mock
      // literally throws.
      if (result.outcome === OUTCOME.ERROR) {
        _fireSiteFailure(jobId, ctrl, { message: result.error || 'unknown machine error' });
      }
    } catch (err) {
      ctrl.lastOutcome = OUTCOME.ERROR;
      ctrl.lastError = String(err?.message ?? err).slice(0, 300);
      ctrl.state = 'done';
      // REVIEW H1 (Plan) fix: drop the await — fire-and-forget so a
      // slow filesystem doesn't defer the finally cleanup (activation
      // token revert).
      _fireSiteFailure(jobId, ctrl, err);
    } finally {
      // m3 (06-site-adapters): deactivate adapter rules whether the
      // apply succeeded, errored, or paused. Failure to revert leaves
      // global DETECTION_RULES polluted for subsequent applies.
      // REVIEW H2 fix: log revert errors instead of silent swallow.
      // Double-revert is a real bug (caller forgot the contract or two
      // cleanup paths racing); we want it visible without crashing the
      // outer runner.
      if (activationToken) {
        try {
          activationToken.revert();
        } catch (err) {
          console.warn('startMachine: adapter revert failed:', err.message);
        }
        activationToken = null;
      }
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
  // 02-data-flywheel m1: capture user edits to the draft as field-edit
  // records. Best-effort fire-and-forget — recording failure must NEVER
  // block the approve flow. Skips records when distance=0 (user accepted
  // as-is) or when the refId can't be matched (defensive).
  const edits = Array.isArray(body.edits) ? body.edits : [];
  if (edits.length && pending.draftInfo?.draft?.fields) {
    const fieldMap = new Map(pending.draftInfo.draft.fields.map((f) => [f.refId, f]));
    for (const edit of edits) {
      if (!edit || !edit.refId) continue;
      const field = fieldMap.get(edit.refId);
      if (!field) continue;
      // REVIEW H2 (adv) fix: slice BEFORE computing distance so the
      // recorded suggested/user_final and the recorded edit_distance
      // agree. Pre-fix, two strings differing only past index 8000
      // would land in storage as equal but with edit_distance > 0,
      // confusing m2 induction.
      const suggested = String(field.suggested_value ?? '').slice(0, 8000);
      const userFinal = String(edit.suggested_value ?? '').slice(0, 8000);
      const dist = editDistance(suggested, userFinal);
      if (dist === 0) continue;
      recordFieldEdit({
        ts: new Date().toISOString(),
        jobId,
        field_id: edit.refId,
        field_label: String(field.label || '').slice(0, 400),
        suggested,
        user_final: userFinal,
        edit_distance: dist,
        confidence: field.confidence || 'medium',
        site: ctrl.siteAdapter || undefined,
      }).catch((err) => {
        console.warn('feedback: recordFieldEdit failed:', err.message);
      });
    }
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
        // Auto-approve audit — counts + per-step log of refIds resolved
        // without operator review. Empty + 0 when the feature is off.
        autoApprove: {
          enabled: !!ctrl.autoApproveWhenSafe,
          count: ctrl.autoApproveCount || 0,
          log: ctrl.autoApproveLog || [],
        },
      }
    : {
        state: 'idle',
        lastOutcome: null,
        lastError: null,
        pending: null,
        lastDraftInfo: null,
        autoApprove: { enabled: false, count: 0, log: [] },
      };

  return {
    status: 200,
    sessionId: jobId,
    session: redactSession(session),
    machine,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Strict safety gate for auto-approve mode. Returns true iff EVERY
 * field in the draft satisfies:
 *   - confidence === 'high'        (no LOW/MEDIUM/MANUAL ambiguity)
 *   - class !== 'manual'           (no CAPTCHA / rich text / shadow DOM)
 *   - !block_approve               (no 05-non-standard-controls C2 block)
 *
 * An empty draft (zero fields) is treated as safe — the machine emits
 * one approve() call per step needing review, and an empty list means
 * the step already passed `stepNeedsApproval` filtering (defensive).
 *
 * Exported for smoke testability — no closure capture so tests can
 * drive the gate without spinning up the full machine.
 *
 * @param {{fields?: Array<object>}|null|undefined} draft
 * @returns {boolean}
 */
export function isDraftSafeToAutoApprove(draft) {
  if (!draft || typeof draft !== 'object') return false;
  const fields = Array.isArray(draft.fields) ? draft.fields : [];
  for (const f of fields) {
    if (!f || typeof f !== 'object') return false;
    if (f.confidence !== 'high') return false;
    if (f.class === 'manual') return false;
    if (f.block_approve === true) return false;
  }
  return true;
}

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

// m3 (06-site-adapters): the inline `detectAdapterForUrl` substring
// fallback was removed in favor of the YAML-backed `detectAdapter` from
// siteAdapter.mjs (now a thin facade over siteAdapters/loader.mjs +
// detector.mjs). startMachine calls detectAdapter directly above.

// 02-data-flywheel m1: site-failure capture helper (extracted per
// REVIEW C1 + H1 + H4 + L5 so it's called from BOTH the runMachine
// throw-catch AND the result.outcome===ERROR branch, fire-and-forget).
function _fireSiteFailure(jobId, ctrl, err) {
  let domain = 'unknown';
  if (typeof ctrl.jobUrl === 'string' && ctrl.jobUrl) {
    try {
      const h = new URL(ctrl.jobUrl).hostname;
      if (h) domain = h;
    } catch {
      // REVIEW L5 fix: prefer 'unknown' over truncated raw URL — m2's
      // groupBy(domain) on a URL fragment is just noise.
      domain = 'unknown';
    }
  }
  recordSiteFailure({
    ts: new Date().toISOString(),
    jobId,
    domain: domain.slice(0, 253),
    site_adapter_id: ctrl.siteAdapter || 'generic',
    // REVIEW H4 fix: null when error preceded any approval rather than
    // defaulting to 0 (which m2 would mis-cluster as "step-0 failures").
    step_idx: ctrl.lastDraftInfo?.stepIdx ?? null,
    error_kind: classifyError(err),
    error_message: String(err?.message ?? err).slice(0, 400),
  }).catch((recErr) => {
    console.warn('feedback: recordSiteFailure failed:', recErr.message);
  });
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
