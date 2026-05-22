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

import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildInitialSession,
  readSession,
  writeSession,
  withSessionLock,
} from './applySessionsStore.mjs';
import { snapshot as realSnapshot } from '../runtime/snapshot.mjs';
import { classifyAndFill, toSourceRefString } from '../classifier/index.mjs';
// Canonical-value → form-option matcher. Used to remap a classifier's
// canonical value ("Decline to answer") onto a dropdown's real option
// text once the options have been captured.
import { bestOption } from '../nonstandard/strategies/selectionControls.mjs';
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

// Real form-input roles. A field survives the chrome filter iff its
// a11y role is one of these (or it is a classified file-upload button).
// Filtering on role — not class — is correct because the snapshot's
// role allowlist also captures page chrome (nav links, section
// headings, logos), and that chrome can still match a HARD/LEGAL regex
// on its text ("Race & Ethnicity Definitions" link → legal). It also
// KEEPS real controls the classifier couldn't match — an unmatched
// dropdown is still a field the operator must handle.
const FORM_INPUT_ROLES = new Set(['textbox', 'checkbox', 'radio', 'combobox']);

// a11y roles that present a fixed option list. For these the machine
// opens the control during runStep and captures the real option texts,
// so the approval UI shows them and the operator picks an exact option
// — turning the fill into a deterministic match, not a fuzzy guess.
const DROPDOWN_ROLES = new Set(['combobox', 'listbox', 'menu']);

/**
 * For every dropdown-role field, open the control, read its real option
 * texts, close it, and stash them on `field.options`. Also remaps the
 * classifier's canonical suggested_value onto the closest real option
 * so the fill phase exact-matches instead of fuzzy-guessing.
 *
 * Fully defensive — never throws. Mock pages (smoke) lack getByRole and
 * are skipped wholesale, so the machine smoke is unaffected.
 */
async function captureDropdownOptions(page, table, classified) {
  if (!page || typeof page.getByRole !== 'function') return;
  if (!table || typeof table.resolve !== 'function') return;
  for (const f of classified) {
    if (!f || !DROPDOWN_ROLES.has(f.role)) continue;
    let loc;
    try {
      loc = table.resolve(f.refId, page);
    } catch {
      continue;
    }
    try {
      await loc.click({ timeout: 3000 });
      const optEls = page.getByRole('option');
      const n = await optEls.count();
      const opts = [];
      for (let i = 0; i < Math.min(n, 60); i++) {
        try {
          const t = (await optEls.nth(i).textContent()) || '';
          const trimmed = t.replace(/\s+/g, ' ').trim();
          if (trimmed) opts.push(trimmed);
        } catch {
          /* skip a bad option node */
        }
      }
      if (opts.length) {
        f.options = opts;
        // Remap the canonical value onto a real option — the approval
        // UI then pre-selects it and the fill is an exact match.
        if (f.suggested_value != null && f.suggested_value !== '') {
          const match = bestOption(f.suggested_value, opts);
          if (match) f.suggested_value = match;
        }
      }
      // Close the listbox so the next control opens cleanly.
      try {
        await page.keyboard.press('Escape');
      } catch {
        /* best-effort */
      }
    } catch {
      // Couldn't open this control — leave field.options undefined; the
      // fill phase still fuzzy-matches at fill time as a fallback.
    }
  }
}

