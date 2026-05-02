import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { resetRobotsCache, sleep } from './httpFetch.mjs';
import { readPortalsConfig } from './portalsLoader.mjs';
import { greenhouseAdapter } from './adapters/greenhouse.mjs';
import { ashbyAdapter } from './adapters/ashby.mjs';
import { leverAdapter } from './adapters/lever.mjs';
import { githubMdAdapter } from './adapters/githubMd.mjs';
import { dedupeJobs, markIdsAsSeen } from './dedupe.mjs';
import { applyHardFilterBatch, archiveDropped } from './hardFilter.mjs';
import { RULE_ORDER } from './dryRun.mjs';
import { enrichBatch } from './jdEnrich.mjs';
import { updateForTypes as updateCadenceForTypes } from './cadenceState.mjs';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const PIPELINE_FILE = path.join(CAREER_DIR, 'pipeline.json');
const PREFERENCES_FILE = path.join(CAREER_DIR, 'preferences.yml');

// Conservative reader — yaml load with empty fallback. We do NOT Zod-parse here
// because: (a) hardFilter is already missing-field tolerant, (b) a malformed
// preferences.yml should not kill an in-flight scan. Server.mjs has its own
// strict reader for the API path.
async function readPreferencesForScan() {
  if (!existsSync(PREFERENCES_FILE)) return { hard_filters: {} };
  try {
    const raw = await fs.readFile(PREFERENCES_FILE, 'utf-8');
    if (!raw.trim()) return { hard_filters: {} };
    const obj = yaml.load(raw);
    return obj && typeof obj === 'object' ? obj : { hard_filters: {} };
  } catch (e) {
    console.warn('[scanRunner] preferences.yml unparseable, scan will keep all:', e?.message);
    return { hard_filters: {} };
  }
}

const ADAPTERS = {
  [greenhouseAdapter.type]: greenhouseAdapter,
  [ashbyAdapter.type]: ashbyAdapter,
  [leverAdapter.type]: leverAdapter,
  [githubMdAdapter.type]: githubMdAdapter,
};

export function registerAdapter(adapter) {
  ADAPTERS[adapter.type] = adapter;
}

const RATE_LIMIT_MS = 1_000;

export class ScanAlreadyRunningError extends Error {
  constructor(state) {
    super('Scan already running');
    this.name = 'ScanAlreadyRunningError';
    this.state = state;
  }
}

let scanState = {
  running: false,
  scan_id: null,
  started_at: null,
  finished_at: null,
  progress: [],
  total_sources: 0,
  jobs_count: 0,
  error: null,
};

// Tracks long-running side-channels that mutate pipeline.json outside of
// runScanCore (e.g. POST /api/career/finder/enrich). Both scan-start and
// these endpoints check both flags before claiming the lock — otherwise a
// long-running enrich could overwrite a scan's fresh pipeline.json with a
// stale snapshot, silently losing kept jobs.
let pipelineMutex = {
  enriching: false,
  enrich_started_at: null,
};

export function isPipelineBusy() {
  return scanState.running || pipelineMutex.enriching;
}

export function acquirePipelineEnrichLock() {
  if (scanState.running) {
    return { ok: false, reason: 'scan_running' };
  }
  if (pipelineMutex.enriching) {
    return { ok: false, reason: 'enrich_running' };
  }
  pipelineMutex = { enriching: true, enrich_started_at: new Date().toISOString() };
  return { ok: true };
}

export function releasePipelineEnrichLock() {
  pipelineMutex = { enriching: false, enrich_started_at: null };
}

export function getScanStatus() {
  return {
    ...scanState,
    progress: [...scanState.progress],
    enriching: pipelineMutex.enriching,
    enrich_started_at: pipelineMutex.enrich_started_at,
  };
}

