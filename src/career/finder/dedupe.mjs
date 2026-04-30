// scan-history.jsonl: append-only ledger of every Job.id we have ever seen.
// Used to skip duplicates across scans. Never rotated.
//
// Format (one record per line):
//   {"id": "abc123def456", "seen_at": "2026-04-30T12:34:56.000Z"}
//
// Resilience: malformed / blank lines are skipped with a console.warn so a
// single corrupted line doesn't tank dedupe for the whole scan.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const SCAN_HISTORY_FILE = path.join(CAREER_DIR, 'scan-history.jsonl');

export async function loadSeenSet(file = SCAN_HISTORY_FILE) {
  const seen = new Set();
  if (!existsSync(file)) return seen;
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      console.warn(`[dedupe] scan-history line ${lineNo} unparseable, skipping`);
      continue;
    }
    if (obj && typeof obj.id === 'string' && obj.id.length > 0) {
      seen.add(obj.id);
    }
  }
  return seen;
}

// Partition jobs into { new, duplicates } using an in-memory Set load. Pure —
// does not write. Use markIdsAsSeen() to commit IDs after the scan persists
// pipeline.json + archive.jsonl.
export async function dedupeJobs(jobs) {
  const seen = await loadSeenSet();
  const newJobs = [];
  const duplicates = [];
  for (const j of jobs) {
    if (typeof j?.id !== 'string') {
      // No id (shouldn't happen post-normalize) → treat as new but log.
      console.warn('[dedupe] job missing id, treating as new');
      newJobs.push(j);
      continue;
    }
    if (seen.has(j.id)) duplicates.push(j);
    else newJobs.push(j);
  }
  return { new: newJobs, duplicates, seenCount: seen.size };
}

// Append-only commit. Caller passes the IDs of jobs that should be marked seen
// for FUTURE scans. We append a JSONL line per id; duplicates within ids are
// not deduplicated here (caller should pass unique). Atomic enough for an
// append-only log on a single machine.
export async function markIdsAsSeen(ids, file = SCAN_HISTORY_FILE) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  if (!existsSync(CAREER_DIR)) {
    await fs.mkdir(CAREER_DIR, { recursive: true });
  }
  const ts = new Date().toISOString();
  const lines = ids
    .filter((id) => typeof id === 'string' && id.length > 0)
    .map((id) => JSON.stringify({ id, seen_at: ts }) + '\n')
    .join('');
  if (!lines) return 0;
  await fs.appendFile(file, lines);
  return lines.split('\n').length - 1;
}
