// Append-only JSONL stores for the feedback flywheel.
//
// 07-applier/self-iteration/02-data-flywheel m1.
//
// Three NEW JSONL files (open-question-diffs reuses qa-bank/history.jsonl
// per OQ5):
//   data/career/feedback/field-misclassified.jsonl
//   data/career/feedback/field-edits.jsonl
//   data/career/feedback/site-failures.jsonl
//
// Atomicity contract (REVIEW C2 corrected):
//   - POSIX O_APPEND atomically reserves the file offset PER write(2),
//     but libuv's fs.appendFile can issue multiple write(2) syscalls for
//     buffers larger than the kernel's atomic-write bound (PIPE_BUF is
//     512 on macOS, 4096 on Linux — and PIPE_BUF strictly governs pipes,
//     not regular files). Our records can reach ~17 KB (8000 suggested +
//     8000 user_final), well above any atomicity bound.
//   - Concurrent fs.appendFile calls run in libuv's thread pool — they
//     do NOT serialize at the Node event-loop boundary. Two parallel
//     recordX writes can interleave bytes mid-line, corrupting JSONL.
//   - Single Node process; no cross-process concern. The fix is an
//     in-process async mutex keyed by filename — appendJsonl chains
//     each write on the previous one. Smoke verifies 200 concurrent
//     records survive without corruption.
//
// Lazy-create:
//   - Parent dir mkdir'd recursively on first append (OQ4: no
//     init-career.sh change).
//   - File auto-created by fs.appendFile when missing.
//
// Read path is line-by-line streaming — never slurps the full file —
// since stats queries (m4 Learning tab) operate on 14-30 day windows
// and the file is append-only forever otherwise.

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  FieldMisclassifiedSchema,
  FieldEditSchema,
  SiteFailureSchema,
  SCHEMAS_BY_FILE,
} from './schemas.mjs';

export const FEEDBACK_DIR = path.resolve('data', 'career', 'feedback');
export const SUGGESTED_DIR = path.join(FEEDBACK_DIR, 'suggested');

const FIELD_MISCLASSIFIED = 'field-misclassified.jsonl';
const FIELD_EDITS = 'field-edits.jsonl';
const SITE_FAILURES = 'site-failures.jsonl';

