// Stage B (Sonnet deep-eval) worker-pool runner. Consumes m1's prompt
// builder + parser + the shared Anthropic client. Mirrors stageARunner shape
// (DI seam, concurrency=3, NEVER throws — per-job errors absorbed). Per-job
// lifecycle:
//
//   shouldEvaluate gate → buildStageBPrompt → callWithRetry (2x on
//   5xx/429/408/APIConnectionError) → parseStageBResponse → write report
//   atomically → computeCostUsd → recordCost
//
// No `archived` status — Stage B's threshold gate (only stage_a passers
// deserve a $0.30 deep eval) lives in the m4 endpoint, not here. The runner
// just evaluates whatever it's given.
//
// m3 will replace `client.messages.create` with a tool-use loop
// (web_search + verify_job_posting). The retry wrapper today wraps the
// single API call; when m3 lands, it will need to retry per-round or wrap
// the whole loop — see runToolUseLoop notes there.

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  getClient,
  ConfigError,
  RateLimitError,
  APIConnectionError,
} from '../lib/anthropicClient.mjs';
import {
  buildStageBPrompt,
  parseStageBResponse,
  resolveEnabledBlocks,
  concatTextBlocks,
  STAGE_B_MODEL,
  BLOCK_KEYS,
  FORCED_ON_BLOCKS,
} from './stageBPrompt.mjs';
import { computeCostUsd } from '../lib/anthropicPricing.mjs';
import { loadCvBundle } from './cvBundle.mjs';

const STAGE_B_CALLER = 'evaluator:stage-b';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const REPORTS_DIR = path.join(CAREER_DIR, 'reports');
const LLM_COSTS_FILE = path.join(CAREER_DIR, 'llm-costs.jsonl');

// Backoff schedule for retry on transient errors. Two retries → 3 attempts
// total. Matches Stage A.
const RETRY_DELAYS_MS = [500, 2000];

const DEFAULT_DEPS = Object.freeze({
  client: null, // lazy via getClient()
  recordCost: defaultRecordCost,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  writeReport: defaultWriteReport,
});

// Stage B status enum. NO 'archived' — see file header.
export const STATUS = Object.freeze({
  EVALUATED: 'evaluated',
  ERROR: 'error',
});

// Re-export so m4 endpoint imports both pieces from one place.
export { resolveEnabledBlocks };

function mergeDeps(opts) {
  if (!opts || typeof opts !== 'object') return DEFAULT_DEPS;
  return {
    client: opts._client ?? DEFAULT_DEPS.client,
    recordCost: opts._recordCost ?? DEFAULT_DEPS.recordCost,
    sleep: opts._sleep ?? DEFAULT_DEPS.sleep,
    writeReport: opts._writeReport ?? DEFAULT_DEPS.writeReport,
  };
}

async function defaultRecordCost(record) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  await fs.appendFile(LLM_COSTS_FILE, line);
}

// JobSchema.id is /^[a-f0-9]{12}$/. Validate before interpolating into a
// path — defense in depth against pre-m4 pipeline.json corruption or
// upstream bugs that would otherwise let `..`, `/`, or null bytes write
// outside REPORTS_DIR.
const JOB_ID_RE = /^[a-f0-9]{12}$/;

// Atomic write: tmp file → rename. Returns the report path with forward
// slashes (Windows-safe) so UI consumers can use it directly in URLs.
// Cleans up stale tmp on rename failure.
async function defaultWriteReport(jobId, content) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new Error(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  if (!existsSync(REPORTS_DIR)) await fs.mkdir(REPORTS_DIR, { recursive: true });
  const finalPath = path.join(REPORTS_DIR, `${jobId}.md`);
  const tmpPath = path.join(REPORTS_DIR, `.${jobId}.md.tmp`);
  await fs.writeFile(tmpPath, content);
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
  // Forward slashes so the path is portable between server-side mutation
  // (pipeline.json), filesystem reads, and any future URL construction.
  return `data/career/reports/${jobId}.md`;
}

// True for transient errors that warrant retry. Same predicate as Stage A —
// instanceof + name + status fallbacks make it resilient to cross-module
// prototype-chain breakage in tests.
function isRetryableError(err) {
  if (!err) return false;
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIConnectionError) return true;
  if (err.name === 'RateLimitError' || err.name === 'APIConnectionError') return true;
  if (err.status === 429) return true;
  if (err.status === 408) return true;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return false;
}

async function callWithRetry(fn, sleep) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || attempt === RETRY_DELAYS_MS.length) {
        throw e;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

// Idempotent gate. Any existing stage_b entry (including error) → skip.
// m4 UI clears the field for retry.
function shouldEvaluate(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.evaluation && job.evaluation.stage_b != null) return false;
  return true;
}

