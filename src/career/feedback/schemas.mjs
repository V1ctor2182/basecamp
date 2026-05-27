// Zod schemas for the 3 NEW feedback flywheel JSONL stores.
//
// 07-applier/07-self-iteration/02-data-flywheel m1.
//
// The 4 flywheels per the room intent:
//   ① field-misclassified.jsonl   — classifier got the class wrong
//   ② field-edits.jsonl           — user edited the suggested value
//   ③ open-question-diffs.jsonl   — DEFERRED (OQ5: reuse qa-bank/history.jsonl)
//   ④ site-failures.jsonl         — apply errored on a known domain
//
// All schemas are strict (no extra keys); ts is ISO 8601; jobId follows
// the project-wide 12-hex pattern (matches applySessionsStore.JOB_ID_RE).

import { z } from 'zod';

/** 12-hex jobId — shared across all career-system modules. */
export const JOB_ID_RE = /^[a-f0-9]{12}$/;

/** classifier output class set — matches draftsStore.FIELD_CLASSES. */
export const FIELD_CLASSES = Object.freeze(['hard', 'legal', 'open', 'file', 'unknown']);

/** Confidence tiers — matches draftsStore.CONFIDENCE_TIERS + 'manual'. */
export const CONFIDENCE_TIERS = Object.freeze(['high', 'medium', 'low', 'manual']);

/** Site-failure error classification. Maps Playwright errors + classifier
 *  failures into a small closed set so m2's induction can groupBy.
 *
 *  m7 (post-fill-handoff-ux Phase 1) adds 'escalated_*' codes — submit-
 *  first error loop gave up. Phase 5 signal F (submit detection
 *  accuracy / adapter thank-you rules) buckets per ATS to propose
 *  adapter rules. Kept as separate enum values (not "other") so
 *  groupBy can show "Captivation: 80% escalated_all_strategies_failed"
 *  vs "Lever: 60% escalated_timeout" without parsing error_message. */
export const ERROR_KINDS = Object.freeze([
  'timeout',          // ACTION_TIMEOUT / fill / click / select timed out
  'stale_ref',        // STALE_REF from RefTable invalidation
  'element_gone',     // ELEMENT_GONE / iframe detached / option not found
  'classifier_error', // classifier threw or returned 'unknown' for all
  'machine_error',    // state-machine internal (writeSession fail, etc.)
  // m7: submit-first error loop escalation reasons (mirror submitLoop's
  // escalation_reason.code with 'escalated_' prefix so flywheel buckets
  // separately from generic errors).
  'escalated_parse_failure',
  'escalated_parse_failure_empty',
  'escalated_all_strategies_failed',
  'escalated_same_error',
  'escalated_max_submits',
  'escalated_timeout',
  'escalated_submit_failed',
  'escalated_unexpected_next_step',
  'escalated_user_cancel',
  'escalated_wait_loop_stuck',
  'escalated_hard_cap',
  'escalated_unknown',  // fallback for future-added codes
  'other',            // catch-all
]);

// REVIEW H3 (Plan) fix: accept timestamps with offset suffixes too
// (RFC 3339 +00:00 / -08:00). Default z.string().datetime() rejects
// anything except 'Z'-suffixed forms — that would silently drop
// records emitted by clients formatting with offsets.
const tsSchema = z.string().datetime({ offset: true });
const jobIdSchema = z.string().regex(JOB_ID_RE, 'jobId must match 12-hex');

/**
 * field-misclassified.jsonl record.
 *
 * Written when the user reclassifies a field whose classifier-predicted
 * class differs from what the user actually wanted. m1 stores + helpers
 * are ready but no caller (no reclassify UI yet — deferred to a future
 * room). m2's induction reads this file regardless of source.
 */
