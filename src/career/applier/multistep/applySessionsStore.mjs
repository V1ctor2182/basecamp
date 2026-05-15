// apply-sessions/{jobId}.json store — schema + atomic CRUD for Mode 2
// multi-step state machine sessions.
//
// 07-applier/04-multi-step-state-machine m1.
//
// Mirrors draftsStore.mjs (01-mode1/m1) atomic-rename pattern. Per-jobId
// session captures the multi-step machine's persisted state: current
// step, total steps, per-step drafts + status, field_memory for
// cross-step value reuse, timestamps + status.
//
// Locked design (from planning):
//   - Per-step drafts live INSIDE the session JSON, NOT as separate
//     drafts/{jobId}-step{N}.json files. drafts/{jobId}.json stays
//     1:1 with jobId for Mode 1 compatibility.
//   - 24h abandon detection is LAZY: readSession() checks
//     last_activity_at age; if > 24h and status='active', returns the
//     session with status='abandoned' (does NOT write back — caller
//     decides whether to persist or resume).
//   - writeSession() automatically bumps last_activity_at on every
//     update so 30-min idle detection works downstream.
//   - JSON-friendly storage: Map<...> values are serialized as plain
//     objects; Zod schemas use z.record() to validate.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// ── Constants ───────────────────────────────────────────────────────────

export const CAREER_DIR = path.resolve('data', 'career');
export const APPLY_SESSIONS_DIR = path.join(CAREER_DIR, 'apply-sessions');

// Same 12-hex jobId regex used by drafts + pipeline.
export const JOB_ID_RE = /^[a-f0-9]{12}$/;

export const SITE_ADAPTERS = Object.freeze([
  'workday',
  'icims',
  'successfactors',
  'generic',
]);

export const SESSION_STATUSES = Object.freeze([
  'active',
  'paused',
  'abandoned',
  'completed',
]);

export const PER_STEP_STATUSES = Object.freeze([
  'pending',
  'filled',
  'skipped',
  'approved',
]);

// 24 hours; sessions idle longer than this become 'abandoned' on read.
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

// ── Zod schemas ─────────────────────────────────────────────────────────

// A per-step draft fragment — kept structurally similar to DraftField
// (01-mode1/draftsStore) but RELAXED: m3 stores the in-progress draft
// here BEFORE schema-strict DraftSchema validation. The final approved
// per-step result will be merged into drafts/{jobId}.json once the
// machine completes.
// M2 fix from review: .catchall() instead of .passthrough() — still
// accepts classifier extras (subclass / source / cost_usd / used) for
// forward-compat, but bounds each extra's size/type so a buggy classifier
// can't balloon the session JSON.
const PerStepDraftFieldSchema = z
  .object({
    refId: z.string().optional(),
    label: z.string().max(400),
    class: z.string(),
    suggested_value: z.string().max(8000).nullable().optional(),
    confidence: z.string().optional(),
    source_ref: z.string().max(400).optional(),
  })
  .catchall(
    z.union([
      z.string().max(2000),
      z.number(),
      z.boolean(),
      z.null(),
      // Allow nested source object {kind,key,status,...} as a shallow record
      z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
    ]),
  );

const PerStepDraftSchema = z
  .object({
    step_idx: z.number().int().nonnegative(),
    fields: z.array(PerStepDraftFieldSchema).max(50),
    captured_at: z.string().datetime({ offset: true }),
  })
  .strict();

// M1 fix from review: cap field_memory + per_step entries.
// 50 steps × 50 fields = 2500 entries upper bound for an extreme flow;
// 500 field_memory entries is 3× safety margin over the ~150 distinct
// fields seen in real Workday flows.
const FIELD_MEMORY_MAX_ENTRIES = 500;
const MAX_STEPS_IN_SESSION = 50;

