// legal.yml lookup — resolves Legal-class lookupKeys to fixed answers.
//
// 07-applier/03-field-classifier m1.
//
// Schema (data/career/qa-bank/legal.yml — already shipped by 02-profile):
//   work_authorization:
//     requires_sponsorship_now: bool
//     requires_sponsorship_future: bool
//     authorized_us_yes_no: bool
//     citizenship: string
//   eeo:
//     gender / ethnicity / veteran / disability / pronouns: string
//   personal:
//     criminal_record: bool
//     relocate_willing: bool
//     can_pass_background_check: bool
//   how_did_you_hear_default: string
//
// Booleans need string normalization for Mode 2 form-filling. We coerce
// to "Yes" / "No" by default; subclasses with inverted semantics
// (felony / criminal_record where false means "no criminal record") get
// inverted phrasing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const LEGAL_PATH = path.resolve('data', 'career', 'qa-bank', 'legal.yml');

let _cachedPromise = null;

export async function loadLegal() {
  if (_cachedPromise) return _cachedPromise;
  _cachedPromise = (async () => {
    const raw = await fs.readFile(LEGAL_PATH, 'utf8');
    try {
      return yaml.load(raw) || {};
    } catch (err) {
      _cachedPromise = null;
      throw new Error(
        `legalLookup: failed to parse ${LEGAL_PATH}: ${err.message}`,
        { cause: err },
      );
    }
  })();
  return _cachedPromise;
}

export function _resetCache() {
  _cachedPromise = null;
}

function resolveDotPath(obj, dotPath) {
  if (!dotPath) return undefined;
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Coerce a raw legal.yml value to a human-readable string suitable for
 * form-filling. Booleans → "Yes"/"No". Numbers + strings → String(raw).
 *
 * NOTE on polarity (C3 fix from review): we do NOT attempt question-polarity
 * detection ("Have you NEVER been convicted?" inverts the meaning of "No").
 * legal.yml ships with field names assuming standard ATS polarity:
 *   - criminal_record: true means "I have a record" → "Yes" answers
 *     "Have you been convicted?"
 *   - relocate_willing: true → "Yes" answers "Are you willing to relocate?"
 * If an ATS uses negated phrasing, the caller must override at the
 * `eeoDefault` layer or post-process. Returns extra metadata `coercedFrom`
 * so callers can detect type-mismatch risk (e.g. boolean from yaml fed
 * into a numeric form field).
 */
function coerceLegalValue(raw) {
  if (raw == null) return { value: null, coercedFrom: null };
  if (typeof raw === 'boolean') {
    return { value: raw ? 'Yes' : 'No', coercedFrom: 'boolean' };
  }
  if (typeof raw === 'number') {
    return { value: String(raw), coercedFrom: 'number' };
  }
  return { value: String(raw), coercedFrom: 'string' };
}

/**
 * Look up the value for a Legal-class lookupKey. Falls back to eeoDefault
 * if the YAML key is missing (defensive — legal.yml ships with defaults
 * in place, so this should rarely fire).
 *
 * @param {string} lookupKey — dot-path like 'eeo.gender'
 * @param {string} [eeoDefault] — "Decline to answer" or similar
 * @returns {Promise<{ found: boolean, value: string | null, coercedFrom?: 'boolean'|'number'|'string' }>}
 */
export async function lookupLegalValue(lookupKey, eeoDefault) {
  if (!lookupKey) {
    return eeoDefault
      ? { found: true, value: eeoDefault, coercedFrom: 'string' }
      : { found: false, value: null };
  }
  const legal = await loadLegal();
  const raw = resolveDotPath(legal, lookupKey);
  if (raw == null) {
    return eeoDefault
      ? { found: true, value: eeoDefault, coercedFrom: 'string' }
      : { found: false, value: null };
  }
  const { value, coercedFrom } = coerceLegalValue(raw);
  return { found: true, value, coercedFrom };
}