export const FieldMisclassifiedSchema = z
  .object({
    ts: tsSchema,
    jobId: jobIdSchema,
    field_label: z.string().min(1).max(400),
    refId: z.string().min(1).max(64),
    predicted_class: z.enum(FIELD_CLASSES),
    actual_class: z.enum(FIELD_CLASSES),
    /** Dot-path into identity.yml / legal.yml / qa-bank when actual_class
     *  is hard/legal/file; null for open/unknown. */
    actual_mapping: z.string().min(1).max(200).nullable(),
    site: z.string().min(1).max(64), // site-adapter id (e.g. 'workday')
  })
  .strict();

/**
 * field-edits.jsonl record.
 *
 * Written from endpoint.mjs approve-step when the user's edited
 * suggested_value differs from the classifier-emitted one. m2's
 * induction reads same-site clusters to suggest narrative.md style
 * preferences (long-tail).
 */
export const FieldEditSchema = z
  .object({
    ts: tsSchema,
    jobId: jobIdSchema,
    field_id: z.string().min(1).max(64), // refId
    field_label: z.string().min(1).max(400),
    suggested: z.string().max(8000), // classifier output
    user_final: z.string().max(8000), // post-edit
    edit_distance: z.number().int().min(1), // Levenshtein; 0-distance skipped at capture
    confidence: z.enum(CONFIDENCE_TIERS),
    site: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * site-failures.jsonl record.
 *
 * Written from endpoint.mjs runMachine error path. Captures the failing
 * domain + adapter id + step + error kind. m2's induction reads
 * same-domain clusters at ≥5 to suggest a new site-adapter YAML.
 */
export const SiteFailureSchema = z
  .object({
    ts: tsSchema,
    jobId: jobIdSchema,
    domain: z.string().min(1).max(253), // URL.hostname (RFC 1035 max 253)
    site_adapter_id: z.string().min(1).max(64),
    // REVIEW H4 fix: nullable to signal "error preceded any approval"
    // (e.g. adapter-activate failure, getPage failure). Recording 0 in
    // that case would have confused m2 induction into clustering all
    // pre-first-draft failures under step_idx=0 across unrelated apps.
    step_idx: z.number().int().min(0).nullable(),
    error_kind: z.enum(ERROR_KINDS),
    error_message: z.string().max(400),
    /** Optional small excerpt of the snapshot (first ~400 chars) for
     *  m2 induction context. Not the full HTML — that's evidence
     *  store territory (01-code-calibration). */
    snapshot_excerpt: z.string().max(800).optional(),
  })
  .strict();

/** Post-fill verification statuses that count as a failure. */
export const VERIFY_FAILURE_STATUSES = Object.freeze([
  'mismatch',
  'fill_error',
  'not_seen',
  'unverifiable',
]);

/**
 * verify-failures.jsonl record.
 *
 * Written by the self-test harness (scripts/applier-selftest.mjs) — one
 * row per field that failed M1/M2 post-fill verification.
 *   - `not_seen`  — the classifier missed the field → feeds the
 *     classifier-rule induction (induceVerifyFix).
 *   - `mismatch` / `fill_error` / `unverifiable` — fill-mechanics
 *     issues; recorded for visibility, NOT rule-inducible.
 */
export const VerifyFailureSchema = z
  .object({
    ts: tsSchema,
    jobId: jobIdSchema,
    site: z.string().min(1).max(64), // site-adapter id
    field_label: z.string().min(1).max(400),
    refId: z.string().min(1).max(64),
    role: z.string().max(40), // a11y role ('' tolerated)
    verify_status: z.enum(VERIFY_FAILURE_STATUSES),
    suggested_value: z.string().max(2000), // what the machine intended ('' if none)
    detail: z.string().max(400), // verify_detail — the why ('' tolerated)
  })
  .strict();

/** Mapping from filename → schema; used by appendJsonl for validation. */
export const SCHEMAS_BY_FILE = Object.freeze({
  'field-misclassified.jsonl': FieldMisclassifiedSchema,
  'field-edits.jsonl': FieldEditSchema,
  'site-failures.jsonl': SiteFailureSchema,
  'verify-failures.jsonl': VerifyFailureSchema,
});
