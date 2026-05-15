// State machine for Mode 2 multi-step ATS application flow.
//
// 07-applier/04-multi-step-state-machine m3.
//
// Drives the per-step loop: SCAN_FIELDS → CLASSIFY_DRAFT → USER_APPROVE →
// FILL → DEPENDENT_FIELD_CHECK → NEXT_BUTTON_CLICK → WAIT_DOM_READY,
// then advances current_step until COMPLETE / paused / error.
//
// Locked design (planning OQs):
//   - Dependent fields detected via post-FILL re-snapshot DIFF (compare
//     (role, name, occurrenceIndex) tuples; refIds are minted per
//     snapshot so can't be compared by string)
//   - User approval = injected callback returning Promise<{approved, edits?}>
//   - field_memory hit short-circuits LLM AND approval — silent reuse
//     (per constraint #5 the SECOND approve fires only for genuinely
//     new dependent fields, not for memory-confirmed re-fills)
//   - Max iteration cap (default 20 steps) to prevent runaway
//   - All Page interactions are dependency-injected so the smoke runs
//     pure-Node (snapshot/classify/fill/click/wait/probe are all opts)
//   - writeSession lands behind withSessionLock from m1 — concurrent
//     m4 pause endpoint can't race the step transition

import {
  buildInitialSession,
  readSession,
  writeSession,
  withSessionLock,
} from './applySessionsStore.mjs';
import { snapshot as realSnapshot } from '../runtime/snapshot.mjs';
import { classifyAndFill } from '../classifier/index.mjs';
import {
  probeTotalSteps as realProbeTotalSteps,
  findNextButton as realFindNextButton,
  isOnSubmitStep as realIsOnSubmitStep,
} from './stepProbe.mjs';
import { applyMemoryHit, recordToMemory, normalizeLabel } from './fieldMemory.mjs';

/** State machine node ids — for telemetry and error diagnostics. */
export const STATE = Object.freeze({
  INIT: 'INIT',
  DETECT_FLOW: 'DETECT_FLOW',
  SCAN_FIELDS: 'SCAN_FIELDS',
  CLASSIFY_DRAFT: 'CLASSIFY_DRAFT',
  USER_APPROVE: 'USER_APPROVE',
  FILL: 'FILL',
  DEPENDENT_FIELD_CHECK: 'DEPENDENT_FIELD_CHECK',
  NEXT_BUTTON_CLICK: 'NEXT_BUTTON_CLICK',
  WAIT_DOM_READY: 'WAIT_DOM_READY',
  COMPLETE: 'COMPLETE',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
});

/** Terminal outcomes of runMachine. */
export const OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  PAUSED: 'paused',
  ERROR: 'error',
});

export const DEFAULT_MAX_STEPS = 20;
export const DEFAULT_WAIT_DOM_MS = 5000;

/**
 * Build a Set of (role, name, occurrenceIndex, frameIdx) tuples for the
 * entries in a RefTable. Used for dependent-field diff — refIds are
 * minted per snapshot so we compare by the underlying a11y tuple.
 *
 * @param {object} table — RefTable-shaped object with refIds() + publicEntry()
 * @returns {Set<string>}
 */
function tupleSetFromTable(table) {
  const out = new Set();
  for (const refId of table.refIds()) {
    const e = table.publicEntry(refId);
    if (!e) continue;
    out.add(`${e.role}\u0000${e.name}\u0000${e.occurrenceIndex || 0}\u0000${e.frameIdx || 0}`);
  }
  return out;
}

function entryTuple(e) {
  return `${e.role}\u0000${e.name}\u0000${e.occurrenceIndex || 0}\u0000${e.frameIdx || 0}`;
}

/**
 * Build a per-step draft fragment from a list of classifier outputs.
 * Shape matches m1's PerStepDraftSchema (relaxed for in-progress drafts).
 */
