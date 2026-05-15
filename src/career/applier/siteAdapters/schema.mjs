// Zod schema for site-adapter YAML files + compileAdapter helper.
//
// 07-applier/06-site-adapters m1.
//
// Each adapter describes how to recognize and interact with one ATS:
//   - detection.url_patterns: regex sources (compiled at compileAdapter time)
//   - flow: single-step vs multi-step + button/progress hints
//   - controls.{date_picker,address_autocomplete,custom_dropdown,file_upload}:
//     per-category hints that m2 will inject into 05's DETECTION_RULES
//   - known_fields: label → class + maps_to that m2 will prepend to
//     03-classifier's regex rule sweep
//
// `_common.yml` is a special file consumed by the loader (not by this
// schema) — it gets merged into every adapter's flow defaults at load
// time. We validate it via a separate, looser schema.

import { z } from 'zod';

/** Source for one Playwright control category hint within an adapter. */
const ControlHintSchema = z
  .object({
    // Must match a ControlType value from 05/controlRouter.mjs. We don't
    // hard-couple to the enum here (avoid a circular import) — m2's
    // activateAdapter validates against the registry and warns on
    // unknown values rather than rejecting at load time.
    control_type: z.string(),
    detect: z
      .object({
        class_contains: z.string().optional(),
        tag_name: z.string().optional(),
        aria_role: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Label → classifier hint. label_pattern is a JS regex source (case-
 * insensitive applied at compile time). class must be one of the 4
 * field classes (matches draftsStore.mjs FIELD_CLASSES). maps_to is a
 * dot-path into identity.yml / legal.yml / qa-bank — classifier
 * resolves it at fill time (m2 wires the resolver).
 */
const KnownFieldSchema = z
  .object({
    label_pattern: z.string(),
    class: z.enum(['hard', 'legal', 'open', 'file']),
    maps_to: z.string(),
    // REVIEW L1 fix: default to 'medium' rather than 'high'. Authors
    // who omit `confidence` shouldn't accidentally claim a high-
    // confidence fill — high should be opt-in for fields the author
    // verified across multiple variants.
    confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  })
  .strict();

/** Selector + accessible-name hints for one button/region. */
const ButtonHintSchema = z
  .object({
    selectors: z.array(z.string()).default([]),
    name_hints: z.array(z.string()).default([]),
  })
  .strict();

const FlowSchema = z
  .object({
    type: z.enum(['single-step', 'multi-step']),
    next_button: ButtonHintSchema.default({ selectors: [], name_hints: [] }),
    submit_button: ButtonHintSchema.default({ selectors: [], name_hints: [] }),
    progress_bar: ButtonHintSchema.default({ selectors: [], name_hints: [] }),
    step_list: ButtonHintSchema.default({ selectors: [], name_hints: [] }),
  })
  .strict();

const DetectionSchema = z
  .object({
    // At least one URL pattern required — `default.yml` uses '.*' to
    // match everything as the priority-0 fallback.
    url_patterns: z.array(z.string()).min(1),
    // OQ4 m1: schema accepted but loader does NOT consume yet. Phase 2
    // / 飞轮 will wire this when DOM-signature detection lands.
    dom_signatures: z.array(z.string()).default([]),
  })
  .strict();

const ControlsSchema = z
  .object({
    date_picker: ControlHintSchema.optional(),
    address_autocomplete: ControlHintSchema.optional(),
    custom_dropdown: ControlHintSchema.optional(),
    file_upload: ControlHintSchema.optional(),
  })
  .strict()
  .default({});

/**
 * The full site-adapter schema. `_common.yml` does NOT match this —
 * the loader filters that file by name and validates it via a separate
 * looser schema (CommonDefaultsSchema below).
 */
export const SiteAdapterSchema = z
  .object({
    name: z.string().min(1),
    // Slug — must match the filename minus extension (loader enforces).
    id: z.string().regex(/^[a-z0-9_-]+$/, 'id must be lowercase slug'),
    priority: z.number().int().min(0).default(100),
    detection: DetectionSchema,
    flow: FlowSchema,
    controls: ControlsSchema,
    known_fields: z.array(KnownFieldSchema).default([]),
    quirks: z.array(z.string()).default([]),
  })
  .strict();

/**
 * `_common.yml` — merge defaults applied to every adapter at load time.
 * Looser than SiteAdapterSchema: no id / detection / no required flow.type.
 */
export const CommonDefaultsSchema = z
  .object({
    flow: z
      .object({
        next_button: ButtonHintSchema.optional(),
        submit_button: ButtonHintSchema.optional(),
        progress_bar: ButtonHintSchema.optional(),
        step_list: ButtonHintSchema.optional(),
      })
      .strict()
      .optional(),
    controls: ControlsSchema.optional(),
    quirks: z.array(z.string()).default([]).optional(),
  })
  .strict();

/**
 * Compile a parsed-and-validated adapter into a runtime-friendly shape:
 *   - detection.urlRegexes: RegExp[] (compiled from url_patterns /i)
 *   - known_fields[i].labelRegex: RegExp (compiled /i)
 *
 * Throws SyntaxError if any pattern is malformed — surface from the
 * caller with the adapter id so the user can fix the YAML.
 *
 * @param {z.infer<typeof SiteAdapterSchema>} raw
 * @returns {CompiledAdapter}
 */
export function compileAdapter(raw) {
  const urlRegexes = raw.detection.url_patterns.map((p) => _safeRegex(p, raw.id));
  const knownFields = raw.known_fields.map((kf) =>
    Object.freeze({
      ...kf,
      labelRegex: _safeRegex(kf.label_pattern, `${raw.id}:known_fields:${kf.maps_to}`),
    }),
  );
  // REVIEW H5 fix: deep-freeze flow/controls/quirks too so m2's
  // activateAdapter can't accidentally mutate the cached registry
  // (the registry is shared across requests via the loader mtime
  // cache). Shallow freeze on the top-level object was insufficient.
  return Object.freeze({
    ...raw,
    detection: Object.freeze({
      url_patterns: Object.freeze([...raw.detection.url_patterns]),
      dom_signatures: Object.freeze([...raw.detection.dom_signatures]),
      urlRegexes: Object.freeze(urlRegexes),
    }),
    flow: _deepFreezeFlow(raw.flow),
    controls: _deepFreezeControls(raw.controls),
    known_fields: Object.freeze(knownFields),
    quirks: Object.freeze([...raw.quirks]),
  });
}

function _deepFreezeFlow(flow) {
  const out = { type: flow.type };
  for (const region of ['next_button', 'submit_button', 'progress_bar', 'step_list']) {
    const r = flow[region] || { selectors: [], name_hints: [] };
    out[region] = Object.freeze({
      selectors: Object.freeze([...(r.selectors || [])]),
      name_hints: Object.freeze([...(r.name_hints || [])]),
    });
  }
  return Object.freeze(out);
}

function _deepFreezeControls(controls) {
  const out = {};
  for (const k of ['date_picker', 'address_autocomplete', 'custom_dropdown', 'file_upload']) {
    if (controls[k]) {
      const c = controls[k];
      out[k] = Object.freeze({
        control_type: c.control_type,
        detect: c.detect ? Object.freeze({ ...c.detect }) : undefined,
      });
    }
  }
  return Object.freeze(out);
}

// REVIEW C2 fix: cap regex source length. YAMLs are trusted (committed)
// but defense-in-depth — a malicious or buggy pattern with catastrophic
// backtracking can freeze the applier hot path (detectSiteAdapter runs
// per-startMachine). 256 chars covers every realistic ATS pattern we
// expect; longer patterns indicate a content/structure mismatch and
// should be rejected at load time.
const _MAX_REGEX_SOURCE_LEN = 256;

function _safeRegex(source, context) {
  if (typeof source !== 'string') {
    throw new TypeError(`compileAdapter(${context}): pattern must be a string`);
  }
  if (source.length > _MAX_REGEX_SOURCE_LEN) {
    throw new SyntaxError(
      `compileAdapter(${context}): pattern length ${source.length} exceeds cap ${_MAX_REGEX_SOURCE_LEN}`,
    );
  }
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    throw new SyntaxError(`compileAdapter(${context}): invalid regex /${source}/: ${err.message}`);
  }
}

/**
 * Merge `_common.yml` defaults into an adapter. Concatenates string
 * arrays (selectors, name_hints) instead of overwriting — adapter-
 * specific hints come first, common hints append as fallback. Controls
 * are NOT merged from _common (each adapter declares its own).
 *
 * Returns a new adapter object; does not mutate inputs.
 *
 * @param {object} adapterRaw — adapter pre-validation
 * @param {object|null} commonDefaults — parsed _common.yml or null
 * @returns {object} adapter raw with merged defaults
 */
export function mergeCommonDefaults(adapterRaw, commonDefaults) {
  if (!commonDefaults || !commonDefaults.flow) return adapterRaw;
  // REVIEW H3 fix: mergeCommonDefaults runs BEFORE Zod validation, so
  // `adapterRaw.flow` may be undefined / null / non-object. Object
  // spread on null throws; guard explicitly so the user gets the Zod
  // error ("flow is required") instead of a TypeError.
  if (!adapterRaw.flow || typeof adapterRaw.flow !== 'object') return adapterRaw;
  const merged = { ...adapterRaw, flow: { ...adapterRaw.flow } };
  for (const region of ['next_button', 'submit_button', 'progress_bar', 'step_list']) {
    const adapterRegion = adapterRaw.flow[region] || {};
    const commonRegion = commonDefaults.flow[region] || {};
    merged.flow[region] = {
      selectors: [...(adapterRegion.selectors || []), ...(commonRegion.selectors || [])],
      name_hints: [...(adapterRegion.name_hints || []), ...(commonRegion.name_hints || [])],
    };
  }
  return merged;
}

/**
 * @typedef {object} CompiledAdapter
 * @property {string} name
 * @property {string} id
 * @property {number} priority
 * @property {{ url_patterns: string[], dom_signatures: string[], urlRegexes: RegExp[] }} detection
 * @property {object} flow
 * @property {object} controls
 * @property {Array<object & { labelRegex: RegExp }>} known_fields
 * @property {string[]} quirks
 */
