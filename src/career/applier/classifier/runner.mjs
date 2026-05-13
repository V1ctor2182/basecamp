// Snapshot → classifyAndFill pipeline + Draft writer.
//
// 07-applier/03-field-classifier m3 (ROOM COMPLETE).
//
// classifyAndDraft() is the public entry point: takes a Playwright page +
// jobId/resumeId/ctx, snapshots interactive nodes (via 08-snapshot-refs-
// layer), classifies + fills each field (via m1+m2 of this Room), maps
// the classifier output to the canonical DraftSchema shape, and persists
// via 01-mode1's draftsStore. Mode 1 and Mode 2 now share the same
// drafts/{jobId}.json contract so the dashboard / UI consume one shape.
//
// Mapping (classifier → DraftField) is the key adapter logic — DraftSchema
// is strict and predates m2's richer output (cost_usd / used / source
// object / 'manual' confidence / null suggested_value / 'unknown' class).
// See `toDraftField()` below for the rules.

import {
  APPLIER_MODEL,
} from '../draftPrompt.mjs';
import { writeDraft, JOB_ID_RE } from '../draftsStore.mjs';
import { snapshot as realSnapshot } from '../runtime/snapshot.mjs';
import { classifyAndFill } from './index.mjs';

const RUNNER_CALLER = 'applier:classifier-runner';

const MAX_FIELDS = 50;
const MAX_LABEL_LEN = 200;
const MAX_VALUE_LEN = 4000;
const MAX_SOURCE_REF_LEN = 200;

const DRAFT_CONFIDENCES = new Set(['high', 'medium', 'low']);
const DRAFT_CLASSES = new Set(['hard', 'legal', 'open', 'file']);

// M1 fix from review: when MAX_FIELDS truncation kicks in, prefer to
// preserve fields the user CANNOT manually re-create (file uploads,
// identity data) over LLM-generated open-form answers. Real Workday
// snapshots can put resume upload at position 55+ after dozens of EEO
// questions — naive head-cut would silently drop the resume.
const CLASS_PRIORITY = Object.freeze({ file: 0, hard: 1, legal: 2, open: 3 });

/**
 * Map a single classifyAndFill result → DraftSchema-shaped DraftField,
 * or null if the field should be filtered out of the draft.
 *
 * Rules:
 *   - class === 'unknown'  → filtered (DraftSchema enum doesn't include it)
 *   - confidence 'manual'  → 'low'   (DraftSchema enum is high/medium/low)
 *   - suggested_value null → ''       (DraftSchema requires string)
 *   - label/value/source_ref truncated to schema max lengths
 *   - extras (refId, subclass, source, cost_usd, used) dropped
 *
 * @param {object} classified — output of classifyAndFill
 * @returns {{ label: string, class: string, suggested_value: string, confidence: string, source_ref?: string } | null}
 */
export function toDraftField(classified) {
  if (!classified || typeof classified !== 'object') return null;
  if (!DRAFT_CLASSES.has(classified.class)) return null;

  const rawLabel = String(classified.label ?? '').trim();
  if (!rawLabel) return null;
  const label = rawLabel.slice(0, MAX_LABEL_LEN);

  const rawValue = classified.suggested_value == null ? '' : String(classified.suggested_value);
  const suggested_value = rawValue.slice(0, MAX_VALUE_LEN);

  let confidence = classified.confidence;
  if (!DRAFT_CONFIDENCES.has(confidence)) {
    confidence = 'low'; // 'manual' or any unexpected value → 'low' (needs review)
  }

  const out = {
    label,
    class: classified.class,
    suggested_value,
    confidence,
  };

  // M3 fix from review: drop over-cap source_ref entirely rather than
  // mid-token truncate — downstream parsers (H10 contract in index.mjs)
  // expect a structured `kind:key?status=...` string; a slice at 200
  // chars can land mid-key and corrupt downstream parsing. Better absent
  // than corrupt. (m2 contract bounds these to <60 chars in practice.)
  if (typeof classified.source_ref === 'string' && classified.source_ref) {
    if (classified.source_ref.length <= MAX_SOURCE_REF_LEN) {
      out.source_ref = classified.source_ref;
    }
    // else: dropped silently — over-cap source_refs are a bug upstream
  }

  return out;
}

/**
 * Run the full snapshot → classify → fill → write pipeline for one job.
 *
 * @param {object} args
 * @param {import('playwright').Page} [args.page] — only needed if deps._snapshot
 *   isn't injected (production default)
 * @param {string} args.jobId — 12-hex; must match DraftSchema regex
 * @param {string} args.resumeId — resume identifier for file-class lookup
 * @param {string} [args.jdSummary]
 * @param {string} [args.narrativeVoice]
 * @param {object} [args.identity]
 * @param {Array}  [args.history] — qa-bank history (else openFiller auto-loads)
 * @param {object} [args.client] — Anthropic client (else openFiller falls back to no-client error)
 * @param {Function} [args.computeCostUsd]
 * @param {Function} [args.recordCost]
 * @param {Function} [args.checkBudget]
 *
 * @param {object} [deps]
 * @param {Function} [deps._snapshot] — defaults to runtime/snapshot.snapshot
 * @param {Function} [deps._writeDraft] — defaults to draftsStore.writeDraft
 * @param {Function} [deps._now] — defaults to () => new Date()
 *
 * @returns {Promise<{
 *   draft: object,
 *   snapshot: { skippedFrames: number, totalRefs: number, filteredCount: number, errorCount: number },
 * }>}
 */