function buildStepDraftFragment(stepIdx, classifiedFields) {
  return {
    step_idx: stepIdx,
    fields: classifiedFields.map((f) => {
      const out = {
        label: String(f.label || '').slice(0, 400),
        class: f.class,
        suggested_value:
          f.suggested_value == null ? null : String(f.suggested_value).slice(0, 8000),
      };
      // Only include OPTIONAL fields when defined — Zod catchall in
      // m1's PerStepDraftFieldSchema rejects explicit undefined values.
      if (f.refId) out.refId = f.refId;
      if (f.confidence) out.confidence = f.confidence;
      if (typeof f.source_ref === 'string' && f.source_ref) {
        out.source_ref = f.source_ref.slice(0, 400);
      }
      if (f.subclass) out.subclass = f.subclass;
      // H7 fix from review: surface fill_error so m4/UI can show which
      // fields failed to fill (vs silently dropping them from telemetry).
      if (typeof f.fill_error === 'string' && f.fill_error) {
        out.fill_error = f.fill_error.slice(0, 400);
      }
      return out;
    }),
    captured_at: new Date().toISOString(),
  };
}

/**
 * Apply caller-supplied edits to a draft. `edits` is an array of
 * { refId, suggested_value } entries; null/undefined refId or value is
 * skipped. Mutates `draft.fields` in place.
 */
function applyEditsToDraft(draft, edits) {
  if (!Array.isArray(edits) || !edits.length) return;
  const byRef = new Map();
  for (const e of edits) {
    if (!e || !e.refId) continue;
    byRef.set(e.refId, e.suggested_value);
  }
  for (const f of draft.fields) {
    if (byRef.has(f.refId)) {
      const v = byRef.get(f.refId);
      // L4 fix from review: cap user input length at the schema bound
      const capped = v == null ? null : String(v).slice(0, 8000);
      f.suggested_value = capped;
      // M2 fix from review: user edits are accepted at face value but
      // marked source.user_edited so downstream eval-harness / Mode 1
      // promotion can distinguish "deterministic identity lookup" from
      // "user-corrected an LLM output". Keep confidence='high' since
      // user-provided values are trusted, but tag the origin.
      f.confidence = 'high';
      f.source = { ...(f.source || {}), user_edited: true };
    }
  }
}

/**
 * Internal: classify every entry in a table against classifier ctx,
 * applying field_memory hits before invoking the classifier. Returns
 * an array of classifier-shaped objects (one per refId).
 *
 * Pre-applies memory: if the entry's label resolves to a memory key
 * already in session.field_memory, we synthesize a field WITHOUT calling
 * classifyAndFill — saves time + cost AND saves USER_APPROVE since
 * confidence='high' field values from memory are taken at face value
 * (the user already approved this answer in a prior step).
 */
async function classifyEntries(entries, ctx, fieldMemory, classifierFn) {
  const out = [];
  for (const entry of entries) {
    // Memory pre-check via normalized label. Misses source.key-keyed hits
    // (those are caught post-classify by applyMemoryHit on line ~205);
    // pre-check is purely a perf optimization. Documented in H5.
    const memHit = lookupMemoryByLabel(fieldMemory, entry.name);
    if (memHit != null) {
      out.push({
        refId: entry.refId,
        label: entry.name,
        class: 'hard', // memory hits are always-treated-as-known
        subclass: 'memory-hit',
        suggested_value: memHit,
        confidence: 'high',
        source: { kind: 'memory', memory_key: normalizeLabel(entry.name), status: 'found' },
        source_ref: `memory:${normalizeLabel(entry.name)}`,
        cost_usd: 0,
        used: 'memory',
        _fromMemory: true,
      });
      continue;
    }
    // No memory hit → invoke classifier
    let classified;
    try {
      classified = await classifierFn(entry, ctx);
    } catch (err) {
      classified = {
        refId: entry.refId,
        label: entry.name,
        class: 'open',
        subclass: 'classify-error',
        suggested_value: null,
        confidence: 'manual',
        source: { kind: 'llm', status: 'error', error: String(err?.message ?? err).slice(0, 200) },
        source_ref: 'error:classify-failed',
        cost_usd: 0,
        used: 'error',
      };
    }
    // Post-classify memory hit using classifier's lookupKey (more reliable
    // than label-based lookup)
    applyMemoryHit(fieldMemory, classified);
    out.push(classified);
  }
  return out;
}

