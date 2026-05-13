// identity.yml lookup — resolves Hard-class lookupKeys to actual values.
//
// 07-applier/03-field-classifier m1.
//
// Schema (data/career/identity.yml — already shipped by 02-profile/01):
//   name: <full name>
//   email: <email>
//   phone: <phone>
//   links:
//     linkedin: <url>
//     github: <url>
//     portfolio: <url>
//   location:
//     current_city: <city>
//     current_country: <country>
//
// Dot-path lookups handle the nested keys. Special syntax for split
// (name.split[0] / name.split[-1]) handles first/last name without
// requiring identity.yml to have separate first_name/last_name fields.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const IDENTITY_PATH = path.resolve('data', 'career', 'identity.yml');

let _cachedPromise = null;

/**
 * Load + cache identity.yml. Returns parsed object. M5 fix from review:
 * cache the PROMISE not the resolved value — eliminates the race where
 * two concurrent callers both see _cached=null and both fs.readFile.
 *
 * L5 fix: wrap yaml.load in try/catch with the file path for better
 * error messages on malformed YAML.
 */
export async function loadIdentity() {
  if (_cachedPromise) return _cachedPromise;
  _cachedPromise = (async () => {
    const raw = await fs.readFile(IDENTITY_PATH, 'utf8');
    try {
      return yaml.load(raw) || {};
    } catch (err) {
      _cachedPromise = null; // allow retry after caller fixes the YAML
      throw new Error(
        `identityLookup: failed to parse ${IDENTITY_PATH}: ${err.message}`,
        { cause: err },
      );
    }
  })();
  return _cachedPromise;
}

/** Test helper — clear the cache so smoke can re-load after mutating */
export function _resetCache() {
  _cachedPromise = null;
}

/**
 * Resolve a dot-path against an object.
 *
 *   resolveDotPath({a:{b:'x'}}, 'a.b') === 'x'
 *   resolveDotPath({n:'A B'}, 'n.split[0]') === 'A'
 *   resolveDotPath({n:'A B C'}, 'n.split[-1]') === 'C'
 *   resolveDotPath({a:{b:null}}, 'a.b') === null
 *   resolveDotPath({}, 'a.b') === undefined  (missing — caller distinguishes)
 */
function resolveDotPath(obj, dotPath) {
  if (!dotPath) return undefined;
  // Handle special split syntax first
  const splitMatch = dotPath.match(/^(.+)\.split\[(-?\d+)\]$/);
  if (splitMatch) {
    const [, basePath, idxStr] = splitMatch;
    const base = resolveDotPath(obj, basePath);
    if (typeof base !== 'string') return undefined;
    // Strip trailing/leading punctuation that breaks comma-formatted names
    // ("Watson, Mary" → ["Watson", "Mary"] not ["Watson,", "Mary"])
    const parts = base
      .split(/\s+/)
      .map((t) => t.replace(/^[,;.]+|[,;.]+$/g, ''))
      .filter(Boolean);
    // H6 fix: single-word name → return undefined for last-name lookups so
    // confidence drops to 'manual' rather than silently duplicating the
    // first name as last name (the "Cher" corruption case).
    if (parts.length < 2) {
      const idx = Number(idxStr);
      // First-name lookup on single-word name is OK (returns the word).
      // Last-name lookup (idx === -1 or any negative) → undefined.
      if (idx < 0) return undefined;
      return parts[idx];
    }
    const idx = Number(idxStr);
    const realIdx = idx < 0 ? parts.length + idx : idx;
    return parts[realIdx];
  }
  // Standard dot-path
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Look up the value for a Hard-class lookupKey.
 *
 * @param {string} lookupKey — dot-path like 'email', 'links.linkedin',
 *   'name.split[0]'. If null/undefined, returns { found:false, value:null }.
 * @returns {Promise<{ found: boolean, value: string | null }>}
 *   - found=true, value!=null: identity.yml had this field
 *   - found=false: lookupKey is null/missing → caller routes to manual
 *   - found=true, value=null: yaml has key but value is null → still manual
 */
export async function lookupHardValue(lookupKey) {
  if (!lookupKey) return { found: false, value: null };
  const identity = await loadIdentity();
  const raw = resolveDotPath(identity, lookupKey);
  if (raw == null) return { found: false, value: null };
  // Coerce to string for caller (Mode 2 agent fills strings into form fields)
  const value = typeof raw === 'string' ? raw : String(raw);
  return { found: true, value };
}