export const ApplySessionSchema = z
  .object({
    jobId: z.string().regex(JOB_ID_RE, 'jobId must match 12-hex'),
    site_adapter: z.enum(SITE_ADAPTERS),
    job_url: z.string().url(),
    current_step: z.number().int().nonnegative(),
    // null when probing exploratory (no progressbar / sidebar)
    total_steps: z.number().int().min(1).nullable(),
    // step idx (as string key) → draft fragment
    per_step_draft: z
      .record(z.string(), PerStepDraftSchema)
      .refine(
        (r) => Object.keys(r).length <= MAX_STEPS_IN_SESSION,
        `per_step_draft cap is ${MAX_STEPS_IN_SESSION} entries`,
      ),
    // step idx (as string key) → status enum
    per_step_status: z
      .record(z.string(), z.enum(PER_STEP_STATUSES))
      .refine(
        (r) => Object.keys(r).length <= MAX_STEPS_IN_SESSION,
        `per_step_status cap is ${MAX_STEPS_IN_SESSION} entries`,
      ),
    // memory key (lookupKey or normalized name) → value
    field_memory: z
      .record(z.string(), z.string().max(4000))
      .refine(
        (r) => Object.keys(r).length <= FIELD_MEMORY_MAX_ENTRIES,
        `field_memory cap is ${FIELD_MEMORY_MAX_ENTRIES} entries`,
      ),
    started_at: z.string().datetime({ offset: true }),
    last_activity_at: z.string().datetime({ offset: true }),
    status: z.enum(SESSION_STATUSES),
  })
  .strict()
  // L3 fix from review: current_step <= total_steps invariant when known
  .refine(
    (s) => s.total_steps == null || s.current_step <= s.total_steps,
    { message: 'current_step must be ≤ total_steps when total_steps is known' },
  );

// ── Atomic file I/O ─────────────────────────────────────────────────────

async function atomicWriteJson(file, data) {
  if (!existsSync(APPLY_SESSIONS_DIR)) {
    await fs.mkdir(APPLY_SESSIONS_DIR, { recursive: true });
  }
  // H1 fix from review: 4-byte random suffix prevents tmp-name collision
  // when two writes fire in the same millisecond on the same jobId.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// H2 fix from review: per-jobId in-process mutex so read-modify-write
// sequences (m3 step transitions, m4 pause endpoint) serialize their
// writes. Atomic rename guarantees the FILE never corrupts, but doesn't
// guarantee logical compare-and-swap across racing writers. The mutex
// is single-Node-process scope (matches our deployment); multi-process
// callers would need filesystem locks.
const _sessionLocks = new Map(); // jobId → tail Promise

/**
 * Run `fn` under the session's write lock. Returns fn's result. The lock
 * is keyed by jobId so different jobs run in parallel.
 *
 * @param {string} jobId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withSessionLock(jobId, fn) {
  const prev = _sessionLocks.get(jobId) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  const newTail = prev.then(() => next);
  _sessionLocks.set(jobId, newTail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if no one queued after us (avoids unbounded growth)
    if (_sessionLocks.get(jobId) === newTail) {
      _sessionLocks.delete(jobId);
    }
  }
}

function sessionPath(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  return path.join(APPLY_SESSIONS_DIR, `${jobId}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Build a fresh ApplySession draft with sensible defaults. Caller writes
 * via writeSession(). Useful for the m3 INIT transition.
 *
 * @param {object} args
 * @param {string} args.jobId — 12-hex
 * @param {string} args.jobUrl
 * @param {string} args.siteAdapter — one of SITE_ADAPTERS
 * @param {number|null} [args.totalSteps=null]
 * @returns {object} unwritten ApplySession-shaped object
 */
export function buildInitialSession({ jobId, jobUrl, siteAdapter, totalSteps = null }) {
  const ts = nowIso();
  return {
    jobId,
    site_adapter: siteAdapter,
    job_url: jobUrl,
    current_step: 0,
    total_steps: totalSteps,
    per_step_draft: {},
    per_step_status: {},
    field_memory: {},
    started_at: ts,
    last_activity_at: ts,
    status: 'active',
  };
}

/**
 * Read a session by jobId.
 *
 * Returns null when the file doesn't exist. Throws on JSON parse errors
 * and Zod validation failures (caller decides whether to delete + restart).
 *
 * Lazy abandon detection: if status='active' AND last_activity_at is
 * older than ABANDON_AFTER_MS, the returned session has status set to
 * 'abandoned'. The file on disk is NOT mutated — the caller (e.g. resume
 * flow in m4) decides whether to write the new status back or resurrect
 * the session.
 *
 * @param {string} jobId
 * @param {{ now?: () => Date }} [opts] — `now` injectable for tests
 * @returns {Promise<object|null>}
 */
export async function readSession(jobId, opts = {}) {
  const file = sessionPath(jobId);
  if (!existsSync(file)) return null;
  const raw = await fs.readFile(file, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`apply-sessions/${jobId}.json is not valid JSON: ${e.message}`);
  }
  const session = ApplySessionSchema.parse(parsed);

  // Lazy abandon: only flip 'active' → 'abandoned'. Paused / completed /
  // already-abandoned sessions are returned as-is regardless of age.
  if (session.status === 'active') {
    const now = (opts.now ? opts.now() : new Date()).getTime();
    const lastActivity = new Date(session.last_activity_at).getTime();
    if (Number.isFinite(lastActivity) && now - lastActivity > ABANDON_AFTER_MS) {
      return { ...session, status: 'abandoned' };
    }
  }
  return session;
}