/** Label-based memory lookup without going through classifier. */
function lookupMemoryByLabel(memory, label) {
  if (!memory || !label) return null;
  const key = normalizeLabel(label);
  if (!key) return null;
  const v = memory[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Decide whether a memory-pre-applied or classifier-emitted field needs
 * USER_APPROVE. Memory hits + high-confidence identity fields skip
 * approve (silent reuse / deterministic lookup). Everything else
 * requires approval per constraint #1.
 *
 * Per the planning spec: approve fires PER STEP, not per field. But
 * if ALL fields in a step are memory hits, we can skip the prompt
 * entirely (return false → run without approve). The state machine
 * checks this and only invokes approve when any field needs review.
 */
function stepNeedsApproval(classifiedFields) {
  for (const f of classifiedFields) {
    if (f._fromMemory) continue;
    // Class=hard/legal with high confidence from deterministic lookup
    // is silent (identity.email is always identity.email).
    if (
      (f.class === 'hard' || f.class === 'legal') &&
      f.confidence === 'high' &&
      f.suggested_value &&
      !(f.source && f.source.kind === 'llm')
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Execute one step: snapshot → classify (or pick up pending) → (approve?)
 * → fill → re-snap diff → re-classify dependents → persist. Mutates
 * `session`. Caller is responsible for writeSession of the final state.
 *
 * @returns {Promise<{
 *   outcome: 'continue' | 'paused',  // M3 fix: explicit step outcome
 *   filled: number,
 *   skipped: number,
 *   errors: number,
 * }>}
 */
async function runStep(session, deps, ctx) {
  const {
    page,
    _snapshot,
    _classifyAndFill,
    _fillField,
    _waitDomStable,
    approve,
  } = deps;

  // M8 fix from review: wait for DOM stable BEFORE pre-snapshot (on
  // resume the page might be mid-render). Defensive; cheap.
  try {
    await _waitDomStable(page);
  } catch {
    // best-effort
  }

  // 1) Pre-snapshot
  const snapPre = await _snapshot(page);
  if (!snapPre || !snapPre.table) {
    throw new Error('runStep: snapshot returned no table');
  }
  const entriesPre = [];
  for (const refId of snapPre.table.refIds()) {
    const e = snapPre.table.publicEntry(refId);
    if (e) entriesPre.push(e);
  }

  const stepKey = String(session.current_step);

  if (!entriesPre.length) {
    // H8 fix from review: record skipped status + empty draft so resume
    // can distinguish "never visited" from "visited, no fields"
    session.per_step_status[stepKey] = 'skipped';
    session.per_step_draft[stepKey] = {
      step_idx: session.current_step,
      fields: [],
      captured_at: new Date().toISOString(),
    };
    return { outcome: 'continue', filled: 0, skipped: 0, errors: 0 };
  }

  // 2) Classify each entry (memory hits short-circuit). H1 fix from
  //    review: if a pending draft exists for this step (prior bail),
  //    apply its user-edited suggested_values onto the freshly-classified
  //    fields so we don't lose work. Reconciliation is by refId-or-label
  //    since refIds reset per snapshot.
  let classified = await classifyEntries(
    entriesPre,
    ctx.classifierCtx || {},
    session.field_memory,
    _classifyAndFill,
  );

  const pendingDraft = session.per_step_draft[stepKey];
  if (
    pendingDraft &&
    session.per_step_status[stepKey] === 'pending' &&
    Array.isArray(pendingDraft.fields) &&
    pendingDraft.fields.length
  ) {
    reconcileFromPendingDraft(classified, pendingDraft);
  }

  // 3) USER_APPROVE (only when at least one field needs review)
  if (stepNeedsApproval(classified)) {
    const draft = buildStepDraftFragment(session.current_step, classified);
    const approval = await approve({
      stepIdx: session.current_step,
      totalSteps: session.total_steps,
      draft,
    });
    if (!approval || !approval.approved) {
      session.per_step_draft[stepKey] = draft;
      session.per_step_status[stepKey] = 'pending';
      session.status = 'paused';
      return { outcome: 'paused', filled: 0, skipped: classified.length, errors: 0 };
    }
    applyEditsToDraft(draft, approval.edits);
    // Sync edits back into classified (used by FILL)
    const editedByRef = new Map(draft.fields.map((f) => [f.refId, f]));
    classified = classified.map((c) => {
      const edited = editedByRef.get(c.refId);
      if (!edited) return c;
      return {
        ...c,
        suggested_value: edited.suggested_value,
        confidence: edited.confidence,
        source: edited.source || c.source,
      };
    });
  }

  // 4) FILL each field. Per-field errors don't sink the step.
  let filled = 0;
  let errors = 0;
  for (const f of classified) {
    if (f.suggested_value == null || f.suggested_value === '') continue;
    try {
      await _fillField(page, f.refId, f, snapPre.table);
      recordToMemory(session.field_memory, f, f.suggested_value);
      filled++;
    } catch (err) {
      errors++;
      f.fill_error = String(err?.message ?? err).slice(0, 200);
    }
  }

  // 5) Dependent-field check: re-snapshot, diff tuples
  const snapPost = await _snapshot(page);
  let dependentsMerged = false;
  if (snapPost && snapPost.table) {
    const preSet = tupleSetFromTable(snapPre.table);
    const dependents = [];
    for (const refId of snapPost.table.refIds()) {
      const e = snapPost.table.publicEntry(refId);
      if (!e) continue;
      if (!preSet.has(entryTuple(e))) dependents.push(e);
    }
    if (dependents.length) {
      const depClassified = await classifyEntries(
        dependents,
        ctx.classifierCtx || {},
        session.field_memory,
        _classifyAndFill,
      );
      if (stepNeedsApproval(depClassified)) {
        const depDraft = buildStepDraftFragment(session.current_step, depClassified);
        const approval2 = await approve({
          stepIdx: session.current_step,
          totalSteps: session.total_steps,
          draft: depDraft,
          isDependentRecheck: true,
        });
        if (!approval2 || !approval2.approved) {
          // H2 fix from review: persist BASE + DEPENDENT fields together,
          // not just dependents — declining the second prompt shouldn't
          // erase the user's first-approve work from the persisted draft.
          mergeDependentIntoDraft(session, depDraft, classified);
          session.per_step_status[stepKey] = 'pending';
          session.status = 'paused';
          return {
            outcome: 'paused',
            filled,
            skipped: depClassified.length,
            errors,
          };
        }
        applyEditsToDraft(depDraft, approval2.edits);
        for (const f of depDraft.fields) {
          if (f.suggested_value == null || f.suggested_value === '') continue;
          try {
            await _fillField(page, f.refId, f, snapPost.table);
            recordToMemory(session.field_memory, f, f.suggested_value);
            filled++;
          } catch (err) {
            errors++;
            f.fill_error = String(err?.message ?? err).slice(0, 200);
          }
        }
        mergeDependentIntoDraft(session, depDraft, classified);
        dependentsMerged = true;
      }
    }
  }

  // 6) Persist step draft. Skip when mergeDependentIntoDraft already
  //    wrote the merged shape.
  if (!dependentsMerged) {
    session.per_step_draft[stepKey] = buildStepDraftFragment(session.current_step, classified);
  }
  // H7-adjacent: if any fills errored, surface via 'pending' status so
  // resume / UI can re-prompt the user; otherwise mark approved.
  session.per_step_status[stepKey] = errors > 0 ? 'pending' : 'approved';

  return { outcome: 'continue', filled, skipped: 0, errors };
}

/**
 * H1 fix from review: when resuming a step that had a pending draft,
 * apply prior user-edited values onto freshly-classified fields. Match
 * by refId first (works if snapshot order is stable across resume),
 * then by label fallback.
 */
function reconcileFromPendingDraft(classified, pendingDraft) {
  const byRefId = new Map();
  const byLabel = new Map();
  for (const f of pendingDraft.fields) {
    if (f.refId) byRefId.set(f.refId, f);
    if (f.label) byLabel.set(String(f.label).toLowerCase().trim(), f);
  }
  for (const c of classified) {
    const hit =
      (c.refId && byRefId.get(c.refId)) ||
      (c.label && byLabel.get(String(c.label).toLowerCase().trim()));
    if (!hit) continue;
    // Carry forward suggested_value + confidence + source.user_edited
    // tag if present. classifier-output IS still relevant for
    // source.key (for memory-key derivation), so we only override the
    // user-facing value + confidence fields.
    if (hit.suggested_value != null) c.suggested_value = hit.suggested_value;
    if (hit.confidence) c.confidence = hit.confidence;
    if (hit.source && hit.source.user_edited) {
      c.source = { ...(c.source || {}), user_edited: true };
    }
  }
}

/** Merge dependent draft fields into the step's accumulated per_step_draft. */
function mergeDependentIntoDraft(session, depDraft, baseClassified) {
  const key = String(session.current_step);
  const existing = session.per_step_draft[key];
  if (existing) {
    existing.fields.push(...depDraft.fields);
    existing.captured_at = new Date().toISOString();
  } else {
    session.per_step_draft[key] = {
      step_idx: session.current_step,
      fields: [
        ...(baseClassified ? buildStepDraftFragment(session.current_step, baseClassified).fields : []),
        ...depDraft.fields,
      ],
      captured_at: new Date().toISOString(),
    };
  }
}

/**
 * Run the multi-step machine for one job from current_step until
 * complete / paused / error. Caller must have a session already
 * persisted (or pass createIfMissing=true to bootstrap).
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {string} [args.jobUrl] — needed for INIT if no session exists
 * @param {string} [args.siteAdapter] — needed for INIT if no session exists
 * @param {object} args.page — Playwright Page (or smoke mock)
 * @param {(arg: {stepIdx, totalSteps, draft, isDependentRecheck?}) => Promise<{approved, edits?}>} args.approve
 * @param {object} [args.classifierCtx] — passed through to classifyAndFill
 * @param {number} [args.maxSteps=DEFAULT_MAX_STEPS]
 * @param {boolean} [args.createIfMissing=false]
 *
 * @param {object} [deps]
 * @param {Function} [deps._snapshot]
 * @param {Function} [deps._classifyAndFill]
 * @param {Function} [deps._fillField] — (page, refId, classifiedField, table) → Promise<void>
 * @param {Function} [deps._clickNext] — (page, locator) → Promise<void>
 * @param {Function} [deps._waitDomStable] — (page) → Promise<void>
 * @param {Function} [deps._probeTotalSteps]
 * @param {Function} [deps._findNextButton]
 * @param {Function} [deps._isOnSubmitStep]
 * @param {Function} [deps._readSession]
 * @param {Function} [deps._writeSession]
 *
 * @returns {Promise<{
 *   outcome: 'completed' | 'paused' | 'error',
 *   session: object,
 *   steps_run: number,
 *   error?: string,
 * }>}
 */
export async function runMachine(args, deps = {}) {
  const {
    jobId,
    jobUrl,
    siteAdapter,
    page,
    approve,
    classifierCtx,
    maxSteps = DEFAULT_MAX_STEPS,
    createIfMissing = false,
  } = args || {};

  if (!jobId) throw new Error('runMachine: jobId required');
  if (typeof approve !== 'function') {
    throw new Error('runMachine: approve callback required');
  }

  const resolved = {
    _snapshot: deps._snapshot || realSnapshot,
    _classifyAndFill: deps._classifyAndFill || classifyAndFill,
    _fillField: deps._fillField || defaultFillField,
    _clickNext: deps._clickNext || defaultClickNext,
    _waitDomStable: deps._waitDomStable || defaultWaitDomStable,
    _probeTotalSteps: deps._probeTotalSteps || realProbeTotalSteps,
    _findNextButton: deps._findNextButton || realFindNextButton,
    _isOnSubmitStep: deps._isOnSubmitStep || realIsOnSubmitStep,
    _readSession: deps._readSession || readSession,
    _writeSession: deps._writeSession || writeSession,
  };

  // INIT — load or bootstrap session
  let session = await resolved._readSession(jobId);
  if (!session) {
    if (!createIfMissing) {
      return {
        outcome: OUTCOME.ERROR,
        session: null,
        steps_run: 0,
        error: 'no session for jobId; call with createIfMissing=true to bootstrap',
      };
    }
    if (!jobUrl || !siteAdapter) {
      return {
        outcome: OUTCOME.ERROR,
        session: null,
        steps_run: 0,
        error: 'createIfMissing=true requires jobUrl + siteAdapter',
      };
    }
    session = buildInitialSession({ jobId, jobUrl, siteAdapter });
  }
  if (session.status === 'abandoned' || session.status === 'completed') {
    return {
      outcome: session.status === 'completed' ? OUTCOME.COMPLETED : OUTCOME.ERROR,
      session,
      steps_run: 0,
      error: session.status === 'abandoned' ? 'session abandoned (>24h idle)' : undefined,
    };
  }
  // Resume bumps status back to active (was 'paused' from prior bail)
  session.status = 'active';

  // DETECT_FLOW — probe total steps if not yet known
  if (session.total_steps == null) {
    try {
      const probe = await resolved._probeTotalSteps(page, session.site_adapter);
      if (probe && probe.total != null && probe.total >= 1) {
        session.total_steps = probe.total;
      }
    } catch {
      // Probe failure → stay in exploratory mode (total_steps stays null)
    }
  }

  // STEP_LOOP
  const ctx = { classifierCtx };
  let stepsRun = 0;
  let outcome = null;
  let errorMsg;

  try {
    for (let i = 0; i < maxSteps; i++) {
      // H3 fix from review: re-check isOnSubmitStep at the TOP of every
      // iteration (including after click+wait from the prior iteration's
      // tail). Workday's Review-then-Submit page may have both fillable
      // consent checkboxes AND a Submit button — without this check we'd
      // happily classify and fill the Review step, then findNextButton
      // could match "Submit" as a Next-equivalent and auto-submit.
      let isSubmit = false;
      try {
        isSubmit = await resolved._isOnSubmitStep(page, session.site_adapter);
      } catch {}
      if (isSubmit) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
        break;
      }

      // Run one step
      const stepRes = await runStep(session, { page, ...resolved, approve }, ctx);
      stepsRun++;

      // C5 fix from review: persist after each step (under lock) so
      // crash mid-machine doesn't lose all prior step progress.
      try {
        await withSessionLock(jobId, async () => {
          await resolved._writeSession(jobId, session);
        });
      } catch (err) {
        // Persist failure is fatal — abort cleanly
        errorMsg = `persist after step ${session.current_step} failed: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // M3 fix from review: runStep returns explicit outcome enum
      if (stepRes.outcome === 'paused') {
        outcome = OUTCOME.PAUSED;
        break;
      }

      // Find Next button + click
      const nextBtn = await resolved._findNextButton(page, session.site_adapter);
      if (!nextBtn) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
        break;
      }
      try {
        await resolved._clickNext(page, nextBtn.locator);
      } catch (err) {
        errorMsg = `Next click failed at step ${session.current_step}: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // WAIT_DOM_READY
      try {
        await resolved._waitDomStable(page);
      } catch (err) {
        errorMsg = `WAIT_DOM_READY failed after step ${session.current_step}: ${String(err?.message ?? err).slice(0, 200)}`;
        outcome = OUTCOME.ERROR;
        break;
      }

      // Advance step counter
      session.current_step += 1;
      if (session.total_steps != null && session.current_step > session.total_steps) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
        break;
      }
    }
    if (outcome == null) {
      errorMsg = `max-steps cap (${maxSteps}) reached without reaching Submit`;
      outcome = OUTCOME.ERROR;
    }
  } catch (err) {
    errorMsg = `runMachine threw: ${String(err?.message ?? err).slice(0, 200)}`;
    outcome = OUTCOME.ERROR;
  }

  // C4 fix from review: reconcile session.status with the final outcome
  // BEFORE the persist. status='active' must not be the disk state for an
  // error/completed/paused outcome. Map: completed→completed, paused→
  // paused (already set in runStep), error→paused (so resume can retry).
  // We add a transient `last_error` field to the session for diagnostics
  // (m1 schema is .strict() so we DON'T persist that — we attach it to
  // the returned object only).
  if (outcome === OUTCOME.COMPLETED) {
    session.status = 'completed';
  } else if (outcome === OUTCOME.ERROR) {
    session.status = 'paused';
  }
  // (PAUSED was already set by runStep on declined approval)

  // H6 fix from review: wrap the final write so ZodError (e.g. field_memory
  // ballooned past cap) becomes a clean error outcome rather than
  // escaping runMachine as an uncaught rejection.
  try {
    await withSessionLock(jobId, async () => {
      await resolved._writeSession(jobId, session);
    });
  } catch (err) {
    const persistErr = `final writeSession failed: ${String(err?.message ?? err).slice(0, 200)}`;
    errorMsg = errorMsg ? `${errorMsg}; ${persistErr}` : persistErr;
    outcome = OUTCOME.ERROR;
  }

  return {
    outcome,
    session,
    steps_run: stepsRun,
    ...(errorMsg ? { error: errorMsg } : {}),
  };
}

// ── Default Page-touching helpers ────────────────────────────────────
// These are the production defaults; m4 endpoint wires them via the
// real Playwright Page. Smoke replaces them with mocks.

// C1 + C2 caveat from review: defaultFillField is PROVISIONAL.
//   - It blindly tries fill → selectOption → check (in that order),
//     which is wrong for radio/checkbox/combobox state-mutating actions.
//   - It does NOT honor RefTable's pessimistic-invalidation contract
//     from 08-snapshot-refs-layer (each fill mutates the page; subsequent
//     fills against the same table can hit STALE_REF).
// m4 will replace this with the real 02-playwright-runtime action-verb
// layer that (a) routes by role + class, and (b) re-snapshots between
// fills when stale-ref fires. The smoke uses mocks; production usage
// SHOULD inject a fill_field that wraps the proper action verbs.
async function defaultFillField(page, refId, classifiedField, table) {
  if (!table || typeof table.resolve !== 'function') {
    throw new Error('defaultFillField: table.resolve not available');
  }
  const locator = table.resolve(refId, page);
  const value = classifiedField.suggested_value;

  // File class → upload via setInputFiles (only safe action for file inputs)
  if (classifiedField.class === 'file' && typeof value === 'string' && value) {
    await locator.setInputFiles(value);
    return;
  }

  // C1 partial fix: try in role-appropriate order WITHOUT falling through
  // to .check() on negative path (which would silently mis-toggle a radio).
  // Order: combobox/select → selectOption; textbox/textarea → fill;
  // checkbox → check/uncheck based on truthy value. We don't have role
  // info on the classifiedField shape — caller (m4 production wiring)
  // should pass role through; here we use heuristic by subclass + value.
  const isYes = String(value).trim().toLowerCase() === 'yes';
  const isNo = String(value).trim().toLowerCase() === 'no';

  // Try selectOption first (combobox / native select) — safe + idempotent
  try {
    await locator.selectOption(String(value));
    return;
  } catch {}
  // Then fill (textbox / textarea)
  try {
    await locator.fill(String(value));
    return;
  } catch {}
  // Finally, for boolean Yes/No legal questions, try check/uncheck
  if (classifiedField.class === 'legal' && (isYes || isNo)) {
    try {
      if (isYes) await locator.check();
      else await locator.uncheck();
      return;
    } catch {}
  }
  throw new Error(
    `defaultFillField: no action succeeded for refId=${refId} (class=${classifiedField.class}). ` +
      `Production wiring should inject _fillField that routes by role.`,
  );
}

async function defaultClickNext(page, locator) {
  await locator.click();
}

async function defaultWaitDomStable(page) {
  // Best-effort: networkidle with a bounded timeout. Falls back to a
  // short fixed delay if waitForLoadState isn't available (smoke).
  if (page && typeof page.waitForLoadState === 'function') {
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_WAIT_DOM_MS });
    return;
  }
  await new Promise((r) => setTimeout(r, 200));
}

// Re-export internals that smoke + m4 need
export { runStep, classifyEntries, tupleSetFromTable, entryTuple, stepNeedsApproval };
