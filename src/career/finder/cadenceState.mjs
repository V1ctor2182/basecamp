// Per-source-type scan cadence state. Records last_run_at + last_outcome so
// the scheduler (05-scan-scheduler m2) can decide which types are due on
// each tick, surviving server restarts (catch-up on first tick post-boot).
//
// Cadence string format: Nh / Nm / Nd / Ns. Matches portals.yml convention.
// Malformed strings throw from parseCadence — caller decides whether to
// skip-this-key (cadenceToMs) or propagate.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const CADENCE_STATE_FILE = path.join(CAREER_DIR, 'scan-cadence-state.json');

// ── Cadence string parsing ──────────────────────────────────────────────

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

// "72h" → 259200000. Throws on malformed (no unit, bad unit, decimal, neg, zero).
// Zero is rejected because `0h` would otherwise produce cadence_ms=0, which
// isDue treats as "not eligible" → silently disables that type forever. Better
// to surface as a config error so cadenceToMs's per-key try/catch warns + skips.
export function parseCadence(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`cadence must be string, got ${typeof str}`);
  }
  const trimmed = str.trim();
  if (!trimmed) throw new Error('cadence is empty string');
  const m = trimmed.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new Error(`cadence "${str}" not in format Nh/Nm/Nd/Ns`);
  }
  const n = Number(m[1]);
  if (n === 0) throw new Error(`cadence "${str}" must be > 0`);
  // Match guarantees digits-only, so n is a positive integer.
  return n * UNIT_MS[m[2]];
}

// { greenhouse: '72h', ashby: '72h', ... } → { greenhouse: 259200000, ... }
// Per-key try/catch: a single bad cadence string warns and is skipped, so the
// scheduler doesn't lose ALL types because one was typo'd. Other keys proceed.
export function cadenceToMs(map) {
  if (!map || typeof map !== 'object') return {};
  const out = {};
  for (const [type, str] of Object.entries(map)) {
    try {
      out[type] = parseCadence(str);
    } catch (e) {
      console.warn(`[cadenceState] skipping bad cadence for ${type}: ${e.message}`);
    }
  }
  return out;
}

// ── State file I/O ──────────────────────────────────────────────────────

// Returns the per-type state map. Missing file or unparseable contents → {}.
// Never throws (state file corruption shouldn't kill the scheduler).
export async function readCadenceState(file = CADENCE_STATE_FILE) {
  if (!existsSync(file)) return {};
  try {
    const raw = await fs.readFile(file, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.warn(`[cadenceState] read failed, treating as empty: ${e.message}`);
    return {};
  }
}

// Atomic-rename write. Tmp filename includes a UUID slice so two concurrent
// writers in the same ms don't collide on tmp path.
export async function writeCadenceState(state, file = CADENCE_STATE_FILE) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Module-level promise queue serializes updateForTypes calls so concurrent
// writers can't race read-modify-write. Two scan finishers that both need to
// patch their type's row would otherwise interleave: A reads → B reads → A
// writes (A's patch lands) → B writes (B's stale snapshot OVERWRITES A's
// patch). The queue ensures each call's RMW completes before the next.
let _updateQueue = Promise.resolve();

// Read-modify-write for the listed types. `patch` is shallow-merged into each
// type's existing entry. Other types are preserved as-is. Throws on write
// failure (caller decides whether to swallow — runScanCore swallows).
export function updateForTypes(types, patch, file = CADENCE_STATE_FILE) {
  if (!Array.isArray(types) || types.length === 0) return _updateQueue;
  const prev = _updateQueue;
  _updateQueue = (async () => {
    // Wait for the previous update to finish (success OR failure — failures
    // are isolated to their caller and shouldn't block subsequent updates).
    await prev.catch(() => {});
    const state = await readCadenceState(file);
    for (const t of types) {
      if (typeof t !== 'string' || !t.trim()) continue;
      state[t] = { ...(state[t] ?? {}), ...patch };
    }
    await writeCadenceState(state, file);
  })();
  return _updateQueue;
}

// ── isDue ───────────────────────────────────────────────────────────────

// True if `type` has never run, or its last_run_at + cadence_ms <= now.
// Designed for the scheduler's tick: if cadenceMap[type] is missing, type
// is not scheduler-eligible → returns false.
export function isDue(type, state, cadenceMap, now = Date.now()) {
  const cadenceMs = cadenceMap?.[type];
  if (typeof cadenceMs !== 'number' || cadenceMs <= 0) return false;
  const entry = state?.[type];
  if (!entry || typeof entry.last_run_at !== 'string') return true;
  const lastRunMs = Date.parse(entry.last_run_at);
  if (Number.isNaN(lastRunMs)) return true; // corrupt timestamp → re-run
  // Future last_run_at (clock skew, hand-edit, NTP jump) → treat as due.
  // Otherwise the type would sit idle until real time catches up.
  if (lastRunMs > now) return true;
  return lastRunMs + cadenceMs <= now;
}
