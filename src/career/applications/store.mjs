// applications.json store — schema + state machine + atomic CRUD.
//
// 08-human-gate-tracker/01-application-state m1.
//
// Pure-Node ESM module. No HTTP, no UI. Provides the canonical
// applications.json shape, a frozen state-machine map, atomic file writes
// (write-to-.tmp + rename, same pattern as scanRunner.atomicWriteJson),
// and three high-level helpers:
//
//   upsertApplication(partial)  — idempotent: existing rows w/ status>=Evaluated no-op
//   transitionStatus(id, newStatus, note?)  — validates transition + appends timeline event
//   appendTimelineEvent(id, event)  — free-form events (correction/note); enforces
//                                     append-only invariant (no backdated ts)
//
// In-process Node single-threading + POSIX-atomic rename are the durability
// story for this milestone. The m2 endpoints add applicationsMutex on top
// for HTTP-level concurrent serialization.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// ── Constants ───────────────────────────────────────────────────────────

export const CAREER_DIR = path.resolve('data', 'career');
export const APPLICATIONS_FILE = path.join(CAREER_DIR, 'applications.json');

// id format: {jobId 12-hex}-{YYYYMMDD}. The jobId regex is the same one used
// elsewhere in the project (defense-in-depth for path-style consumers later).
export const APPLICATION_ID_RE = /^[a-f0-9]{12}-\d{8}$/;

export const STATUS_VALUES = Object.freeze([
  'Evaluated',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Rejected',
  'Discarded',
  'SKIP',
]);

export const LEGITIMACY_VALUES = Object.freeze([
  'High Confidence',
  'Proceed with Caution',
  'Suspicious',
  'Unknown',
]);

// State machine. Discarded + SKIP are reachable from EVERY non-terminal status
// per spec constraint #1. Discarded is fully terminal (no transitions out).
// SKIP allows transition to Discarded so the user can archive a skipped row.
// Offer→Rejected is allowed for the "declined offer" scenario.
export const VALID_TRANSITIONS = Object.freeze({
  Evaluated: Object.freeze(['Applied', 'Discarded', 'SKIP']),
  Applied: Object.freeze(['Responded', 'Discarded', 'SKIP']),
  Responded: Object.freeze(['Interview', 'Rejected', 'Discarded', 'SKIP']),
  Interview: Object.freeze(['Offer', 'Rejected', 'Discarded', 'SKIP']),
  Offer: Object.freeze(['Rejected', 'Discarded']),
  Rejected: Object.freeze(['Discarded']),
  Discarded: Object.freeze([]),
  SKIP: Object.freeze(['Discarded']),
});

// Numeric rank used by upsertApplication's idempotency check. Re-running
// Stage B on an already-Applied / -Interview / -Offer job MUST NOT reset
// the row back to Evaluated. Discarded/SKIP get a high rank so re-eval
// also doesn't resurrect archived rows.
export const STATUS_RANK = Object.freeze({
  Evaluated: 0,
  Applied: 1,
  Responded: 2,
  Interview: 3,
  Offer: 4,
  Rejected: 5,
  Discarded: 99,
  SKIP: 99,
});

// Free-form timeline events (besides the auto-emitted 'status_changed' /
// 'created'). Bounded so the JSON file doesn't accumulate noise.
export const TIMELINE_EVENT_TYPES = Object.freeze([
  'created',
  'status_changed',
  'correction',
  'note',
  'followup_set',
  'followup_cleared',
]);

// ── Errors ──────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(message, { current_status, allowed_next } = {}) {
    super(message);
    this.name = 'InvalidTransitionError';
    this.current_status = current_status;
    this.allowed_next = allowed_next ?? [];
  }
}

export class ApplicationNotFoundError extends Error {
  constructor(id) {
    super(`Application not found: ${id}`);
    this.name = 'ApplicationNotFoundError';
    this.id = id;
  }
}

export class TimelineOrderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimelineOrderError';
  }
}

// ── Zod schemas ─────────────────────────────────────────────────────────

export const TimelineEventSchema = z
  .object({
    ts: z.string().datetime({ offset: true }), // ISO with timezone
    event: z.enum(TIMELINE_EVENT_TYPES),
    note: z.string().max(1000).optional(),
    from: z.enum(STATUS_VALUES).optional(),
    to: z.enum(STATUS_VALUES).optional(),
  })
  .strict();