// Locate the tailored resume PDF for a job. The tailor writes
// data/career/output/{jobId}-{resumeId}.pdf — we glob by jobId prefix
// so the apply doesn't need the resumeId plumbed through. Returns the
// absolute path when EXACTLY one match exists (ambiguous → null, the
// operator then uploads manually).
async function resolveResumePdf(jobId) {
  if (typeof jobId !== 'string' || !jobId) return null;
  try {
    const dir = path.resolve('data', 'career', 'output');
    const files = await fs.readdir(dir);
    const matches = files.filter(
      (f) => f.startsWith(`${jobId}-`) && f.toLowerCase().endsWith('.pdf'),
    );
    return matches.length === 1 ? path.join(dir, matches[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Detect file-upload controls and return them as synthetic file-class
 * fields. The a11y snapshot misses <input type=file> (no accessible
 * name), so this scans the DOM directly. Each field carries a
 * `_fileInputIndex` so the fill loop can setInputFiles() on it without
 * going through the refTable.
 *
 * Defensive — mock pages (smoke) lack page.locator and yield [].
 */
async function captureFileFields(page, session) {
  if (!page || typeof page.locator !== 'function') return [];
  let inputs;
  let n = 0;
  try {
    inputs = page.locator('input[type=file]');
    n = await inputs.count();
  } catch {
    return [];
  }
  const resumePdf = await resolveResumePdf(session?.jobId);
  const out = [];
  for (let i = 0; i < Math.min(n, 5); i++) {
    // First file input → resume (the universal case); extras are generic.
    const isResume = i === 0;
    const label = isResume ? 'Resume / CV upload' : `File upload ${i + 1}`;
    const subclass = isResume ? 'resume' : 'general-file';
    const found = isResume && resumePdf;
    const source = {
      kind: 'file',
      subclass,
      status: found ? 'found' : 'generate-first',
    };
    out.push({
      refId: `__file_${i}`,
      label,
      class: 'file',
      subclass,
      role: 'file',
      suggested_value: found ? resumePdf : null,
      confidence: found ? 'high' : 'manual',
      source,
      source_ref: toSourceRefString(source),
      // Marks this as a direct-selector file field — the fill loop uses
      // page.locator('input[type=file]').nth() instead of the refTable.
      _fileInputIndex: i,
    });
  }
  return out;
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
      // Carry the control role through so the approval UI can show the
      // user whether a field is a dropdown / radio / checkbox / text.
      if (typeof f.role === 'string' && f.role) out.role = f.role;
      // Real option texts captured from the live dropdown — lets the
      // approval UI render an actual <select> the operator picks from.
      if (Array.isArray(f.options) && f.options.length) {
        out.options = f.options.slice(0, 80).map((o) => String(o).slice(0, 400));
      }
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

  // Keep only real form controls. A single-page application URL
  // (greenhouse / lever / ashby) snapshots the WHOLE page, so nav links,
  // JD headings and logos arrive here too — and some of them match a
  // HARD/LEGAL regex on their text, so filtering on class is wrong.
  // Survive iff the a11y role is an actual input, or it is a classified
  // file-upload button. This drops page chrome AND keeps real controls
  // the classifier failed to match (an unmatched dropdown is still a
  // field the operator must fill — it surfaces as a manual field).
  classified = classified.filter(
    (c) =>
      c &&
      (FORM_INPUT_ROLES.has(c.role) || (c.role === 'button' && c.class === 'file')),
  );

  // Capture real dropdown options (open each → read → close) so the
  // approval UI shows them and the operator picks an exact option.
  await captureDropdownOptions(page, snapPre.table, classified);

  // Detect file-upload controls (the a11y snapshot misses <input
  // type=file>) and append them as synthetic file-class fields.
  const fileFields = await captureFileFields(page, session);
  if (fileFields.length) classified.push(...fileFields);

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
      if (typeof f._fileInputIndex === 'number') {
        // Synthetic file field — upload straight onto the <input
        // type=file> by index (it isn't in the refTable).
        await page
          .locator('input[type=file]')
          .nth(f._fileInputIndex)
          .setInputFiles(f.suggested_value);
      } else {
        await _fillField(page, f.refId, f, snapPre.table);
      }
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
      const depClassified = (
        await classifyEntries(
          dependents,
          ctx.classifierCtx || {},
          session.field_memory,
          _classifyAndFill,
        )
      ).filter((c) => c && c.class !== 'unknown');
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

  // Persist the session NOW, before the STEP_LOOP. The loop otherwise
  // only writes after each step COMPLETES — so during a long step 0
  // (e.g. a single-page form paused at its approval gate) the status
  // endpoint readSession()s nothing and 404s, hiding the live machine.
  // Writing here makes the apply observable from step 0 onward.
  try {
    await withSessionLock(jobId, async () => {
      await resolved._writeSession(jobId, session);
    });
  } catch {
    // Non-fatal — the per-step persist below will retry.
  }

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
      // Submit-button detection. A visible Submit button means different
      // things depending on where we are:
      //   - step > 0  → a multi-step wizard's final Review/Submit step.
      //     Stop WITHOUT filling — the bulk was filled on prior steps and
      //     the operator submits. (Prevents auto-submitting a Workday
      //     Review page; preserves the original H3 review fix.)
      //   - step 0    → a SINGLE-PAGE form (greenhouse / lever / ashby):
      //     the whole form AND the Submit button live on one page. We
      //     must fill it first, so DON'T break here — fall through to
      //     runStep, then stop after filling (the isSubmit check below).
      // The machine never clicks Submit itself in either case.
      let isSubmit = false;
      try {
        isSubmit = await resolved._isOnSubmitStep(page, session.site_adapter);
      } catch {}
      if (isSubmit && session.current_step > 0) {
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

      // Single-page form: the form is now filled and the Submit button is
      // right here → done. The operator reviews and submits in the browser.
      if (isSubmit) {
        session.status = 'completed';
        outcome = OUTCOME.COMPLETED;
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