export async function classifyAndDraft(args, deps = {}) {
  const {
    page,
    jobId,
    resumeId,
    jdSummary,
    narrativeVoice,
    identity,
    history,
    client,
    computeCostUsd,
    recordCost,
    checkBudget,
  } = args || {};

  // Tighten jobId guard up-front so a bad value can't propagate into
  // ctx (fileFiller path construction, classifier logs) before
  // writeDraft would have caught it. Fail fast before any LLM spend.
  if (!jobId || typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new Error('classifyAndDraft: jobId is required and must match 12-hex');
  }

  const _snapshot = deps._snapshot || realSnapshot;
  const _writeDraft = deps._writeDraft || writeDraft;
  const _classifyAndFill = deps._classifyAndFill || classifyAndFill;
  const _now = deps._now || (() => new Date());

  // 1) Snapshot
  const snap = await _snapshot(page);
  if (!snap || !snap.table) {
    throw new Error('classifyAndDraft: snapshot did not return a RefTable');
  }
  const { table, skippedFrames = 0 } = snap;

  // 2) Iterate refIds → classify + fill each.
  // Note: snapshot is read-only here. We never call table.resolve();
  // generation/staleness is irrelevant. publicEntry() returns frame-
  // less projections that don't depend on _currentGen.
  const refIds = [...table.refIds()];
  const totalRefs = refIds.length;
  const ctx = {
    jobId,
    resumeId,
    jdSummary,
    narrativeVoice,
    identity,
    history,
    client,
    computeCostUsd,
    recordCost,
    checkBudget,
  };

  const draftFields = [];
  let totalCost = 0;
  let filteredCount = 0;
  let errorCount = 0;

  for (const refId of refIds) {
    const entry = table.publicEntry(refId);
    if (!entry) {
      // Race: ref existed at refIds() but publicEntry returned null (unlikely
      // within one sync block; defensive belt). Skip.
      filteredCount++;
      continue;
    }
    let classified;
    try {
      classified = await _classifyAndFill(entry, ctx);
    } catch (err) {
      // Per-field failure mustn't sink the whole draft. Synthesize a
      // manual stub so the user can see this field in the UI and fix it.
      //
      // H4 cross-Room contract: the stub uses class='open' so it lands
      // in the draft (DraftSchema enum doesn't include 'unknown'/'error').
      // Downstream multi-step state machine (04) and non-standard
      // controls (05) MUST inspect `source_ref.startsWith('error:')`
      // before retrying an LLM call on a class=open field — otherwise
      // we'd burn $$ retrying a field that was tagged 'open' only
      // because classification itself failed.
      //
      // Also: we don't embed err.message into source_ref (privacy +
      // bounded shape — downstream parsers expect structured tokens,
      // not arbitrary error strings). The error message is logged
      // instead for debugging.
      errorCount++;
      console.warn(
        `[${RUNNER_CALLER}] classifyAndFill threw for ref=${refId} (${entry.role}/${entry.name}):`,
        String(err?.message ?? err).slice(0, 200),
      );
      classified = {
        refId,
        label: entry.name || `field#${refId}`,
        class: 'open',
        subclass: 'classify-error',
        suggested_value: null,
        confidence: 'manual',
        source_ref: 'error:classify-failed',
        cost_usd: 0,
        used: 'error',
      };
    }

    // Cost guard: must be finite AND non-negative. DraftSchema requires
    // cost_usd >= 0 on the aggregate — a single bogus negative would
    // crash writeDraft AFTER LLM calls were already billed. Defensive.
    if (
      typeof classified.cost_usd === 'number' &&
      Number.isFinite(classified.cost_usd) &&
      classified.cost_usd >= 0
    ) {
      totalCost += classified.cost_usd;
    }

    const field = toDraftField(classified);
    if (!field) {
      filteredCount++;
      continue;
    }
    draftFields.push(field);
  }

  if (draftFields.length === 0) {
    throw new Error(
      `classifyAndDraft: no draftable fields after classification ` +
        `(totalRefs=${totalRefs}, filteredCount=${filteredCount}, errorCount=${errorCount})`,
    );
  }

  // M1 fix from review: when truncating, preserve fields by class
  // priority (file > hard > legal > open) — naive head-cut on snapshot
  // order can drop resume-upload fields that appear after dozens of EEO
  // questions in Workday-style a11y trees. Stable within each class so
  // intra-class order = original DOM order.
  let truncatedCount = 0;
  if (draftFields.length > MAX_FIELDS) {
    truncatedCount = draftFields.length - MAX_FIELDS;
    console.warn(
      `[${RUNNER_CALLER}] truncating fields ${draftFields.length} → ${MAX_FIELDS} ` +
        `(DraftSchema cap; preserved by class priority file>hard>legal>open)`,
    );
    const indexed = draftFields.map((f, i) => ({ f, i }));
    indexed.sort((a, b) => {
      const pa = CLASS_PRIORITY[a.f.class] ?? 99;
      const pb = CLASS_PRIORITY[b.f.class] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.i - b.i; // stable: preserve DOM order within a class
    });
    draftFields.length = 0;
    for (let k = 0; k < MAX_FIELDS; k++) draftFields.push(indexed[k].f);
  }

  // 3) Assemble + persist Draft
  const draft = {
    jobId,
    fields: draftFields,
    generated_at: _now().toISOString(),
    model: APPLIER_MODEL,
    cost_usd: Number.isFinite(totalCost) ? totalCost : 0,
  };

  const validated = await _writeDraft(jobId, draft);

  return {
    draft: validated,
    snapshot: {
      skippedFrames,
      totalRefs,
      filteredCount,
      errorCount,
      truncatedCount,
    },
  };
}

export { RUNNER_CALLER, MAX_FIELDS, MAX_LABEL_LEN, MAX_VALUE_LEN };