export const FollowupSchema = z
  .object({
    nextAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const ApplicationSchema = z
  .object({
    id: z.string().regex(APPLICATION_ID_RE, 'id must match {jobId}-{YYYYMMDD}'),
    company: z.string().min(1),
    role: z.string().min(1),
    url: z.string(),
    score: z.number().nullable(),
    status: z.enum(STATUS_VALUES),
    legitimacy: z.enum(LEGITIMACY_VALUES).default('Unknown'),
    reportPath: z.string().nullable(),
    pdfPath: z.string().nullable(),
    resumeId: z.string().nullable(),
    timeline: z.array(TimelineEventSchema).min(1),
    followup: FollowupSchema.optional(),
  })
  .strict();

export const ApplicationsArraySchema = z.array(ApplicationSchema);

// ── Atomic file I/O ─────────────────────────────────────────────────────

async function atomicWriteJson(file, data) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function readApplications() {
  if (!existsSync(APPLICATIONS_FILE)) return [];
  const raw = await fs.readFile(APPLICATIONS_FILE, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`applications.json is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('applications.json must be a top-level array');
  }
  return ApplicationsArraySchema.parse(parsed);
}

export async function writeApplications(arr) {
  const validated = ApplicationsArraySchema.parse(arr);
  await atomicWriteJson(APPLICATIONS_FILE, validated);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function findById(arr, id) {
  return arr.findIndex((row) => row && row.id === id);
}

// Build a creation timeline event. Used by upsertApplication when inserting.
function makeCreationEvent(note) {
  const ev = { ts: nowIso(), event: 'created' };
  if (typeof note === 'string' && note.trim()) ev.note = note.slice(0, 1000);
  return ev;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Idempotent upsert. If a row with the same id already exists AND its
 * STATUS_RANK >= 'Evaluated' (i.e. anything ≥ 0, which is everything),
 * return the existing row unchanged — Stage B re-runs MUST NOT reset
 * user-set later states (Applied, Interview, Offer, …) back to Evaluated.
 *
 * Caller passes a partial Application (status defaults to 'Evaluated' if
 * absent; legitimacy defaults to 'Unknown'; nullable fields default null;
 * timeline is auto-populated with a single 'created' event).
 *
 * Special field: `partial.creationNote` (optional string, ≤1000 chars)
 * becomes the `note` on the auto-emitted 'created' timeline event. This
 * is consumed before ApplicationSchema.parse runs, so it never appears
 * on the persisted row. Use it to capture the upsert origin
 * (e.g. 'auto-inserted by Stage B').
 *
 * NOT concurrent-safe at the in-process level: read-modify-write across
 * two awaits. Caller must serialize (m2 endpoints use applicationsMutex).
 *
 * Returns the resulting row (existing-untouched on idempotent hit, or the
 * newly-created row).
 */
export async function upsertApplication(partial) {
  if (!partial || typeof partial !== 'object') {
    throw new TypeError('upsertApplication requires an object argument');
  }
  if (typeof partial.id !== 'string' || !APPLICATION_ID_RE.test(partial.id)) {
    throw new TypeError(
      `upsertApplication: id must match ${APPLICATION_ID_RE} (got ${partial.id})`
    );
  }

  const arr = await readApplications();
  const idx = findById(arr, partial.id);

  if (idx !== -1) {
    const existing = arr[idx];
    const rank = STATUS_RANK[existing.status] ?? 0;
    // Anything >= 0 (Evaluated and beyond) — every valid status — preserves.
    // The contract is: once a row exists, upsert is a no-op. Edits go through
    // transitionStatus / appendTimelineEvent.
    if (rank >= STATUS_RANK.Evaluated) return existing;
  }

  const candidate = {
    id: partial.id,
    company: partial.company ?? '',
    role: partial.role ?? '',
    url: partial.url ?? '',
    score: typeof partial.score === 'number' ? partial.score : null,
    status: partial.status ?? 'Evaluated',
    legitimacy: partial.legitimacy ?? 'Unknown',
    reportPath: partial.reportPath ?? null,
    pdfPath: partial.pdfPath ?? null,
    resumeId: partial.resumeId ?? null,
    timeline: [makeCreationEvent(partial.creationNote)],
    ...(partial.followup ? { followup: partial.followup } : {}),
  };

  // Validate before insert so a malformed candidate fails loudly here, not on
  // the next read. Caller-friendly error.
  const validated = ApplicationSchema.parse(candidate);

  if (idx === -1) {
    arr.push(validated);
  } else {
    // Idempotency check above would have returned; reaching here means the
    // existing row's status was somehow below Evaluated (impossible given
    // the enum), which we treat as "overwrite with new candidate".
    arr[idx] = validated;
  }
  await writeApplications(arr);
  return validated;
}

/**
 * Transition a row's status. Validates against VALID_TRANSITIONS; on legal:
 * appends a 'status_changed' timeline event {ts, event, from, to, note?} and
 * persists atomically. Throws InvalidTransitionError on illegal transitions
 * (with current_status + allowed_next on the error so the m2 endpoint can
 * return a structured 400 to clients).
 *
 * NOT concurrent-safe at the in-process level: read-modify-write across
 * two awaits. Caller must serialize (m2 endpoints use applicationsMutex).
 */
export async function transitionStatus(id, newStatus, note) {
  if (typeof id !== 'string' || !APPLICATION_ID_RE.test(id)) {
    throw new TypeError(`transitionStatus: invalid id ${id}`);
  }
  if (!STATUS_VALUES.includes(newStatus)) {
    throw new TypeError(`transitionStatus: unknown status ${newStatus}`);
  }
  const arr = await readApplications();
  const idx = findById(arr, id);
  if (idx === -1) throw new ApplicationNotFoundError(id);
  const row = arr[idx];
  const allowed = VALID_TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new InvalidTransitionError(
      `Illegal transition ${row.status} → ${newStatus}`,
      { current_status: row.status, allowed_next: [...allowed] }
    );
  }
  const event = {
    ts: nowIso(),
    event: 'status_changed',
    from: row.status,
    to: newStatus,
  };
  if (typeof note === 'string' && note.trim()) {
    event.note = note.slice(0, 1000);
  }
  const updated = { ...row, status: newStatus, timeline: [...row.timeline, event] };
  // Validate before write — paranoia, since we constructed this ourselves.
  const validated = ApplicationSchema.parse(updated);
  arr[idx] = validated;
  await writeApplications(arr);
  return validated;
}

/**
 * Append a free-form timeline event (correction, note, followup_set, etc.).
 * Enforces the append-only invariant: the new event's ts must be >= the last
 * event's ts. Backdated events throw TimelineOrderError.
 *
 * Reserved events emitted internally are NOT user-appendable — this helper
 * rejects 'status_changed' (use transitionStatus) and 'created' (emitted by
 * upsertApplication exactly once per row).
 *
 * NOT concurrent-safe at the in-process level: read-modify-write across
 * two awaits. Caller must serialize (m2 endpoints use applicationsMutex).
 */
export async function appendTimelineEvent(id, event) {
  if (typeof id !== 'string' || !APPLICATION_ID_RE.test(id)) {
    throw new TypeError(`appendTimelineEvent: invalid id ${id}`);
  }
  // Validate event shape early (also normalizes types).
  const parsed = TimelineEventSchema.parse(event);
  if (parsed.event === 'status_changed' || parsed.event === 'created') {
    throw new TypeError(
      `appendTimelineEvent: '${parsed.event}' events are emitted internally; use transitionStatus / upsertApplication`
    );
  }
  const arr = await readApplications();
  const idx = findById(arr, id);
  if (idx === -1) throw new ApplicationNotFoundError(id);
  const row = arr[idx];
  const last = row.timeline[row.timeline.length - 1];
  if (last && Date.parse(parsed.ts) < Date.parse(last.ts)) {
    throw new TimelineOrderError(
      `Append-only violation: event ts ${parsed.ts} < last event ts ${last.ts}`
    );
  }
  const updated = { ...row, timeline: [...row.timeline, parsed] };
  const validated = ApplicationSchema.parse(updated);
  arr[idx] = validated;
  await writeApplications(arr);
  return validated;
}