// REVIEW C2 fix: per-file async mutex serializing in-process appends.
// libuv's appendFile runs in the thread pool and does NOT guarantee
// atomic byte-level ordering for records larger than the kernel's
// per-write bound. Without this mutex, two concurrent recordX calls
// could interleave bytes mid-line and corrupt JSONL.
/** @type {Map<string, Promise<void>>} */
const _writeChain = new Map();
function _serializeAppend(filename, task) {
  const prev = _writeChain.get(filename) || Promise.resolve();
  const next = prev.then(task, task);
  // Catch so a failing task doesn't poison the chain for subsequent calls.
  _writeChain.set(
    filename,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Append one validated record to the named JSONL file. Validates via
 * the registered Zod schema; throws on validation failure.
 *
 * @param {string} filename — basename like 'field-edits.jsonl'
 * @param {object} record — unvalidated record object
 * @returns {Promise<object>} the validated (defaults-applied) record
 */
export async function appendJsonl(filename, record) {
  const schema = SCHEMAS_BY_FILE[filename];
  if (!schema) {
    throw new TypeError(`appendJsonl: unknown feedback file ${JSON.stringify(filename)}`);
  }
  // Validate BEFORE serializing through the mutex — fast-fail on bad
  // input without holding up the queue.
  const validated = schema.parse(record);
  const target = path.join(FEEDBACK_DIR, filename);
  // REVIEW C2 fix: serialize concurrent writes via per-file mutex.
  // JSON.stringify always escapes embedded newlines as \\n, so the
  // record is guaranteed to fit on one line regardless of input.
  // \n terminator ensures each record is independently parseable.
  await _serializeAppend(filename, async () => {
    await fs.mkdir(FEEDBACK_DIR, { recursive: true });
    await fs.appendFile(target, JSON.stringify(validated) + '\n', 'utf8');
  });
  return validated;
}

/**
 * Stream the named JSONL file line-by-line. Yields validated records
 * (silently drops malformed lines so a corrupt entry from a crashed
 * write doesn't poison downstream stats).
 *
 * @param {string} filename
 * @param {{ filter?: (record: object) => boolean, since?: number, limit?: number }} opts
 *   - filter: predicate; record yielded only when filter returns truthy
 *   - since: only yield records with ts >= since (millis epoch)
 *   - limit: stop after N yielded records
 * @returns {AsyncGenerator<object>}
 */
export async function* readJsonl(filename, opts = {}) {
  const schema = SCHEMAS_BY_FILE[filename];
  if (!schema) {
    throw new TypeError(`readJsonl: unknown feedback file ${JSON.stringify(filename)}`);
  }
  const target = path.join(FEEDBACK_DIR, filename);
  try {
    await fs.access(target);
  } catch {
    return; // file doesn't exist → empty stream
  }
  const { filter, since, limit } = opts;
  const sinceMs = typeof since === 'number' ? since : null;
  let yielded = 0;
  const rl = readline.createInterface({
    input: createReadStream(target, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // skip malformed line
      }
      const result = schema.safeParse(parsed);
      if (!result.success) continue; // skip schema-invalid
      const record = result.data;
      if (sinceMs !== null && Date.parse(record.ts) < sinceMs) continue;
      if (filter && !filter(record)) continue;
      yield record;
      yielded += 1;
      if (typeof limit === 'number' && yielded >= limit) {
        rl.close();
        return;
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Count records grouped by a key. For m2's threshold detection
 * (≥5 same-site misclassifications, ≥5 same-domain failures).
 *
 * @param {string} filename
 * @param {(record: object) => string|null} groupKey — null skips the record
 * @param {{ since?: number }} opts
 * @returns {Promise<Map<string, number>>}
 */
export async function countByGroup(filename, groupKey, opts = {}) {
  const counts = new Map();
  for await (const record of readJsonl(filename, { since: opts.since })) {
    const key = groupKey(record);
    if (key == null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// ── Typed wrappers ────────────────────────────────────────────────────

/**
 * Record a field-misclassified event. No automatic caller in m1 — UI
 * reclassify endpoint TBD in a later room. m2 induction still reads
 * the file regardless of source.
 *
 * @param {object} record — validated against FieldMisclassifiedSchema
 */
export function recordFieldMisclassified(record) {
  return appendJsonl(FIELD_MISCLASSIFIED, record);
}

/**
 * Record a field edit. Called from endpoint.mjs approve-step when the
 * user's `user_final` differs from `suggested`.
 *
 * @param {object} record — validated against FieldEditSchema
 */
export function recordFieldEdit(record) {
  return appendJsonl(FIELD_EDITS, record);
}

/**
 * Record a site failure. Called from endpoint.mjs runMachine error
 * path. `domain` is URL.hostname (or the raw URL on parse failure).
 *
 * @param {object} record — validated against SiteFailureSchema
 */
export function recordSiteFailure(record) {
  return appendJsonl(SITE_FAILURES, record);
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings. Used by the
 * approve-step capture hook to skip recording when the user accepted
 * the suggestion as-is (distance=0). O(n*m) time, O(min(n,m)) space.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  const s = a == null ? '' : String(a);
  const t = b == null ? '' : String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  // Iterate the longer dim outside; row buffer for the shorter dim.
  const [shorter, longer] = s.length <= t.length ? [s, t] : [t, s];
  const prev = new Array(shorter.length + 1);
  const curr = new Array(shorter.length + 1);
  for (let j = 0; j <= shorter.length; j++) prev[j] = j;
  for (let i = 1; i <= longer.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= shorter.length; j++) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= shorter.length; j++) prev[j] = curr[j];
  }
  return prev[shorter.length];
}

/**
 * Classify an unknown error into an ERROR_KIND. Used by the endpoint
 * error-path capture hook. Falls back to 'other' so a novel error
 * doesn't crash the recorder.
 *
 * @param {Error|string} err
 * @returns {'timeout'|'stale_ref'|'element_gone'|'classifier_error'|'machine_error'|'other'}
 */
export function classifyError(err) {
  // REVIEW H3 (adv) fix: prefer err.name (Playwright + Zod use stable
  // class names) over substring matching on .message. Substring on the
  // message accidentally matched paths like '/applier/classifier/foo.mjs'
  // → 'classifier_error' regardless of the actual root cause.
  const name = err && typeof err.name === 'string' ? err.name : '';
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (name === 'TimeoutError' || code === 'TIMEOUT' || code === 'ACTION_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'STALE_REF') return 'stale_ref';
  if (code === 'ELEMENT_GONE' || code === 'IFRAME_DETACHED' || code === 'OPTION_NOT_FOUND') {
    return 'element_gone';
  }
  if (name === 'ZodError') return 'machine_error';
  // Fall back to message substring with tightened patterns. Anchor on
  // word boundaries / underscored codes so file paths don't false-match.
  const msg = (err && err.message) || String(err || '');
  const m = msg.toLowerCase();
  if (/\baction_timeout\b|\btimeout\b/.test(m)) return 'timeout';
  if (/\bstale[_ ]?ref\b/.test(m)) return 'stale_ref';
  if (/\belement[_ ]?gone\b|\biframe[_ ]?detached\b|\boption[_ ]?not[_ ]?found\b/.test(m)) {
    return 'element_gone';
  }
  if (/\bclassifyandfill\b|\bclassifier returned\b|\bclassify-failed\b/.test(m)) {
    return 'classifier_error';
  }
  if (/\bwritesession\b|\bzoderror\b/.test(m)) return 'machine_error';
  return 'other';
}

// ── Test-only ──────────────────────────────────────────────────────────

export const _FILES = Object.freeze({
  FIELD_MISCLASSIFIED,
  FIELD_EDITS,
  SITE_FAILURES,
});
