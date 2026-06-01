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

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  readSession,
  writeSession,        // m7: cancel persists session.status='paused'
  withSessionLock,     // m7: serialize cancel persist
  deleteSession,
  JOB_ID_RE,
  SITE_ADAPTERS,
  ABANDON_AFTER_MS,
  MAX_USER_HINTS,      // m11: cap on user_hints[] for SESSION_MAX_USER_HINTS error
} from './applySessionsStore.mjs';
// Field-classifier LLM context. The open-ended + file fillers need a
// client / pricing / identity injected via classifierCtx — without them
// every open question and the resume upload come back empty.
import { getClient } from '../../lib/anthropicClient.mjs';
import { computeCostUsd } from '../../lib/anthropicPricing.mjs';
import { loadIdentity } from '../classifier/identityLookup.mjs';
import { runMachine as realRunMachine, OUTCOME } from './machine.mjs';
// 07-applier/05-non-standard-controls m4 wiring: machine.mjs's
// PROVISIONAL defaultFillField is REPLACED by nonstandardFillField in
// production. Smoke tests can still pass `_fillField` in
// deps._machineDeps to override (the merge below preserves that).
// Importing this module also registers all m1-m4 strategies +
// detection rules into the controlRouter as a side effect — this is
// the single canonical entry point the application server uses.
import { nonstandardFillField } from '../nonstandard/nonstandardFillField.mjs';
// m12 (Phase 6 wiring): production injections for the submit-first loop.
// _submitForm/_parseFormErrors come straight from Phase 2/m5; _fixField
// is the adapter that bridges m6's flat shape onto Phase 2/m4's
// fillWithFallback ladder.
import {
  submitForm as _submitFormImplBase,
  parseFormErrors as _parseFormErrorsImplBase,
  detectSubmitSuccess as _detectSubmitSuccessImplBase,
} from '../runtime/submitFlow.mjs';
import { buildFixFieldAdapter, resolveFieldLocator } from './fixFieldAdapter.mjs';
// m13: live wiring for focusField/retryField endpoints — Phase 2/m6
// focusField against the active Playwright Page + Phase 2/m4
// fillWithFallback via the same adapter the submit loop uses.
import { focusField as _interactFocusField } from '../runtime/interact.mjs';
// m14: live wiring for attachFormObserver — broadcasts user form
// interaction events through the SSE hub so Apply.tsx's overlay
// state flips instantly when the operator types in the browser.
import { attachFormObserver } from '../runtime/observer.mjs';
import { broadcast as sseBroadcast } from './sseHub.mjs';
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
// The state machine assumes the page is already on the application form.
// startMachine drives the navigation up front via humanNavigate.
import { humanNavigate } from '../runtime/humanize.mjs';
// 07-applier/07-self-iteration/02-data-flywheel m1 — capture hooks. The
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

// m9: per-field action body schemas. `ref` is the DraftField.refId
// the operator clicked on; the server resolves it via the session.
export const FieldActionBodySchema = z
  .object({
    ref: z.string().min(1).max(64),
  })
  .strict();

// Retry takes an optional strategy name (one of the 5 ladder names
// from Phase 2/m4 DEFAULT_LADDER_NAMES). When omitted the server runs
// the full ladder. Free-form string because Phase 6 adapters may add
// new strategies — validation belongs in the runner, not here.
export const RetryFieldBodySchema = z
  .object({
    ref: z.string().min(1).max(64),
    strategy: z.string().max(64).optional(),
  })
  .strict();

// m11: Phase 4 recovery body schemas.
//
// Recovery 1 (resume compress) — no body fields beyond ref (the file
// field). Recovery 2 (alt formats) — ref + an opt picked from the
// ladder (server can also receive the whole ladder via `alternatives`).
// Recovery 3 (identify ATS) — operator chose from RECOVERY_ATSES.
// Recovery 4 (user hint) — ref + free-text hint.
export const RecoverResumeCompressBodySchema = z
  .object({ ref: z.string().min(1).max(64) })
  .strict();

