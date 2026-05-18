// Loader for data/career/eval-fixtures/*.{html,truth.yml} pairs.
//
// 07-applier/self-iteration/01-code-calibration m1.
//
// Layout (locked m1 OQ-1: flat):
//   data/career/eval-fixtures/
//     greenhouse-anthropic.html
//     greenhouse-anthropic.truth.yml
//     lever-stripe.html
//     lever-stripe.truth.yml
//     custom-acme.html
//     custom-acme.truth.yml
//
// Pairing contract:
//   - Every `*.html` MUST have a sibling `*.truth.yml` (else: throw).
//   - Every `*.truth.yml` MUST have a sibling `*.html` (else: throw).
//   - Fixture `id` = filename stem (without extension).
//
// Caching: mirrors siteAdapters/loader.mjs pattern — per-dir signature
// over `{name}:{mtimeMs}` of every fixture file. Survives file deletion
// (vs. naive max-mtime which would serve stale registries when files
// are removed but no new ones land).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { validateGroundTruth } from './schema.mjs';

export const DEFAULT_FIXTURES_DIR = path.resolve('data', 'career', 'eval-fixtures');
export const HTML_EXT = '.html';
export const TRUTH_EXT = '.truth.yml';

/**
 * @typedef {object} Fixture
 * @property {string} id              — filename stem, e.g. 'greenhouse-anthropic'
 * @property {string} vendor          — from truth.vendor
 * @property {string} htmlPath        — absolute path to *.html
 * @property {string} truthPath       — absolute path to *.truth.yml
 * @property {string} html            — file contents (utf8)
 * @property {object} truth           — validated GroundTruth
 */

/**
 * @typedef {object} FixtureRegistry
 * @property {ReadonlyArray<Fixture>} fixtures — sorted by id alpha
 * @property {string} dir
 * @property {string} signature
 */

/** @type {Map<string, { signature: string, registry: FixtureRegistry }>} */
const _CACHE = new Map();

/**
 * Load every fixture pair in the given directory. Throws on:
 *   - orphan html without matching truth.yml
 *   - orphan truth.yml without matching html
 *   - malformed YAML or schema-invalid truth
 *
 * @param {string} [dir=DEFAULT_FIXTURES_DIR]
 * @returns {Promise<FixtureRegistry>}
 */
export async function loadFixtures(dir = DEFAULT_FIXTURES_DIR) {
  const resolvedDir = path.resolve(dir);
  // REVIEW H1 (Plan + adv) fix: single readdir pass — derive BOTH the
  // signature and the working file list from the same snapshot. Pre-fix
  // the loader called _dirSignature then re-readdir, giving a TOCTOU
  // window where captureFromUrl could write between the two reads and
  // leave the cache keyed against a different file set than was loaded.
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  const sigPieces = [];
  const htmlSet = new Set();
  const truthSet = new Set();
  for (const e of entries) {
    // REVIEW M6 (adv) fix: reject symlinks — a malicious *.truth.yml
    // symlink pointing at /etc/shadow would otherwise be silently read.
    if (e.isSymbolicLink()) {
      throw new Error(
        `loadFixtures: symlinked entries are not permitted in ${resolvedDir}: ${e.name}`,
      );
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(HTML_EXT) && !e.name.endsWith(TRUTH_EXT)) {
      // README.md / .gitkeep / screenshots — ignored AND excluded from signature.
      continue;
    }
    const st = await fs.stat(path.join(resolvedDir, e.name));
    sigPieces.push(`${e.name}:${st.size}:${st.mtimeMs}`);
    if (e.name.endsWith(TRUTH_EXT)) {
      truthSet.add(e.name.slice(0, -TRUTH_EXT.length));
    } else {
      htmlSet.add(e.name.slice(0, -HTML_EXT.length));
    }
  }
  sigPieces.sort();
  const signature = sigPieces.join('|');
  const cached = _CACHE.get(resolvedDir);
  if (cached && cached.signature === signature) return cached.registry;

  // Orphan detection — every html must have truth and vice versa.
  const orphanHtmls = [...htmlSet].filter((id) => !truthSet.has(id));
  const orphanTruths = [...truthSet].filter((id) => !htmlSet.has(id));
  if (orphanHtmls.length || orphanTruths.length) {
    const parts = [];
    if (orphanHtmls.length) {
      parts.push(`HTML without truth: ${orphanHtmls.map((s) => s + HTML_EXT).join(', ')}`);
    }
    if (orphanTruths.length) {
      parts.push(`truth without HTML: ${orphanTruths.map((s) => s + TRUTH_EXT).join(', ')}`);
    }
    throw new Error(`loadFixtures: orphan files in ${resolvedDir}\n  ${parts.join('\n  ')}`);
  }

  const ids = [...htmlSet].sort();
  /** @type {Fixture[]} */
  const fixtures = [];
  for (const id of ids) {
    const htmlPath = path.join(resolvedDir, id + HTML_EXT);
    const truthPath = path.join(resolvedDir, id + TRUTH_EXT);
    const [html, truthRaw] = await Promise.all([
      fs.readFile(htmlPath, 'utf8'),
      fs.readFile(truthPath, 'utf8'),
    ]);
    let parsed;
    try {
      // CORE_SCHEMA (YAML 1.2) keeps `2026-05-18` as a string instead of
      // coercing to Date, and keeps `yes`/`no` as strings instead of bool.
      // Both coercions silently broke schema validation that expects
      // strings. Authors writing dates bare (without quotes) is the norm
      // for human-edited YAMLs, so we accommodate it here.
      parsed = yaml.load(truthRaw, { schema: yaml.CORE_SCHEMA });
    } catch (err) {
      throw new Error(`loadFixtures: failed to parse ${id + TRUTH_EXT}: ${err.message}`, {
        cause: err,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Array.isArray check matters because `typeof [] === 'object'` in JS;
      // without it a top-level YAML list slips through to Zod with a less
      // clear "expected object, received array" error.
      throw new Error(`loadFixtures: ${id + TRUTH_EXT} did not parse to an object`);
    }
    const truth = validateGroundTruth(parsed, id + TRUTH_EXT);
    fixtures.push({
      id,
      vendor: truth.vendor,
      htmlPath,
      truthPath,
      html,
      truth,
    });
  }

  const registry = Object.freeze({
    fixtures: Object.freeze(fixtures),
    dir: resolvedDir,
    signature,
  });
  _CACHE.set(resolvedDir, { signature, registry });
  return registry;
}

/**
 * Load a single fixture by id (filename stem). Convenience for the
 * capture CLI's post-write validate step.
 *
 * @param {string} id — e.g. 'greenhouse-anthropic'
 * @param {string} [dir=DEFAULT_FIXTURES_DIR]
 * @returns {Promise<Fixture>}
 */
export async function loadFixture(id, dir = DEFAULT_FIXTURES_DIR) {
  const registry = await loadFixtures(dir);
  const fx = registry.fixtures.find((f) => f.id === id);
  if (!fx) {
    throw new Error(`loadFixture: fixture ${JSON.stringify(id)} not found in ${registry.dir}`);
  }
  return fx;
}

/** Test-only — clear the per-dir cache. */
export function _clearCache() {
  _CACHE.clear();
}
