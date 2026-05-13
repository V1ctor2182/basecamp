// Field classifier — public API.
//
// 07-applier/03-field-classifier m1.
//
// m1 ships the deterministic path:
//   classifyAndLookup(snapshotEntry) → partial DraftField
//
// Hard / Legal classes get fully resolved (regex match + lookup → value).
// Open / File / Unknown classes return suggested_value=null in m1 —
// m2's openFiller / fileFiller will wire the LLM + file-path resolvers.

import { classifyField } from './regexRules.mjs';
import { lookupHardValue } from './identityLookup.mjs';
import { lookupLegalValue } from './legalLookup.mjs';

export { classifyField, HARD_PATTERNS, LEGAL_PATTERNS, FILE_PATTERNS, OPEN_PATTERNS } from './regexRules.mjs';
export { loadIdentity, lookupHardValue } from './identityLookup.mjs';
export { loadLegal, lookupLegalValue } from './legalLookup.mjs';

/**
 * H10 fix from review: source_ref is now a STRUCTURED object, stringified
 * by toSourceRefString() for display. Downstream consumers (m3 writer,
 * 09 eval-harness, UI) branch on `.kind` / `.status` rather than parsing
 * English-language parenthetical annotations.
 *
 * @typedef {object} SourceRef
 * @property {'identity'|'legal'|'file'|'llm'|'unclassified'} kind
 * @property {string} [key]    — lookupKey when kind=identity|legal
 * @property {string} [subclass] — when kind=file|llm
 * @property {'found'|'missing'|'extend'|'pending'} status
 */

function toSourceRefString(sr) {
  if (!sr) return 'unclassified';
  if (sr.kind === 'unclassified') return 'unclassified';
  const base = sr.key
    ? `${sr.kind}.yml:${sr.key}`
    : sr.subclass
    ? `${sr.kind}:${sr.subclass}`
    : sr.kind;
  return sr.status === 'found' ? base : `${base}?status=${sr.status}`;
}

/**
 * Classify + lookup a single snapshot entry. m1 public API — produces
 * a partial DraftField. m2 supersedes this with classifyAndFill which
 * also handles Open (LLM) + File (path resolution).
 *
 * @param {{ refId?: string, role: string, name: string, occurrenceIndex?: number, ... }} entry
 *   snapshot entry from 08-snapshot-refs-layer
 * @returns {Promise<{
 *   refId: string | null,
 *   label: string,
 *   class: 'hard' | 'legal' | 'open' | 'file' | 'unknown',
 *   subclass?: string,
 *   suggested_value: string | null,
 *   confidence: 'high' | 'medium' | 'low' | 'manual',
 *   source: SourceRef,
 *   source_ref: string,
 * }>}
 */
export async function classifyAndLookup(entry) {
  const cls = classifyField(entry);
  const role = entry.role;
  const base = {
    refId: entry.refId || null,
    label: entry.name,
    class: cls.class,
    subclass: cls.subclass,
  };

  if (cls.class === 'hard') {
    const { found, value } = await lookupHardValue(cls.lookupKey);
    // M7 fix from review: empty string treated same as missing (form
    // can't be filled with "" — better to mark manual than fill empty)
    if (found && value && value.length > 0) {
      const source = { kind: 'identity', key: cls.lookupKey, status: 'found' };
      return {
        ...base,
        suggested_value: value,
        confidence: 'high',
        source,
        source_ref: toSourceRefString(source),
      };
    }
    const status = cls.lookupKey ? 'missing' : 'extend';
    const source = { kind: 'identity', key: cls.lookupKey || undefined, subclass: cls.subclass, status };
    return {
      ...base,
      suggested_value: null,
      confidence: 'manual',
      source,
      source_ref: toSourceRefString(source),
    };
  }

  if (cls.class === 'legal') {
    const { found, value, coercedFrom } = await lookupLegalValue(
      cls.lookupKey,
      cls.eeoDefault,
    );
    if (found && value != null && value.length > 0) {
      // H7 fix from review: combobox + number coercion is a known type-
      // mismatch trap. Downgrade confidence to 'manual' so caller knows
      // to verify (e.g., travel_willing_percent=25 fed into a Yes/No combobox)
      const isComboboxNumberMismatch = role === 'combobox' && coercedFrom === 'number';
      const source = { kind: 'legal', key: cls.lookupKey, status: 'found' };
      return {
        ...base,
        suggested_value: value,
        confidence: isComboboxNumberMismatch ? 'manual' : 'high',
        source,
        source_ref: toSourceRefString(source),
      };
    }
    const source = { kind: 'legal', key: cls.lookupKey, status: 'missing' };
    return {
      ...base,
      suggested_value: null,
      confidence: 'manual',
      source,
      source_ref: toSourceRefString(source),
    };
  }

  if (cls.class === 'file') {
    // m1: no path resolution yet (needs jobId+resumeId from ctx — m2)
    const source = { kind: 'file', subclass: cls.subclass, status: 'pending' };
    return {
      ...base,
      suggested_value: null,
      confidence: 'manual',
      source,
      source_ref: toSourceRefString(source),
    };
  }

  if (cls.class === 'open') {
    // m1: no LLM yet (m2 wires openFiller). M8 fix: with suggested_value=null,
    // confidence must be 'manual' — claiming 'medium' confidence on a null
    // value is contradictory. m2 will overwrite with actual confidence based
    // on LLM result.
    const source = { kind: 'llm', subclass: cls.subclass, status: 'pending' };
    return {
      ...base,
      suggested_value: null,
      confidence: 'manual',
      source,
      source_ref: toSourceRefString(source),
    };
  }

  // Unknown — caller routes to manual
  const source = { kind: 'unclassified', status: 'pending' };
  return {
    ...base,
    suggested_value: null,
    confidence: 'manual',
    source,
    source_ref: toSourceRefString(source),
  };
}

export { toSourceRefString };
