import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resetRobotsCache, sleep } from './httpFetch.mjs';
import { readPortalsConfig } from './portalsLoader.mjs';
import { greenhouseAdapter } from './adapters/greenhouse.mjs';
import { ashbyAdapter } from './adapters/ashby.mjs';
import { leverAdapter } from './adapters/lever.mjs';
import { githubMdAdapter } from './adapters/githubMd.mjs';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const PIPELINE_FILE = path.join(CAREER_DIR, 'pipeline.json');

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

export function getScanStatus() {
  return { ...scanState, progress: [...scanState.progress] };
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

async function runScanCore() {
  const portals = await readPortalsConfig();
  scanState.total_sources = portals.sources.length;
  const allJobs = [];
  const scan_summary = [];

  for (let i = 0; i < portals.sources.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_MS);
    const source = portals.sources[i];
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

  await atomicWriteJson(PIPELINE_FILE, {
    last_scan_at: new Date().toISOString(),
    jobs: allJobs,
    scan_summary,
  });
}

// Kicks off scan asynchronously. Returns immediately with scan id + start time.
// Throws ScanAlreadyRunningError if a scan is already in flight.
export function startScan() {
  if (scanState.running) {
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
  };
  const id = scanState.scan_id;
  // Fire and forget; errors captured into scanState.error.
  runScanCore()
    .catch((e) => {
      scanState.error = String(e?.message ?? e);
    })
    .finally(() => {
      scanState.running = false;
      scanState.finished_at = new Date().toISOString();
    });
  return { scan_id: id, started_at: scanState.started_at };
}

// Test-only: synchronously run a scan and return status. Not exposed via HTTP.
export async function runScanForTest() {
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
  };
  try {
    await runScanCore();
  } catch (e) {
    scanState.error = String(e?.message ?? e);
  } finally {
    scanState.running = false;
    scanState.finished_at = new Date().toISOString();
  }
  return getScanStatus();
}
