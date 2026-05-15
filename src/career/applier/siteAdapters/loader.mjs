// Loader for data/career/site-adapters/*.yml — reads + parses + validates +
// compiles adapters, returning a registry consumed by detector.mjs and m2's
// activateAdapter.
//
// 07-applier/06-site-adapters m1.
//
// Caching: keyed by the directory's max mtime across *.yml files. A second
// load with the same mtime reuses the previous registry (cheap stat-only
// check on hot path). Calls to loadAdapters with a different dir use a
// per-dir cache.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  SiteAdapterSchema,
  CommonDefaultsSchema,
  compileAdapter,
  mergeCommonDefaults,
} from './schema.mjs';

export const DEFAULT_ADAPTERS_DIR = path.resolve('data', 'career', 'site-adapters');
export const COMMON_FILE = '_common.yml';
export const DEFAULT_FILE = 'default.yml';

/**
 * REVIEW H1 fix: cache keyed by resolved path (so callers passing
 * `./data/...` vs `data/...` vs absolute path don't double-load).
 *
 * REVIEW C3 fix: cache signature is the sorted `name:mtime|...` of every
 * *.yml in the dir, not just the max mtime. Deleting / renaming files
 * with unchanged max mtime would have served stale registries forever.
 *
 * @type {Map<string, { signature: string, registry: AdapterRegistry }>}
 */
const _CACHE = new Map();

/**
 * Load all adapters from a directory. Returns an AdapterRegistry where
 * `adapters` is sorted by priority DESC (default.yml at the tail).
 *
 * @param {string} [dir=DEFAULT_ADAPTERS_DIR]
 * @returns {Promise<AdapterRegistry>}
 */
export async function loadAdapters(dir = DEFAULT_ADAPTERS_DIR) {
  const resolvedDir = path.resolve(dir);
  const signature = await _dirSignature(resolvedDir);
  const cached = _CACHE.get(resolvedDir);
  if (cached && cached.signature === signature) return cached.registry;

  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  const yamlFiles = entries
    .filter((e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')))
    .map((e) => e.name);

  // Parse _common.yml first (if present) so we can merge it into each adapter.
  let commonDefaults = null;
  if (yamlFiles.includes(COMMON_FILE)) {
    const commonRaw = await _readYaml(path.join(resolvedDir, COMMON_FILE));
    try {
      commonDefaults = CommonDefaultsSchema.parse(commonRaw);
    } catch (err) {
      throw _annotateZodError(err, COMMON_FILE);
    }
  }

  /** @type {CompiledAdapter[]} */
  const compiled = [];
  let defaultAdapter = null;

  for (const filename of yamlFiles) {
    if (filename === COMMON_FILE) continue;
    const filePath = path.join(resolvedDir, filename);
    const raw = await _readYaml(filePath);
    if (!raw || typeof raw !== 'object') {
      throw new Error(`loadAdapters: ${filename} did not parse to an object`);
    }

    // Filename ↔ id agreement check (e.g. greenhouse.yml → id: greenhouse)
    const expectedId = filename.replace(/\.(yml|yaml)$/, '');
    if (raw.id && raw.id !== expectedId) {
      throw new Error(
        `loadAdapters: ${filename} id="${raw.id}" must match filename slug "${expectedId}"`,
      );
    }

    const merged = mergeCommonDefaults(raw, commonDefaults);
    let validated;
    try {
      validated = SiteAdapterSchema.parse(merged);
    } catch (err) {
      throw _annotateZodError(err, filename);
    }
    let adapter;
    try {
      adapter = compileAdapter(validated);
    } catch (err) {
      throw new Error(`loadAdapters: ${filename} compileAdapter failed: ${err.message}`, {
        cause: err,
      });
    }

    if (adapter.id === 'default') {
      defaultAdapter = adapter;
    } else {
      compiled.push(adapter);
    }
  }

  if (!defaultAdapter) {
    throw new Error(`loadAdapters: ${DEFAULT_FILE} is required in ${resolvedDir}`);
  }

  // Priority DESC, then id alpha as a stable tiebreaker. default lives
  // outside the main array so detectSiteAdapter can fall through cleanly.
  compiled.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });

  const registry = Object.freeze({
    adapters: Object.freeze(compiled),
    default: defaultAdapter,
    common: commonDefaults,
    dir: resolvedDir,
    signature,
  });

  _CACHE.set(resolvedDir, { signature, registry });
  return registry;
}

/** Diagnostic helper — clear the cache. Test-only. */
export function _clearCache() {
  _CACHE.clear();
}

async function _readYaml(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return yaml.load(raw);
  } catch (err) {
    throw new Error(`loadAdapters: failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

// REVIEW C3 fix: build a signature over all yaml files (sorted name+mtime
// pairs) instead of just the max mtime. Deleting / renaming files with
// unchanged max mtime now correctly invalidates the cache. The signature
// is a single concatenated string so equality comparison is O(N) once.
async function _dirSignature(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const pieces = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.yml') && !e.name.endsWith('.yaml')) continue;
    const st = await fs.stat(path.join(dir, e.name));
    pieces.push(`${e.name}:${st.mtimeMs}`);
  }
  pieces.sort();
  return pieces.join('|');
}

function _annotateZodError(err, filename) {
  if (!err || err.name !== 'ZodError') return err;
  // Zod v4 exposes issues on `.issues`; older versions used `.errors`.
  // Accept either so loader stays version-tolerant.
  const issues = err.issues || err.errors || [];
  const formatted = issues
    .map((e) => `  · ${(e.path || []).join('.') || '<root>'}: ${e.message}`)
    .join('\n');
  return new Error(`loadAdapters: ${filename} schema validation failed:\n${formatted}`, {
    cause: err,
  });
}

/**
 * @typedef {object} AdapterRegistry
 * @property {ReadonlyArray<CompiledAdapter>} adapters — sorted priority DESC, excludes default
 * @property {CompiledAdapter} default — the always-match fallback
 * @property {object|null} common — parsed _common.yml or null
 * @property {string} dir
 * @property {number} mtime
 */