// Per-job lifecycle. NEVER throws — every failure mode lands as
// status:'error'. Returns the result the batch caller appends. Caller MUST
// have already resolved `client` (hoisted to batch entry — fail-fast on
// bad ANTHROPIC_API_KEY rather than producing N identical config errors).
async function evaluateOneJob(job, prefs, cvBundle, client, deps) {
  const jobId = job?.id ?? null;
  if (!shouldEvaluate(job)) {
    return { jobId, skipped: true };
  }

  const params = buildStageBPrompt(job, prefs, cvBundle);

  let response;
  try {
    response = await callWithRetry(
      () => client.messages.create(params),
      deps.sleep
    );
  } catch (e) {
    return errorResult(jobId, e);
  }

  const usage = response?.usage ?? {};
  const rawCost = computeCostUsd(params.model, usage);
  // Guard against NaN from unknown-model / malformed-usage paths so the
  // batch-level total_cost_usd never propagates NaN.
  const costUsd = Number.isFinite(rawCost) ? rawCost : 0;

  // Always record cost — we paid Anthropic regardless of downstream success.
  // Failure to record cost should NOT fail the per-job evaluation.
  try {
    await deps.recordCost({
      caller: STAGE_B_CALLER,
      model: params.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      job_id: jobId,
    });
  } catch (e) {
    console.warn('[stageBRunner] cost record failed:', String(e?.message ?? e).slice(0, 200));
  }

  // Parse the multi-block response. extractBlocks (called by parseStageBResponse)
  // is tolerant of missing blocks but throws on empty/malformed content.
  let parsed;
  try {
    parsed = parseStageBResponse(response?.content);
  } catch (e) {
    return {
      jobId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `parse: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }

  // parseStageBResponse returns { A, B, ..., G, total_score, preamble }
  // flattened. Pull per-letter content into `blocks` and compute
  // blocks_emitted = letters with non-empty content.
  const blocks = {};
  const blocksEmitted = [];
  for (const k of BLOCK_KEYS) {
    const v = parsed[k];
    blocks[k] = typeof v === 'string' ? v : '';
    if (blocks[k].trim().length > 0) blocksEmitted.push(k);
  }

  // Reject degenerate responses BEFORE writing report. Sonnet must emit a
  // total score line AND at least the forced-on blocks (A/B/E) for the
  // result to be downstream-usable. m4 endpoint expects a real total_score
  // and Tailor Engine expects Block E content.
  const missingForced = FORCED_ON_BLOCKS.filter((k) => !blocksEmitted.includes(k));
  if (parsed.total_score == null || missingForced.length > 0) {
    const reasons = [];
    if (parsed.total_score == null) reasons.push('missing total_score');
    if (missingForced.length > 0) reasons.push(`missing forced blocks: ${missingForced.join(',')}`);
    return {
      jobId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `parse: degenerate response (${reasons.join('; ')})`,
    };
  }

  // Compose the report markdown using the SAME text the parser saw (single
  // source of truth via concatTextBlocks from m1). Then atomic write.
  const reportText = concatTextBlocks(response?.content);
  let reportPath;
  try {
    reportPath = await deps.writeReport(jobId, reportText);
  } catch (e) {
    return {
      jobId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `report_write: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }

  return {
    jobId,
    total_score: parsed.total_score,
    blocks,
    blocks_emitted: blocksEmitted,
    report_path: reportPath,
    model: params.model,
    cost_usd: costUsd,
    status: STATUS.EVALUATED,
  };
}

function errorResult(jobId, err) {
  return {
    jobId,
    model: STAGE_B_MODEL,
    cost_usd: 0,
    status: STATUS.ERROR,
    error: errorMessage(err),
  };
}

function errorMessage(err) {
  if (err instanceof ConfigError) return `config: ${err.message}`;
  const name = err?.name ?? 'Error';
  return `${name}: ${String(err?.message ?? err).slice(0, 200)}`;
}

// Batch entrypoint. Worker-pool concurrency=3 by default. Caller may pass
// `cvBundle` to skip the FS load (m4 endpoint loads once and threads it).
//
// opts: { concurrency=3, cvBundle, _client, _recordCost, _sleep, _writeReport }
export async function evaluateJobsStageB(jobs, prefs, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const concurrency =
    typeof opts.concurrency === 'number' && opts.concurrency > 0
      ? Math.min(opts.concurrency, list.length || 1)
      : 3;
  const deps = mergeDeps(opts);

  const counters = {
    evaluated: 0,
    errors: 0,
    skipped: 0,
    total_cost_usd: 0,
  };
  const results = [];

  if (list.length === 0) {
    return { ...counters, results };
  }

  // Resolve the Anthropic client ONCE up front. If ANTHROPIC_API_KEY is
  // missing, fail-fast with one error per job rather than calling getClient
  // N times inside the worker. Same shape as evaluateOneJob's error result.
  let client;
  try {
    client = deps.client ?? getClient();
  } catch (e) {
    for (const job of list) {
      results.push(errorResult(job?.id ?? null, e));
    }
    counters.errors = results.length;
    return { ...counters, results };
  }

  // Load the CV bundle once (caller may pre-supply via opts.cvBundle).
  // Wrap in try/catch — non-ENOENT FS errors (EACCES, EISDIR, EMFILE) would
  // otherwise reject the whole batch, violating the "NEVER throws" contract.
  let cvBundle;
  try {
    cvBundle = opts.cvBundle ?? (await loadCvBundle());
  } catch (e) {
    console.warn('[stageBRunner] cvBundle load failed, falling back to empty:', String(e?.message ?? e).slice(0, 200));
    cvBundle = { cv: '', narrative: '', proofPoints: '', identity: {}, qaFewShot: [] };
  }

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const r = await evaluateOneJob(list[idx], prefs, cvBundle, client, deps);
      if (r.skipped) {
        counters.skipped++;
        continue;
      }
      results.push(r);
      // Guard against NaN slipping through (computeCostUsd already guarded
      // upstream, but defense in depth).
      counters.total_cost_usd += Number.isFinite(r.cost_usd) ? r.cost_usd : 0;
      switch (r.status) {
        case STATUS.EVALUATED:
          counters.evaluated++;
          break;
        case STATUS.ERROR:
          counters.errors++;
          break;
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array(n).fill(0).map(() => worker()));

  counters.total_cost_usd = Math.round(counters.total_cost_usd * 10000) / 10000;

  return { ...counters, results };
}