/**
 * Persist a session atomically. Bumps last_activity_at to now UNLESS the
 * caller passes {bumpActivity:false}.
 *
 * The session's jobId field MUST match the filename's jobId. Validates
 * via ApplySessionSchema before write; throws ZodError on violation.
 *
 * **Concurrency**: writeSession is LAST-WRITE-WINS at the file level
 * (atomic rename guarantees no partial file but no logical compare-and-
 * swap). Callers doing read-modify-write (m3 step transitions, m4 pause
 * endpoint) MUST serialize via `withSessionLock(jobId, async () => ...)`
 * to avoid lost updates.
 *
 * **Aliasing**: the returned object is the Zod-parsed validation result.
 * Nested records and arrays share references with the input — caller-
 * held copies will reflect subsequent mutations. Defensive-clone if you
 * need a frozen snapshot.
 *
 * **bumpActivity:false escape hatch** — ONLY legitimate uses:
 *   1. Test fixtures backdating activity timestamps
 *   2. Migration tools restoring exact prior state
 *   3. Persisting a synthetic abandoned-read without bumping
 * Never use in normal write paths — breaks the 24h-abandon contract.
 *
 * @param {string} jobId
 * @param {object} session
 * @param {{ bumpActivity?: boolean }} [opts]
 * @returns {Promise<object>} the validated, written session
 */
export async function writeSession(jobId, session, opts = {}) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  if (!session || typeof session !== 'object') {
    throw new TypeError('writeSession requires a session object');
  }
  if (session.jobId !== jobId) {
    throw new Error(
      `writeSession jobId mismatch: arg=${jobId} vs session.jobId=${session.jobId}`,
    );
  }
  const bumpActivity = opts.bumpActivity !== false;
  // H3 fix from review: bumping activity on an 'abandoned' session is
  // almost certainly a caller bug — they either meant to flip status
  // back to 'active' first (resume flow) OR they meant {bumpActivity:
  // false} (persist the synthetic abandoned-read). Without this guard
  // we'd create a "ghost session": status='abandoned' but recent
  // activity_at, which readSession's 24h check ignores, so the session
  // stays dead forever despite fresh writes.
  if (bumpActivity && session.status === 'abandoned') {
    throw new Error(
      `writeSession refuses to bump activity on status='abandoned' session ${jobId}. ` +
        `Either flip session.status to 'active' (resume) or pass {bumpActivity:false} ` +
        `(persist the abandoned status with its existing timestamp).`,
    );
  }
  const toWrite = bumpActivity
    ? { ...session, last_activity_at: nowIso() }
    : session;
  const validated = ApplySessionSchema.parse(toWrite);
  await atomicWriteJson(sessionPath(jobId), validated);
  return validated;
}

/**
 * Delete a session. ENOENT is swallowed (idempotent). Other errors
 * (EACCES, EBUSY, EPERM) are rethrown — m4 endpoint should distinguish
 * 'gone' from 'permission denied' when surfacing to the client.
 */
export async function deleteSession(jobId) {
  const file = sessionPath(jobId);
  await fs.unlink(file).catch((e) => {
    if (e?.code !== 'ENOENT') throw e;
  });
}

/**
 * Return the list of jobIds that have persisted sessions (regex-filtered),
 * sorted lexicographically (L1 fix: deterministic order across platforms;
 * readdir order is filesystem-dependent). Returns [] when
 * APPLY_SESSIONS_DIR doesn't yet exist.
 */
export async function listSessionJobIds() {
  if (!existsSync(APPLY_SESSIONS_DIR)) return [];
  const files = await fs.readdir(APPLY_SESSIONS_DIR);
  const ids = [];
  for (const f of files) {
    const m = f.match(/^([a-f0-9]{12})\.json$/);
    if (m) ids.push(m[1]);
  }
  return ids.sort();
}