async function atomicWriteJson(file, data) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  } catch (e) {
    fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// Normalize a `types` argument from caller: undefined or [] → null (full scan,
// back-compat). Non-empty array → Set for O(1) membership test. Empty array is
// treated as "no filter" intentionally — it's a less-dangerous default than
// "filter to nothing", which on a faulty caller would silently produce a scan
// that wipes pipeline.json's filtered slice with nothing.
function normalizeTypeFilter(types) {
  if (!Array.isArray(types) || types.length === 0) return null;
  const set = new Set(types.filter((t) => typeof t === 'string' && t.length > 0));
  return set.size > 0 ? set : null;
}

async function runScanCore({ types } = {}) {
  let typeFilter = normalizeTypeFilter(types);
  const portals = await readPortalsConfig();
  // Drop unknown types (not present in any portals.source) BEFORE writing
  // any state — otherwise a typo'd debug call would pollute cadence-state
  // with a permanent stale entry. Logged so the caller sees the drop.
  if (typeFilter) {
    const activeTypes = new Set(portals.sources.map((s) => s.type));
    const filteredArr = Array.from(typeFilter).filter((t) => activeTypes.has(t));
    if (filteredArr.length !== typeFilter.size) {
      const dropped = Array.from(typeFilter).filter((t) => !activeTypes.has(t));
      console.warn(`[scanRunner] dropping unknown types from filter: ${dropped.join(', ')}`);
    }
    typeFilter = filteredArr.length > 0 ? new Set(filteredArr) : null;
  }
  // Source list scoped to the filter (full list when typeFilter is null).
  const sources = typeFilter
    ? portals.sources.filter((s) => typeFilter.has(s.type))
    : portals.sources;
  scanState.total_sources = sources.length;
  scanState.filtered_types = typeFilter ? Array.from(typeFilter) : null;
  const allJobs = [];
  const scan_summary = [];

  for (let i = 0; i < sources.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const source = sources[i];
    const t0 = Date.now();
    const adapter = ADAPTERS[source.type];
    const entry = {
      source: source.name,
      type: source.type,
      count: 0,
      duration_ms: 0,
      error: null,
    };
    if (!adapter) {
      entry.error = `unknown adapter type: ${source.type}`;
      entry.duration_ms = Date.now() - t0;
      scan_summary.push(entry);
      scanState.progress.push(entry);
      continue;
    }
    try {
      const raws = await adapter.fetch(source.config ?? {});
      const jobs = [];
      for (const raw of raws) {
        try {
          jobs.push(adapter.normalize(raw, source));
        } catch (e) {
          // Single-job normalize failure logged but doesn't kill the source.
          entry.error = entry.error
            ? entry.error
            : `normalize: ${String(e?.message ?? e).slice(0, 200)}`;
        }
      }
      allJobs.push(...jobs);
      entry.count = jobs.length;
      scanState.jobs_count = allJobs.length;
    } catch (e) {
      entry.error = String(e?.message ?? e).slice(0, 500);
    }
    entry.duration_ms = Date.now() - t0;
    scan_summary.push(entry);
    scanState.progress.push(entry);
  }

  // ── Dedupe + Hard-filter pipeline (m3 integration) ──────────────────
  // Order is crash-safety-driven: pipeline.json (the kept-jobs source of truth)
  // must land BEFORE we record IDs as seen. Otherwise a crash between
  // markIdsAsSeen and pipeline write would permanently lose kept jobs (next
  // scan dedupes them away because their ids are in scan-history forever).
  //
  //   1. dedupe → partition (new, duplicates)
  //   2. apply hard_filters (9-rule short-circuit) → (kept, dropped)
  //   3. atomicWriteJson(pipeline.json, kept-only + totals)  ← durable first
  //   4. archiveDropped(dropped) jsonl                       ← dropped graveyard
  //   5. markIdsAsSeen(all new ids, kept ∪ dropped)          ← only after #3+#4
  //
  // Failure modes:
  //   · crash after #3, before #4: drops re-fetched and re-archived next scan
  //     (idempotent — same id, same drop, fine).
  //   · crash after #4, before #5: drops re-fetched and re-archived (same as
  //     above) AND kept jobs re-fetched and surface again — no data loss.
  //   · crash before #3: no writes; next scan starts fresh.
  const { new: newJobs, duplicates } = await dedupeJobs(allJobs);
  const prefs = await readPreferencesForScan();
  const { kept, dropped } = applyHardFilterBatch(newJobs, prefs);

  const droppedPerRule = Object.fromEntries(RULE_ORDER.map((r) => [r, 0]));
  for (const d of dropped) {
    if (d.rule_id && droppedPerRule[d.rule_id] !== undefined) droppedPerRule[d.rule_id]++;
  }

  // Tier-3 JD enrichment runs BEFORE pipeline.json write so kept jobs land
  // with fresh descriptions. enrichBatch mutates each kept job in place
  // (description / needs_manual_enrich) and never throws; tier 4 catches
  // every per-job failure mode.
  const enrich = await enrichBatch(kept, { concurrency: 3 });

  // Per-type merge: when a type filter is active, the scheduler is updating
  // ONLY the slice of pipeline.json belonging to those types. We must keep
  // jobs from other types intact — otherwise running with types=[greenhouse]
  // would silently wipe ashby/lever/github-md jobs from pipeline.json.
  // Same for scan_summary entries.
  let mergedJobs = kept;
  let mergedSummary = scan_summary;
  if (typeFilter && existsSync(PIPELINE_FILE)) {
    try {
      const existing = JSON.parse(await fs.readFile(PIPELINE_FILE, 'utf-8'));
      const existingJobs = Array.isArray(existing?.jobs) ? existing.jobs : [];
      // Per-source replacement: only drop existing jobs whose source.name
      // was actually re-fetched successfully this run. If a source threw
      // (network error / robots block / adapter missing), its prior jobs
      // stay. Otherwise a filtered scan against a single failing source
      // would wipe its slice, replacing it with nothing.
      const successfulSources = new Set();
      for (const entry of scan_summary) {
        // entry.count > 0 means at least one job was normalized; even with
        // a partial entry.error (single-job normalize failure), we treat
        // the source as successfully refreshed for the count we got.
        if (!entry.error || entry.count > 0) {
          successfulSources.add(`${entry.type}::${entry.source}`);
        }
      }
      // Defensive: also drop null/non-object jobs from legacy data.
      const otherJobs = existingJobs.filter((j) => {
        if (!j || typeof j !== 'object' || !j.source) return false;
        if (!typeFilter.has(j.source.type)) return true; // not in filter
        const tag = `${j.source.type}::${j.source.name}`;
        // In filter AND this source was successfully scanned this run →
        // drop (its replacement is in `kept`). Otherwise keep — its source
        // failed and we shouldn't lose the existing data.
        return !successfulSources.has(tag);
      });
      mergedJobs = [...otherJobs, ...kept];
      const existingSummary = Array.isArray(existing?.scan_summary) ? existing.scan_summary : [];
      // Same per-source replacement for scan_summary entries.
      const otherSummary = existingSummary.filter((e) => {
        if (!e || typeof e !== 'object') return false;
        if (!typeFilter.has(e.type)) return true;
        const tag = `${e.type}::${e.source}`;
        return !successfulSources.has(tag);
      });
      mergedSummary = [...otherSummary, ...scan_summary];
    } catch (e) {
      console.warn(
        '[scanRunner] type-filter merge: pipeline.json unparseable, falling back to filter-only result:',
        e?.message
      );
    }
  }

  await atomicWriteJson(PIPELINE_FILE, {
    last_scan_at: new Date().toISOString(),
    jobs: mergedJobs,
    scan_summary: mergedSummary,
    totals: {
      // per_run: stats from THIS scan's slice only. UI displays as the
      // current/just-completed run's breakdown.
      per_run: {
        total_input: allJobs.length,
        total_dup: duplicates.length,
        total_new: newJobs.length,
        total_kept: kept.length,
        total_dropped: dropped.length,
        dropped_per_rule: droppedPerRule,
        enriched_count: enrich.enriched,
        ats_hits: enrich.ats_hits,
        scrape_hits: enrich.scrape_hits,
        needs_manual_count: enrich.needs_manual,
        skipped_already_enriched_count: enrich.skipped,
        filtered_types: typeFilter ? Array.from(typeFilter) : null,
      },
      // aggregate: pipeline-wide counts derived from mergedJobs after this
      // run. Always reflects the current pipeline.json contents — UI badges
      // showing "N jobs in shortlist" should read from here.
      aggregate: {
        total_kept: mergedJobs.length,
        needs_manual_count: mergedJobs.filter((j) => j && j.needs_manual_enrich === true).length,
      },
    },
  });
  await archiveDropped(dropped);
  await markIdsAsSeen(newJobs.map((j) => j.id).filter((id) => typeof id === 'string'));
  scanState.jobs_count = mergedJobs.length;

  // Cadence-state update — scheduler reads last_run_at to decide what's due.
  // Failure here doesn't fail the scan (pipeline.json + archive + scan-history
  // already landed); next scheduler tick may re-fire but pipelineMutex serializes.
  const typesRun = typeFilter
    ? Array.from(typeFilter)
    : Array.from(new Set(sources.map((s) => s.type)));
  if (typesRun.length > 0) {
    // Source-level errors are swallowed into scan_summary entries (don't kill
    // the whole run). But cadence-state should reflect them — UI consumers
    // should see "partial" when SOME sources failed and "error" when all
    // sources of the type failed (with no jobs landed).
    const perTypeOutcome = {};
    for (const t of typesRun) {
      const entries = scan_summary.filter((e) => e.type === t);
      if (entries.length === 0) {
        perTypeOutcome[t] = { outcome: 'ok', error: null }; // no sources of type
      } else {
        const errored = entries.filter((e) => e.error);
        const succeeded = entries.filter((e) => !e.error || e.count > 0);
        if (succeeded.length === 0 && errored.length > 0) {
          perTypeOutcome[t] = {
            outcome: 'error',
            error: String(errored[0].error ?? '').slice(0, 200),
          };
        } else if (errored.length > 0) {
          perTypeOutcome[t] = {
            outcome: 'partial',
            error: String(errored[0].error ?? '').slice(0, 200),
          };
        } else {
          perTypeOutcome[t] = { outcome: 'ok', error: null };
        }
      }
    }
    try {
      // Updating per-type with distinct outcomes — call updateForTypes per
      // outcome group (not strictly needed since the patch is shallow-merged,
      // but iterating types here makes intent clear).
      for (const t of typesRun) {
        const o = perTypeOutcome[t];
        const patch = {
          last_run_at: new Date().toISOString(),
          last_outcome: o.outcome,
          last_jobs_count: kept.filter((j) => j.source?.type === t).length,
          last_filter_active: !!typeFilter,
        };
        if (o.error) patch.last_error = o.error;
        else patch.last_error = null;
        await updateCadenceForTypes([t], patch);
      }
    } catch (e) {
      console.warn('[scanRunner] cadence-state update failed:', e?.message);
    }
  }
}

// On runScanCore throw, mark cadence-state for the affected types as 'error'.
// Best effort: we don't know typesRun for sure (caller passed types or full),
// so we record against the requested filter set. Wrap in try/catch since
// cadence-state failure is itself non-fatal.
async function recordCadenceError(types, errMessage) {
  try {
    const typesArr = Array.isArray(types) && types.length > 0 ? types : null;
    if (!typesArr) return; // skip when full scan errored — no per-type attribution
    await updateCadenceForTypes(typesArr, {
      last_run_at: new Date().toISOString(),
      last_outcome: 'error',
      last_error: String(errMessage ?? '').slice(0, 200),
    });
  } catch (e) {
    console.warn('[scanRunner] cadence-state error update failed:', e?.message);
  }
}

// Kicks off scan asynchronously. Returns immediately with scan id + start time.
// Throws ScanAlreadyRunningError if a scan is already in flight, OR if a
// background enrich is in flight (would race the scan's pipeline.json write
// with a stale snapshot).
//
// `opts.types`: optional array of source.type values. When provided, only
// sources matching one of these types are scanned, and pipeline.json is
// merged (other types' jobs preserved). undefined / [] → full scan.
export function startScan(opts = {}) {
  if (scanState.running || pipelineMutex.enriching) {
    throw new ScanAlreadyRunningError(getScanStatus());
  }
  resetRobotsCache();
  scanState = {
    running: true,
    scan_id: randomUUID(),
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: [],
    total_sources: 0,
    jobs_count: 0,
    error: null,
    filtered_types: null,
  };
  const id = scanState.scan_id;
  const types = opts.types;
  // Fire and forget; errors captured into scanState.error.
  runScanCore({ types })
    .catch(async (e) => {
      scanState.error = String(e?.message ?? e);
      await recordCadenceError(types, scanState.error);
    })
    .finally(() => {
      scanState.running = false;
      scanState.finished_at = new Date().toISOString();
    });
  return { scan_id: id, started_at: scanState.started_at };
}

// Test-only: synchronously run a scan and return status. Not exposed via HTTP.
export async function runScanForTest(opts = {}) {
  if (scanState.running) throw new ScanAlreadyRunningError(getScanStatus());
  resetRobotsCache();
  scanState = {
    running: true,
    scan_id: randomUUID(),
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: [],
    total_sources: 0,
    jobs_count: 0,
    error: null,
    filtered_types: null,
  };
  try {
    await runScanCore({ types: opts.types });
  } catch (e) {
    scanState.error = String(e?.message ?? e);
    await recordCadenceError(opts.types, scanState.error);
  } finally {
    scanState.running = false;
    scanState.finished_at = new Date().toISOString();
  }
  return getScanStatus();
}