export const RecoverAltFormatsBodySchema = z
  .object({
    ref: z.string().min(1).max(64),
    chosen: z.string().max(500).optional(),
    alternatives: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();

export const RecoverIdentifyAtsBodySchema = z
  .object({
    ats: z.enum(['greenhouse', 'lever', 'workday', 'icims', 'unknown', 'skip']),
  })
  .strict();

export const RecoverUserHintBodySchema = z
  .object({
    ref: z.string().min(1).max(64),
    hint: z.string().min(1).max(500),
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

  // freshStart (set by the /start route, NOT by resume): drop any prior
  // on-disk session so runMachine builds a clean one. Without this, a
  // previously completed/errored session short-circuits runMachine's
  // terminal-status guard and the apply can never be re-run.
  if (deps.freshStart) {
    await deleteSession(jobId).catch(() => {});
  }

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
    page = await (deps._getPage ? deps._getPage() : defaultGetPage(jobId));
  } catch (err) {
    _machines.delete(jobId); // release reserved slot
    return { status: 503, error: `getPage failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }

  // Navigate the page to the application form BEFORE runMachine. The state
  // machine assumes the page is already on the form — it never navigates
  // itself. Guarded on `typeof page.goto` so smoke mock pages (which only
  // implement getByRole/locator) skip navigation and run as before.
  if (page && typeof page.goto === 'function') {
    try {
      await humanNavigate(page, jobUrl, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      _machines.delete(jobId); // release reserved slot
      return {
        status: 502,
        error: `navigation to jobUrl failed: ${String(err?.message ?? err).slice(0, 200)}`,
      };
    }
    // [m14] Attach the form observer so operator interactions with the
    // live Chromium window flow through SSE to Apply.tsx. Best-effort:
    // if the form selector misses (lazy-loaded SPA, custom wrapper),
    // we warn and continue — the rest of the machine doesn't depend
    // on the observer. exposeBinding requires a real Playwright Page;
    // smoke pages without it are skipped via typeof guard.
    // [review H2] Wait up to 5s for the form to mount — humanNavigate
    // resolves on DCL but React/Vue mounts run AFTER DCL. Without this
    // wait, ~0% of Workday/Greenhouse sessions get the observer attached.
    if (typeof page.exposeBinding === 'function') {
      try {
        if (typeof page.waitForSelector === 'function') {
          await page.waitForSelector('form', { timeout: 5_000 }).catch(() => null);
        }
        ctrl.detachObserver = await attachFormObserver(page, 'form', (event) => {
          try {
            // Phase 2/m6 observer fires field_input + field_change.
            // Apply.tsx's cardActions.applySseEvent routes these onto
            // the verify_status overlay so card colors flip live.
            const eventName = event?.event_type === 'change'
              ? 'field_change'
              : 'field_input';
            sseBroadcast(jobId, eventName, {
              field_ref: event?.field_ref ?? null,
              value: event?.value ?? '',
              event_type: event?.event_type ?? 'input',
            });
          } catch { /* hub errors must never break the observer */ }
        });
      } catch (err) {
        console.warn(
          'startMachine: attachFormObserver failed — Apply.tsx live overlay will be poll-driven only:',
          String(err?.message ?? err).slice(0, 200),
        );
      }
    }
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
      // m12 (Phase 6 wiring): inject _submitForm + _parseFormErrors
      // (Phase 2/m5) + _fixField (Phase 2/m4 via buildFixFieldAdapter).
      //
      // [review C1] submitForm/parseFormErrors expect an adapter OBJECT
      // with `submit_button.name_hints` etc. — submitLoop passes
      // `siteAdapter` as a STRING enum (session.site_adapter). Without
      // adapting the shape, every per-ATS YAML hint silently misses.
      // We bind a `submitFlowAdapter` derived from the compiled adapter
      // and ignore submitLoop's second arg via closure.
      const compiledAdapter = (() => {
        try { return getCompiledAdapter(jobUrl); }
        catch { return null; }
      })();
      const submitFlowAdapter = compiledAdapter
        ? {
            submit_button: compiledAdapter.flow?.submit_button
              ? { name_hints: [...(compiledAdapter.flow.submit_button.name_hints || [])] }
              : undefined,
            // error_selectors / next_step_selectors land when the YAML
            // schema extends — defaults from submitFlow.mjs kick in
            // until then.
          }
        : {};
      const _submitFormImpl = (page) => _submitFormImplBase(page, submitFlowAdapter);
      const _parseFormErrorsImpl = (page) => _parseFormErrorsImplBase(page, submitFlowAdapter);
      // [m14] success-signal detector — submitLoop calls this after
      // submitForm reports 'submitted'. Result threads through
      // dispatchLoopOutcome → ctrl.lastSubmitDetectedBy → getStatus.
      const _detectSubmitSuccessImpl = (page) => _detectSubmitSuccessImplBase(page, submitFlowAdapter);
      // Per-fix session re-read: cheap JSON load, avoids closure
      // mutation hazards from runStep persisting between fix attempts.
      // [review H4] SnapshotError propagation: the adapter rethrows
      // hard snapshot codes so submitLoop's catch chain can route
      // them to a 'snapshot_stale' escalation instead of burning the
      // remaining attempts on the same dead element.
      const _fixFieldImpl = async (page, fieldRef, errorRecord) => {
        const fixSession = await readSession(jobId).catch(() => null);
        // [review M2] If readSession returned null, the session was
        // never persisted — surface a structured failure (no escalation,
        // submitLoop's same-error-twice will halt the loop).
        return buildFixFieldAdapter(fixSession)(page, fieldRef, errorRecord);
      };
      const machineDeps = {
        _fillField: nonstandardFillField,
        _submitForm: _submitFormImpl,
        _parseFormErrors: _parseFormErrorsImpl,
        _fixField: _fixFieldImpl,
        _detectSubmitSuccess: _detectSubmitSuccessImpl,
        ...(deps._machineDeps || {}),
      };
      // Build the field-classifier context. The open-ended (LLM) and
      // file fillers read client / computeCostUsd / recordCost / identity
      // / jobId / resumeId off this object. Missing client → every open
      // question + the resume upload silently return empty.
      const classifierCtx = { jdSummary, narrativeVoice, jobId, resumeId };
      try {
        classifierCtx.client = getClient();
        classifierCtx.computeCostUsd = computeCostUsd;
        classifierCtx.recordCost = appendLlmCost;
        classifierCtx.identity = await loadIdentity();
      } catch (err) {
        console.warn(
          'startMachine: classifier LLM context unavailable — open-ended fields will fall back to manual:',
          String(err?.message ?? err),
        );
      }
      const result = await runMachineFn(
        {
          jobId,
          jobUrl,
          siteAdapter: detectedAdapter,
          resumeId,
          page,
          approve,
          classifierCtx,
          maxSteps,
          createIfMissing: true,
        },
        machineDeps,
      );
      // m7: if cancelMachine already escalated this ctrl, runMachine's
      // PAUSED return must NOT overwrite that. The user's intent wins.
      const wasCancelled = ctrl.lastOutcome === OUTCOME.ESCALATED
        && ctrl.lastEscalationReason?.code === 'user_cancel';
      if (!wasCancelled) {
        ctrl.lastOutcome = result.outcome;
        // m7: surface submit-loop diagnostics from runMachine's return
        // (m6 attaches these on OUTCOME.ESCALATED + on timeout-mapped
        // OUTCOME.ERROR via dispatchLoopOutcome). Endpoint.getStatus
        // includes them in the machine block so the UI (Phase 3
        // Apply.tsx) can render the right escalation card.
        ctrl.lastEscalationReason = result.escalation_reason || null;
        ctrl.lastSubmitAttemptsRun = typeof result.submit_attempts_run === 'number'
          ? result.submit_attempts_run
          : null;
        // [m14] surface submit-success signal so m10's autoMarkDecision
        // can fire 'auto_redirect' (strong signal) instead of 'none'.
        // null preserves the "no detector wired" default.
        // [review M2] Warn when a non-null value is dropped to null so
        // future Phase 6 detector extensions don't silently lose data.
        const knownSubmitSignals = new Set([
          'url_pattern', 'thank_you_text', 'network_signal', 'user_fallback',
        ]);
        if (
          result.submit_detected_by != null
          && !knownSubmitSignals.has(result.submit_detected_by)
        ) {
          console.warn(
            `startMachine: dropping unknown submit_detected_by value "${result.submit_detected_by}" — ` +
              `add to the enum + update m10's autoMarkDecision STRONG_SUBMIT_SIGNALS if it should auto-redirect`,
          );
        }
        ctrl.lastSubmitDetectedBy = knownSubmitSignals.has(result.submit_detected_by)
          ? result.submit_detected_by
          : null;
      }
      ctrl.lastError = result.error || null;
      ctrl.state = 'done';
      // [m14] Detach the form observer — the machine has settled, no
      // more SSE broadcasts will come from this session. Best-effort
      // — the page may already be closed (browser SIGTERM during
      // shutdown).
      if (typeof ctrl.detachObserver === 'function') {
        try { await ctrl.detachObserver(); }
        catch { /* page closed — listener will GC */ }
        ctrl.detachObserver = null;
      }
      // REVIEW C1 (adv) fix CRITICAL: runMachine reports MOST internal
      // errors via `result.outcome === OUTCOME.ERROR` WITHOUT throwing
      // (max-steps, Next-click failed, persist failed, etc.). Without
      // this branch, the site-failure flywheel would record almost
      // nothing in production — the smoke only passed because the mock
      // literally throws.
      // m7 [review H3]: also fire on ESCALATED — flywheel signal F
      // (Phase 5/m5 submit-detection accuracy) needs the per-ATS
      // escalation rate to propose new adapter rules. error_kind is
      // prefixed so flywheel can bucket separately from generic errors.
      if (result.outcome === OUTCOME.ERROR) {
        _fireSiteFailure(jobId, ctrl, { message: result.error || 'unknown machine error' });
      } else if (result.outcome === OUTCOME.ESCALATED) {
        // m7 [review C2]: if the user cancelled mid-flight, prefer the
        // user-cancel reason over the natural-loop escalation reason.
        // Otherwise the flywheel would mis-bucket: an actual user-cancel
        // session would record as e.g. 'escalated_all_strategies_failed'
        // (the reason the natural loop ultimately reported), polluting
        // Phase 5 signal F's adapter-rule induction with phantom failures.
        const codeRaw = wasCancelled
          ? 'user_cancel'
          : (result.escalation_reason?.code || 'unknown');
        const detailRaw = wasCancelled
          ? (ctrl.lastEscalationReason?.detail || 'user cancelled')
          : (result.escalation_reason?.detail || 'submit-loop escalated');
        // Map code → flywheel error_kind enum. Unknown codes fall back
        // to 'escalated_unknown' so the Zod write doesn't reject silently.
        const KNOWN_CODES = new Set([
          'parse_failure', 'parse_failure_empty', 'all_strategies_failed',
          'same_error', 'max_submits', 'timeout', 'submit_failed',
          'unexpected_next_step', 'user_cancel', 'wait_loop_stuck', 'hard_cap',
        ]);
        const kind = `escalated_${KNOWN_CODES.has(codeRaw) ? codeRaw : 'unknown'}`;
        _fireSiteFailure(jobId, ctrl, { message: detailRaw, kind });
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
 * pending approval (machine is busy filling / clicking Next); 403 if
 * the session has escalated (m6 submit-first loop) — control is fully
 * transferred to the operator per P1-OQ7 + post-fill-handoff-ux §4.6,
 * no further auto-approval is accepted.
 */
export function approveStep(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  const ctrl = _machines.get(jobId);
  if (!ctrl) {
    return { status: 404, error: `no machine running for jobId ${jobId}` };
  }
  // m7 [review H3 / OQ7]: refuse approve on escalated sessions — the
  // m6 submit-loop already gave up; further machine work would violate
  // the "control to user" contract. Operator finishes in browser.
  if (ctrl.lastOutcome === OUTCOME.ESCALATED) {
    return {
      status: 403,
      error: 'session escalated; control transferred to user — finish in browser, then mark applied',
      escalation_reason: ctrl.lastEscalationReason || null,
    };
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
 * m7: user-driven escalation. Force the machine to give up — sets
 * `lastEscalationReason` to a user_cancel code, marks the in-memory
 * controller as escalated, persists session.status='paused' so the
 * operator can finish in the browser.
 *
 * Distinct from pauseMachine:
 *   - pauseMachine declines a pending approval, leaves session active
 *   - cancelMachine ESCALATES (no further approve allowed per OQ7)
 *
 * Idempotency:
 *   - already escalated → 409 (don't double-cancel)
 *   - session.status='completed' → 409 (terminal)
 *   - session.status='abandoned' → 410 (gone)
 *
 * @param {string} jobId
 * @returns {Promise<{ status, sessionId?, escalation_reason?, error? }>}
 */
export async function cancelMachine(jobId) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  // Read session first — cancel must work even when no in-memory ctrl
  // (e.g. user starts apply, server restarts, user wants to cancel).
  let session;
  try {
    session = await readSession(jobId);
  } catch (err) {
    return { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (!session) {
    return { status: 404, error: `no session found for jobId ${jobId}` };
  }
  if (session.status === 'completed') {
    return { status: 409, error: 'session already completed; cannot cancel' };
  }
  if (session.status === 'abandoned') {
    return { status: 410, error: 'session abandoned (>24h idle); cannot cancel' };
  }

  const ctrl = _machines.get(jobId);
  const escalationReason = {
    code: 'user_cancel',
    detail: 'operator cancelled via /cancel endpoint — control transferred to user',
    triggered_by: 'user',
  };

  if (ctrl) {
    // already-escalated guard — both for racing /cancel calls AND for
    // ESCALATED-from-submit-loop sessions (the loop already escalated,
    // user clicking cancel again is redundant).
    if (ctrl.lastOutcome === OUTCOME.ESCALATED) {
      return { status: 409, error: 'session already escalated; no further cancellation needed' };
    }
    // Mark the controller as escalated so subsequent approveStep / status
    // see the cancel state. The async machine loop may still be in flight;
    // by resolving any pending approval as declined we make it bail out
    // cleanly (runMachine's reconciliation will then map to OUTCOME.PAUSED
    // but we OVERRIDE that here since the operator's intent is escalate).
    ctrl.lastOutcome = OUTCOME.ESCALATED;
    ctrl.lastEscalationReason = escalationReason;
    if (ctrl.pendingApproval) {
      ctrl.lastDraftInfo = ctrl.pendingApproval.draftInfo;
      try {
        ctrl.pendingApproval.resolve({ approved: false });
      } catch {}
      ctrl.pendingApproval = null;
    } else {
      // No pending approval — set pauseRequested so the next approval
      // gate (if reached before the async loop notices) auto-declines.
      ctrl.pauseRequested = true;
    }
    // [review C1] Detach the m14 observer immediately on cancel. The
    // fire-and-forget closure also detaches on settle, but if runMachine
    // is wedged on a long Playwright wait, the closure won't reach its
    // detach for many seconds — meanwhile the observer keeps broadcasting
    // through the still-bound page. Idempotent: detachObserver internally
    // dedupes via WeakMap removal.
    if (typeof ctrl.detachObserver === 'function') {
      try { await ctrl.detachObserver(); }
      catch { /* page closed or never bound — fine */ }
      ctrl.detachObserver = null;
    }
  }

  // Persist session.status='paused' even without ctrl (cold-cancel path)
  if (session.status !== 'paused') {
    session.status = 'paused';
    try {
      await withSessionLock(jobId, async () => {
        await writeSession(jobId, session);
      });
    } catch (err) {
      // Best-effort persist; state is still in ctrl (if any) for the
      // remainder of this server process.
      return {
        status: 500,
        error: `cancel persist failed: ${String(err?.message ?? err).slice(0, 200)}`,
      };
    }
  }

  return {
    status: 202,
    sessionId: jobId,
    escalation_reason: escalationReason,
  };
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
        // m7: surface m6 submit-loop diagnostics. UI (Phase 3 Apply.tsx)
        // selects the escalation card template by reason.code; submit
        // attempts history powers the per-attempt timeline view.
        escalationReason: ctrl.lastEscalationReason || null,
        submitAttemptsRun: ctrl.lastSubmitAttemptsRun ?? null,
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
        escalationReason: null,
        submitAttemptsRun: null,
        autoApprove: { enabled: false, count: 0, log: [] },
      };

  return {
    status: 200,
    sessionId: jobId,
    session: redactSession(session),
    machine,
    // [m14] Top-level submitDetectedBy mirrors m10's StatusResp stub.
    // Apply.tsx autoMarkDecision reads s.submitDetectedBy directly.
    // null when no submit has happened yet OR no detector was wired.
    submitDetectedBy: ctrl?.lastSubmitDetectedBy ?? null,
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

// Lazy-imported default for production; smoke always injects _getPage.
// Tags the page with jobId so the "reveal browser" route can raise the
// right tab later. Used by startMachine — creates the page.
async function defaultGetPage(jobId) {
  const { getPage } = await import('../runtime/browser.mjs');
  return getPage(jobId);
}

// m13 (Phase 6 wiring): operator-driven endpoints (focus/retry) must
// look up the EXISTING jobId-tagged Page rather than create a new
// blank tab. defaultGetPage would 404 every click.
async function defaultAccessExistingPage(jobId) {
  const { accessExistingPage } = await import('../runtime/browser.mjs');
  return accessExistingPage(jobId);
}

// Cost-ledger appender passed to the open-ended filler as ctx.recordCost.
// Best-effort — a failed ledger write must never break an apply.
const LLM_COSTS_FILE = path.resolve('data', 'career', 'llm-costs.jsonl');
async function appendLlmCost(record) {
  try {
    await fs.appendFile(
      LLM_COSTS_FILE,
      JSON.stringify({ ts: new Date().toISOString(), caller: 'applier:classify', ...record }) + '\n',
    );
  } catch {
    // ledger write is best-effort
  }
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
  // m7: callers can override the auto-classified kind (e.g. ESCALATED
  // branch passes `escalated_<code>` so the flywheel buckets it
  // separately from network/parser errors).
  const error_kind = (err && typeof err === 'object' && typeof err.kind === 'string')
    ? err.kind
    : classifyError(err);
  recordSiteFailure({
    ts: new Date().toISOString(),
    jobId,
    domain: domain.slice(0, 253),
    site_adapter_id: ctrl.siteAdapter || 'generic',
    // REVIEW H4 fix: null when error preceded any approval rather than
    // defaulting to 0 (which m2 would mis-cluster as "step-0 failures").
    step_idx: ctrl.lastDraftInfo?.stepIdx ?? null,
    error_kind,
    error_message: String(err?.message ?? err).slice(0, 400),
  }).catch((recErr) => {
    console.warn('feedback: recordSiteFailure failed:', recErr.message);
  });
}

// ── Test hooks ──────────────────────────────────────────────────────

// ── m9: per-field actions (focus / retry / skip) ─────────────────────
//
// All three accept a refId from a DraftField. Resolution to a live
// Playwright Locator goes through the state machine's refTable, which
// is populated during the snapshot phase. focusField + retryField are
// CURRENTLY THIN — they validate the request and acknowledge, but the
// underlying live-runtime wiring (Phase 2/m6 focusField + Phase 2/m4
// fillWithFallback) is a future cross-Room glue milestone. skipField
// is fully wired: it persists session.per_step_draft[..].fields[i]
// with verify_status='skipped_by_user'.
//
// Same-origin guard is applied at the route layer (server.mjs), not
// here, mirroring /cancel.

/**
 * Find a field across all per-step drafts by refId. Returns the
 * (mutable) field reference plus its stepIdx — caller must writeSession
 * to persist. Null when not found.
 *
 * @param {object} session
 * @param {string} refId
 * @returns {{ field: object, stepIdx: number } | null}
 */
function _locateField(session, refId) {
  if (!session?.per_step_draft) return null;
  for (const [k, entry] of Object.entries(session.per_step_draft)) {
    const fields = entry?.fields;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      if (f && f.refId === refId) {
        return { field: f, stepIdx: entry.step_idx ?? Number(k) };
      }
    }
  }
  return null;
}

/**
 * m13 (Phase 6 wiring): focus a field in the live Chromium window.
 * Calls Phase 2/m6 focusField (scrollIntoView + outline + setFocus)
 * against the active Page. When no live page is available (machine
 * not running / paused / no session), returns 409 with a structured
 * reason rather than silently failing — the UI surfaces this to the
 * operator as "Open the Chromium window and click Resume".
 *
 * @param {string} jobId
 * @param {{ ref: string }} body
 * @param {{ _getPage?: Function, _focusField?: Function, _resolveLocator?: Function }} [deps]
 * @returns {Promise<{ status, sessionId?, ref?, label?, error? }>}
 */
export async function focusField(jobId, body, deps = {}) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  // [review C3] Block while the machine is actively mid-step — two
  // concurrent Playwright actions on the same Page race each other.
  // Operator can still focus during 'awaiting-approval' (which is
  // the typical cockpit state) or after machine has settled.
  const ctrl = _machines.get(jobId);
  if (ctrl && ctrl.state === 'running' && !ctrl.pendingApproval) {
    return {
      status: 409,
      error: `machine is mid-step for jobId ${jobId} — wait for the approval gate or pause`,
      reason: 'machine_busy',
    };
  }

  let session;
  try { session = await readSession(jobId); }
  catch (err) {
    return { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (!session) return { status: 404, error: `no session found for jobId ${jobId}` };

  // [review H2] Acquire live page BEFORE locating field so the operator
  // sees the right diagnosis when the browser closed (no_live_page
  // beats "ref not found in any step draft").
  const getPage = deps._getPage || defaultAccessExistingPage;
  let page;
  try {
    page = await getPage(jobId);
  } catch (err) {
    return {
      status: 409,
      error: `no live browser page for jobId ${jobId} — start or resume the machine first`,
      reason: 'no_live_page',
      detail: String(err?.message ?? err).slice(0, 200),
    };
  }
  if (!page) {
    return {
      status: 409,
      error: `no live browser page for jobId ${jobId}`,
      reason: 'no_live_page',
    };
  }

  const located = _locateField(session, body.ref);
  if (!located) return {
    status: 404,
    error: `ref ${body.ref} not found in any step draft`,
    reason: 'ref_not_in_draft',
  };

  // Resolve the locator via the shared waterfall. [review M3] Pass
  // null errorRecord — focusField has no error context.
  const resolveLocator = deps._resolveLocator || resolveFieldLocator;
  let locator;
  try {
    locator = await resolveLocator(page, body.ref, null);
  } catch (err) {
    return {
      status: 500,
      error: `resolveLocator threw: ${String(err?.message ?? err).slice(0, 200)}`,
      reason: 'resolve_threw',
    };
  }
  if (!locator) {
    return {
      status: 404,
      error: `field ref="${body.ref}" not found on the live page`,
      reason: 'field_not_on_page',
      stepIdx: located.stepIdx,
      label: located.field.label ?? null,
    };
  }

  // Call Phase 2/m6 focusField. Errors propagate as 500.
  const focusImpl = deps._focusField || _interactFocusField;
  try {
    await focusImpl(page, locator);
  } catch (err) {
    return {
      status: 500,
      error: `could not focus "${located.field.label ?? body.ref}" — ${String(err?.message ?? err).slice(0, 150)}`,
      reason: 'focus_threw',
    };
  }

  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    stepIdx: located.stepIdx,
    label: located.field.label ?? null,
  };
}

/**
 * m13 (Phase 6 wiring): retry filling a field via Phase 2/m4
 * fillWithFallback. Uses buildFixFieldAdapter so the strategy ladder,
 * expected-value lookup, and selector waterfall match the submit-first
 * loop's retry path exactly. Returns the structured fix result —
 * fix_name carries the winning strategy or 'all_strategies_failed'.
 *
 * @param {string} jobId
 * @param {{ ref: string, strategy?: string }} body
 * @param {{ _getPage?: Function, _runAdapter?: Function }} [deps]
 * @returns {Promise<{ status, sessionId?, ref?, fix_name?, result?, success?, error? }>}
 */
export async function retryField(jobId, body, deps = {}) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  // [review C3] Machine-busy guard.
  const ctrl = _machines.get(jobId);
  if (ctrl && ctrl.state === 'running' && !ctrl.pendingApproval) {
    return {
      status: 409,
      error: `machine is mid-step for jobId ${jobId} — wait for the approval gate or pause`,
      reason: 'machine_busy',
    };
  }

  let session;
  try { session = await readSession(jobId); }
  catch (err) {
    return { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  if (!session) return { status: 404, error: `no session found for jobId ${jobId}` };

  // [review H2] Live page first, then locate field.
  const getPage = deps._getPage || defaultAccessExistingPage;
  let page;
  try {
    page = await getPage(jobId);
  } catch (err) {
    return {
      status: 409,
      error: `no live browser page for jobId ${jobId} — start or resume the machine first`,
      reason: 'no_live_page',
      detail: String(err?.message ?? err).slice(0, 200),
    };
  }
  if (!page) {
    return {
      status: 409,
      error: `no live browser page for jobId ${jobId}`,
      reason: 'no_live_page',
    };
  }

  const located = _locateField(session, body.ref);
  if (!located) return {
    status: 404,
    error: `ref ${body.ref} not found in any step draft`,
    reason: 'ref_not_in_draft',
  };

  // [review H3] Refuse to silently overwrite a skip. Operator must
  // explicitly un-skip (a future m14 UI affordance) before retry.
  if (located.field.verify_status === 'skipped_by_user') {
    return {
      status: 409,
      error: `field "${located.field.label ?? body.ref}" is marked skipped — un-skip first if you want to retry`,
      reason: 'field_skipped',
      stepIdx: located.stepIdx,
      label: located.field.label ?? null,
    };
  }

  // [review H1] Re-read session right before the adapter runs — the
  // session at line above was loaded BEFORE getPage; runMachine may
  // have persisted field_memory updates in between (e.g. an in-flight
  // approveStep with operator edits). Fresh read keeps expected-value
  // lookup current.
  const freshSession = await readSession(jobId).catch(() => session);
  const runAdapter = deps._runAdapter || buildFixFieldAdapter(freshSession);
  let fixRes;
  try {
    fixRes = await runAdapter(page, body.ref, null);
  } catch (err) {
    // SnapshotError rethrows propagate here.
    return {
      status: 500,
      error: `fillWithFallback threw: ${String(err?.message ?? err).slice(0, 200)}`,
      reason: 'fillWithFallback_threw',
      code: err?.code ?? null,
    };
  }

  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    // [review M4] requested_strategy — clarifies "what the operator asked for"
    // vs `fix_name` which is "what actually ran". Until single-strategy
    // invocation lands, requested_strategy is informational only.
    requested_strategy: body.strategy ?? null,
    stepIdx: located.stepIdx,
    label: located.field.label ?? null,
    fix_name: fixRes.fix_name,
    result: fixRes.result,
    success: fixRes.success === true,
    last_value: fixRes.last_value ?? null,
  };
}

/**
 * Mark a field as skipped by the operator. Mutates session draft
 * and persists. Subsequent /status reads (and Apply.tsx polling)
 * pick up the new verify_status.
 *
 * @param {string} jobId
 * @param {{ ref: string }} body
 * @returns {Promise<{ status, sessionId?, ref?, prev_status?, error? }>}
 */
export async function skipField(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) {
    return { status: 400, error: 'invalid jobId' };
  }
  // [review C1] Read-modify-write must be inside the lock. The
  // outer state machine ALSO holds the same lock during step
  // transitions (machine.mjs); a concurrent unlocked read here would
  // operate on a stale snapshot and last-write-wins would clobber
  // the machine's mid-step persistence.
  let located = null;
  let prevStatus = null;
  let lockErr = null;
  try {
    await withSessionLock(jobId, async () => {
      let session;
      try { session = await readSession(jobId); }
      catch (err) {
        lockErr = { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
        return;
      }
      if (!session) {
        lockErr = { status: 404, error: `no session found for jobId ${jobId}` };
        return;
      }
      located = _locateField(session, body.ref);
      if (!located) {
        lockErr = {
          status: 404,
          error: `ref ${body.ref} not found in any step draft`,
          reason: 'ref_not_in_draft',
        };
        return;
      }
      prevStatus = located.field.verify_status ?? null;
      located.field.verify_status = 'skipped_by_user';
      await writeSession(jobId, session);
    });
  } catch (err) {
    return {
      status: 500,
      error: `skip persist failed: ${String(err?.message ?? err).slice(0, 200)}`,
    };
  }
  if (lockErr) return lockErr;

  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    stepIdx: located.stepIdx,
    prev_status: prevStatus,
    new_status: 'skipped_by_user',
  };
}

// ── m11: Phase 4 recovery handlers ────────────────────────────────────
//
// All four follow the same pattern as m9's skipField:
//   1. Read+modify+write session inside withSessionLock (atomic against
//      concurrent machine.mjs persistence).
//   2. Append to session.user_hints[] with the appropriate `kind`.
//   3. Recovery 1/2/3 mark `pending_wire: true` because the cross-Room
//      runtime glue (resume compress render endpoint / Phase 2/m4
//      value_alternatives / adapter swap+reload) is a future milestone.
//      Recovery 4 (user hint) is FULLY WIRED: parses the hint via the
//      shared recovery.mjs helper and records the parsed strategy +
//      result enum.

import { parseUserHint as _parseUserHint } from '../../apply/recovery.mjs';

async function _appendUserHint(jobId, hintEntry) {
  let appendErr = null;
  try {
    await withSessionLock(jobId, async () => {
      let session;
      try { session = await readSession(jobId); }
      catch (err) {
        appendErr = { status: 500, error: `readSession failed: ${String(err?.message ?? err).slice(0, 200)}` };
        return;
      }
      if (!session) {
        appendErr = { status: 404, error: `no session found for jobId ${jobId}` };
        return;
      }
      // [review M3] Immutable spread — avoids in-place mutation of
      // the parsed session array reference. Also matches the style of
      // appendSubmitAttempt's append pattern.
      const prior = Array.isArray(session.user_hints) ? session.user_hints : [];
      // [review L3] Surface cap-overflow with a coded error before
      // writeSession hits the Zod schema's array().max() and produces
      // a generic 500 — same pattern as appendSubmitAttempt.
      if (prior.length >= MAX_USER_HINTS) {
        const err = new Error(
          `user_hints cap reached (${MAX_USER_HINTS}); cannot record further hints — refresh the session.`,
        );
        err.code = 'SESSION_MAX_USER_HINTS';
        throw err;
      }
      session.user_hints = [...prior, hintEntry];
      await writeSession(jobId, session);
    });
  } catch (err) {
    return { status: 500, error: `persist failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
  return appendErr;
}

/**
 * Recovery 1 — Re-render resume at compressed quality + retry the
 * upload. Live wiring to 04-renderer/01-html-template m3
 * (?quality=low render) is a future cross-Room milestone. m11 records
 * the operator's request so the flywheel can bucket recovery attempts.
 */
export async function recoverResumeCompress(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) return { status: 400, error: 'invalid jobId' };
  const err = await _appendUserHint(jobId, {
    kind: 'resume_compress',
    field_ref: body.ref,
    hint: 're-render resume at compressed quality and retry',
    timestamp: new Date().toISOString(),
    attempted_strategy: null,
    result: 'pending_wire',
  });
  if (err) return err;
  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    queued: true,
    pending_wire: true,
    kind: 'resume_compress',
  };
}

/**
 * Recovery 2 — Try alternative formats. The retry queue / runtime
 * wiring needs Phase 2/m4 fillWithFallback to accept value_alternatives;
 * m11 records the operator's chosen ladder so the future glue can
 * walk it.
 */
export async function recoverAltFormats(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) return { status: 400, error: 'invalid jobId' };
  const hintText = body.chosen
    ? `chose: ${body.chosen}`
    : Array.isArray(body.alternatives)
      ? `ladder: ${body.alternatives.slice(0, 5).join(' | ')}`
      : 'alt formats (ladder TBD)';
  const err = await _appendUserHint(jobId, {
    kind: 'alt_format_choice',
    field_ref: body.ref,
    hint: hintText.slice(0, 500),
    timestamp: new Date().toISOString(),
    attempted_strategy: null,
    result: 'pending_wire',
  });
  if (err) return err;
  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    chosen: body.chosen ?? null,
    alternatives: body.alternatives ?? null,
    queued: true,
    pending_wire: true,
    kind: 'alt_format_choice',
  };
}

/**
 * Recovery 3 — Identify ATS. Records the operator's choice for future
 * adapter-swap glue (which needs site_adapter enum extension +
 * adapter loader cache invalidation). 'unknown' / 'skip' are stored
 * but don't intend a re-run.
 */
export async function recoverIdentifyAts(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) return { status: 400, error: 'invalid jobId' };
  const err = await _appendUserHint(jobId, {
    kind: 'ats_identification',
    field_ref: null,
    hint: `ats=${body.ats}`,
    timestamp: new Date().toISOString(),
    attempted_strategy: null,
    result: 'pending_wire',
  });
  if (err) return err;
  return {
    status: 202,
    sessionId: jobId,
    ats: body.ats,
    queued: true,
    pending_wire: true,
    kind: 'ats_identification',
  };
}

/**
 * Recovery 4 — Operator free-text hint. FULLY WIRED — parses via the
 * shared helper and records both the raw hint and the parsed strategy
 * + result enum. The actual strategy invocation against the live
 * Playwright Page is future Phase 6 glue; m11 ships the record path.
 */
export async function recoverUserHint(jobId, body) {
  if (!JOB_ID_RE.test(jobId)) return { status: 400, error: 'invalid jobId' };
  const parsed = _parseUserHint(body.hint);
  const err = await _appendUserHint(jobId, {
    kind: 'free_text',
    field_ref: body.ref,
    hint: body.hint,
    timestamp: new Date().toISOString(),
    attempted_strategy: parsed?.strategy ?? null,
    // If we parsed a strategy, the future glue will mark it
    // strategy_tried_ok/fail; for now we use recorded_only when there's
    // nothing to try, and pending_wire when parsing succeeded.
    result: parsed ? 'pending_wire' : 'recorded_only',
  });
  if (err) return err;
  return {
    status: 202,
    sessionId: jobId,
    ref: body.ref,
    parsed_strategy: parsed?.strategy ?? null,
    parse_confidence: parsed?.confidence ?? null,
    queued: true,
    pending_wire: parsed != null,
    kind: 'free_text',
    result: parsed ? 'pending_wire' : 'recorded_only',
  };
}

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
