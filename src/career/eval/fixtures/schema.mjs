// Zod schema for eval-fixture ground-truth YAML pairs.
//
// 07-applier/self-iteration/01-code-calibration m1.
//
// Each fixture lives as a sibling pair under data/career/eval-fixtures/:
//   {vendor-slug}.html          — offline HTML snapshot (EH4: NOT live URL)
//   {vendor-slug}.truth.yml     — human-annotated ground truth (EH3)
//
// Ground-truth YAML shape (locked m1):
//   url:           https://boards.greenhouse.io/anthropic/jobs/123
//   captured_at:   2026-05-18                       # YYYY-MM-DD or ISO
//   vendor:        greenhouse                       # vendor slug
//   page_type:     apply-form                       # optional
//   must_detect:                                    # snapshot MUST surface
//     - { role: textbox, name: "First Name", required: true }
//     - { role: button,  name: "Submit Application" }
//   must_not_detect:                                # snapshot MUST filter
//     - { name: "Privacy Policy", reason: "footer nav noise" }
//     - { name: "Cookie consent banner", reason: "interstitial overlay" }
//
// Design notes:
//   - role is a FREE STRING, not a Zod enum. snapshot.mjs INTERACTIVE_ROLES
//     is the source of truth at eval-time; baking the allowlist into the
//     schema would force lockstep edits every time the tuner proposes a
//     diff. The eval runner (m2) cross-checks role against the live
//     allowlist; the schema only enforces shape + length bounds.
//   - must_not_detect uses structured {name, reason} (not free strings as
//     in the spec sketch) so the `reason` aids reviewers when a false
//     positive leaks back in and we need to recall WHY a string was on
//     the deny list.
//   - All schemas are .strict() — typos in YAML keys fail loudly instead
//     of silently being ignored.

import { z } from 'zod';

/** Vendor slug — kebab-case, ATS recognizer name (greenhouse, lever, ...). */
const vendorSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'vendor must be kebab-case slug');

/**
 * captured_at — date-only (YYYY-MM-DD) OR full ISO 8601 with offset.
 * We accept both because manual annotators often write just the date.
 *
 * REVIEW H4 (adv) fix: the bare regex matched impossible dates like
 * 2026-13-45. Round-trip through Date.UTC and require the rendered
 * string to equal the input — this rejects out-of-range months/days
 * without us re-implementing Gregorian rules.
 */
const capturedAtSchema = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'), z.string().datetime({ offset: true })])
  .refine(
    (s) => {
      if (s.length === 10) {
        const [y, m, d] = s.split('-').map((n) => Number.parseInt(n, 10));
        const epoch = Date.UTC(y, m - 1, d);
        if (!Number.isFinite(epoch)) return false;
        return new Date(epoch).toISOString().slice(0, 10) === s;
      }
      // Full-ISO branch — z.string().datetime already validates structure.
      // Re-roundtrip catches things like 2026-02-31T00:00:00Z.
      const epoch = Date.parse(s);
      return Number.isFinite(epoch);
    },
    { message: 'captured_at: out-of-range calendar date' },
  );

// REVIEW H3 (adv) fix: reject bidi-override / zero-width / BOM characters
// in user-displayed strings. A label containing U+202E ("RIGHT-TO-LEFT
// OVERRIDE") renders one way in the review tool and another in the
// snapshot's accessible-name output, silently breaking exact-match in m2.
// Same risk class as the sanitizeForDisplay shim in Learning.tsx.
const SPOOFING_CHARS_RE = /[‪-‮⁦-⁩﻿​-‏]/;
const noSpoofingChars = (s) => !SPOOFING_CHARS_RE.test(s);
const noSpoofingMsg = { message: 'contains bidi-override / zero-width / BOM characters' };

const MustDetectItemSchema = z
  .object({
    /** ARIA role expected on the element. Free string by design — see
     *  module note. Eval runner (m2) cross-checks at run time. */
    role: z.string().min(1).max(48),
    /** Accessible name. Compared by exact match in the snapshot output
     *  unless the eval runner enables fuzzy matching (m2 OQ). */
    name: z.string().min(1).max(400).refine(noSpoofingChars, noSpoofingMsg),
    /** Truthy when the form marks this field with aria-required="true"
     *  or the visible "*" indicator. Optional — fixtures don't always
     *  capture this. */
    required: z.boolean().optional(),
    /** Truthy when annotator notes the field is explicitly optional
     *  (some ATS surface "(optional)" suffix in the label). */
    optional: z.boolean().optional(),
    /** ARIA states the snapshot should emit alongside the line, e.g.
     *  ['checked'], ['expanded', 'required']. Empty array allowed. */
    states: z.array(z.string().min(1).max(32)).max(8).optional(),
  })
  .strict();

const MustNotDetectItemSchema = z
  .object({
    /** Accessible name (or visible text snippet) that the snapshot
     *  should NOT surface. */
    name: z.string().min(1).max(400).refine(noSpoofingChars, noSpoofingMsg),
    /** Human-readable rationale — required because reasonless deny-list
     *  entries rot fast. */
    reason: z.string().min(1).max(400).refine(noSpoofingChars, noSpoofingMsg),
  })
  .strict();

// REVIEW M7 (Plan) + C1 (adv) fix: url must be http/https. file://,
// javascript:, chrome:// all parse as valid URL but should never be
// used for an ATS apply page; defense-in-depth alongside the runtime
// allowlist in capture.mjs.
const httpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => {
    try {
      const proto = new URL(u).protocol;
      return proto === 'https:' || proto === 'http:';
    } catch {
      return false;
    }
  }, { message: 'url must use http or https' });

export const GroundTruthSchema = z
  .object({
    url: httpUrlSchema,
    captured_at: capturedAtSchema,
    vendor: vendorSchema,
    /** Optional page-type label — useful for multi-step Workday/iCIMS
     *  flows where one vendor has multiple distinct page shapes. */
    page_type: z.string().min(1).max(48).optional(),
    must_detect: z.array(MustDetectItemSchema).min(1).max(200),
    must_not_detect: z.array(MustNotDetectItemSchema).max(200).default([]),
  })
  .strict();

/** Re-exported for direct consumption. */
export { MustDetectItemSchema, MustNotDetectItemSchema };

/**
 * Validate a parsed YAML object against the ground-truth schema. Throws
 * on failure with a formatted error message (Zod's default error format
 * is too noisy for terminal output).
 *
 * @param {unknown} parsed — raw object from yaml.load()
 * @param {string} [filename] — used in error messages
 * @returns {z.infer<typeof GroundTruthSchema>}
 */
export function validateGroundTruth(parsed, filename = '<unknown>') {
  const result = GroundTruthSchema.safeParse(parsed);
  if (result.success) return result.data;
  const issues = (result.error.issues || result.error.errors || [])
    .map((e) => `  · ${(e.path || []).join('.') || '<root>'}: ${e.message}`)
    .join('\n');
  throw new Error(`validateGroundTruth: ${filename} schema validation failed:\n${issues}`);
}
