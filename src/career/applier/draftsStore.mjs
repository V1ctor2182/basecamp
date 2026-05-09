// drafts/{jobId}.json store — schema + atomic CRUD.
//
// 07-applier/01-mode1-simplify-hybrid m1.
//
// Pure-Node ESM module. No HTTP, no UI, no LLM. Provides the canonical
// drafts/{jobId}.json shape + atomic file writes. Mirrors applications/
// store.mjs (08/01-application-state) but much simpler:
//
//   - drafts are throwaway — `latest replaces` semantics, no state machine
//   - 1:1 with jobId (no YYYYMMDD suffix; per-job rather than per-day)
//   - the file is gitignored (sensitive — contains user's actual answers)
//
// In-process Node single-threading + POSIX-atomic rename are the durability
// story for m1. m3 endpoint will optionally serialize via a mutex if HTTP-
// concurrent draft regen turns out to be a real concern (low priority —
// users typically draft one job at a time).

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// ── Constants ───────────────────────────────────────────────────────────

export const CAREER_DIR = path.resolve('data', 'career');
export const DRAFTS_DIR = path.join(CAREER_DIR, 'drafts');

// Same 12-hex jobId regex used elsewhere in the project. drafts are 1:1
// with jobId — no date suffix (latest replaces).
export const JOB_ID_RE = /^[a-f0-9]{12}$/;

export const FIELD_CLASSES = Object.freeze(['hard', 'legal', 'open', 'file']);
export const CONFIDENCE_TIERS = Object.freeze(['high', 'medium', 'low']);

// ── Zod schemas ─────────────────────────────────────────────────────────

export const DraftFieldSchema = z
  .object({
    label: z.string().min(1).max(200),
    class: z.enum(FIELD_CLASSES),
    suggested_value: z.string().max(4000),
    confidence: z.enum(CONFIDENCE_TIERS),
    // source_ref is optional — useful for legal/file fields where the
    // value comes from a known source (legal.yml key / output PDF path)
    source_ref: z.string().max(200).optional(),
  })
  .strict();

export const DraftSchema = z
  .object({
    jobId: z.string().regex(JOB_ID_RE, 'jobId must match 12-hex'),
    fields: z.array(DraftFieldSchema).min(1).max(50),
    generated_at: z.string().datetime({ offset: true }),
    model: z.string().min(1),
    cost_usd: z.number().nonnegative().finite(),
  })
  .strict();

// ── Atomic file I/O ─────────────────────────────────────────────────────

async function atomicWriteJson(file, data) {
  if (!existsSync(DRAFTS_DIR)) await fs.mkdir(DRAFTS_DIR, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

function draftPath(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  return path.join(DRAFTS_DIR, `${jobId}.json`);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Read a draft by jobId. Returns null when no draft exists for this job
 * (ENOENT). Throws on JSON parse errors and on schema-validation failures
 * (the caller can decide to delete + regenerate).
 */
export async function readDraft(jobId) {
  const file = draftPath(jobId);
  if (!existsSync(file)) return null;
  const raw = await fs.readFile(file, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`drafts/${jobId}.json is not valid JSON: ${e.message}`);
  }
  return DraftSchema.parse(parsed);
}

/**
 * Persist a draft atomically. The draft's jobId field MUST match the
 * filename's jobId (caller-side defense — the runner produces both
 * together). Throws ZodError on schema violation; caller decides
 * whether to surface as 4xx or 5xx.
 */
export async function writeDraft(jobId, draft) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  if (!draft || typeof draft !== 'object') {
    throw new TypeError('writeDraft requires a draft object');
  }
  if (draft.jobId !== jobId) {
    throw new Error(
      `writeDraft jobId mismatch: arg=${jobId} vs draft.jobId=${draft.jobId}`
    );
  }
  const validated = DraftSchema.parse(draft);
  await atomicWriteJson(draftPath(jobId), validated);
  return validated;
}

/**
 * Delete a draft. Idempotent — ENOENT is swallowed.
 */
export async function deleteDraft(jobId) {
  const file = draftPath(jobId);
  await fs.unlink(file).catch((e) => {
    if (e?.code !== 'ENOENT') throw e;
  });
}

/**
 * Returns the list of jobIds with persisted drafts (regex-filtered to
 * exclude orphan / temp / unrelated files). Returns [] when DRAFTS_DIR
 * doesn't yet exist.
 */
export async function listDraftJobIds() {
  if (!existsSync(DRAFTS_DIR)) return [];
  const files = await fs.readdir(DRAFTS_DIR);
  const ids = [];
  for (const f of files) {
    const m = f.match(/^([a-f0-9]{12})\.json$/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
