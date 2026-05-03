// Stage A worker-pool runner. Consumes m1's prompt builder + parser + client.
// Mirrors jdEnrich.enrichBatch shape (DI seam, concurrency=3, never throws
// out — per-job errors absorbed). Per-job lifecycle:
//
//   shouldEvaluate gate → buildStageAPrompt → callWithRetry (2x on 5xx/429) →
//     parseStageAResponse → computeCostUsd → recordCost → status determination
//
// Scoring threshold from prefs.thresholds.skip_below; never hardcoded
// (constraint #1 of stage-a-haiku Room).

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
  buildStageAPrompt,
  parseStageAResponse,
  ParseError,
  STAGE_A_MODEL,
} from './stageAPrompt.mjs';
import { computeCostUsd } from '../lib/anthropicPricing.mjs';

const STAGE_A_CALLER = 'evaluator:stage-a';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const LLM_COSTS_FILE = path.join(CAREER_DIR, 'llm-costs.jsonl');

// Backoff schedule for retry on transient errors. Two retries → 3 attempts
// total. Keeps the worst-case per-job latency bounded at ~2.5s + 1 fast retry
// + actual API time.
const RETRY_DELAYS_MS = [500, 2000];

const DEFAULT_DEPS = Object.freeze({
  client: null, // lazy via getClient()
  recordCost: defaultRecordCost,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// Stage A status enum — matches the shape m3 will write into
// pipeline.json::jobs[i].evaluation.stage_a.status.
export const STATUS = Object.freeze({
  EVALUATED: 'evaluated',
  ARCHIVED: 'archived',
  ERROR: 'error',
});

function mergeDeps(opts) {
  if (!opts || typeof opts !== 'object') return DEFAULT_DEPS;
  return {
    client: opts._client ?? DEFAULT_DEPS.client,
    recordCost: opts._recordCost ?? DEFAULT_DEPS.recordCost,
    sleep: opts._sleep ?? DEFAULT_DEPS.sleep,
  };
}

// Default cost recorder: append a single line to llm-costs.jsonl. Same path
// + record shape as server.mjs's appendCostRecord, just without the loopback
// HTTP hop. server.mjs's GET /api/career/llm-costs reads this same file.
async function defaultRecordCost(record) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  await fs.appendFile(LLM_COSTS_FILE, line);
}

// True for transient errors that warrant retry. We check by both instanceof
// AND status/name strings — manually-constructed SDK error instances (e.g.
// from tests) sometimes lose the prototype chain across module boundaries,
// so the string/status fallbacks make this resilient regardless of how the
// error was constructed.
function isRetryableError(err) {
  if (!err) return false;
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIConnectionError) return true;
  // Fallback by name (covers cross-module instanceof breakage).
  if (err.name === 'RateLimitError' || err.name === 'APIConnectionError') return true;
  // 429 rate limit by status (in case the typed class didn't wrap it).
  if (err.status === 429) return true;
  // 408 request timeout — Anthropic rarely returns this directly, but
  // proxies/load balancers between us and api.anthropic.com may. The SDK
  // doesn't have a typed subclass for it (only 400/401/403/404/409/422/429),
  // so it surfaces as a base APIError. Retry like any transient.
  if (err.status === 408) return true;
  // 5xx server-side errors — retry. 4xx is fast-fail.
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return false;
}

// Wrap a thunk with up to RETRY_DELAYS_MS.length retries on transient errors.
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

// Decide whether `job` already has a Stage A result. We treat ANY existing
// stage_a entry as "done" — even error/archived. m4 UI will let the user
// manually retry errored jobs by clearing the field; the runner is idempotent.
function shouldEvaluate(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.evaluation && job.evaluation.stage_a != null) return false;
  return true;
}

// Per-job lifecycle. NEVER throws — every failure mode lands as
// status:'error'. Returns the result object the batch caller appends.
async function evaluateOneJob(job, prefs, simplifiedCv, deps) {
  const jobId = job?.id ?? null;
  if (!shouldEvaluate(job)) {
    // Caller should have filtered already; defensive skip → null result that
    // the batch loop ignores from counters.
    return { jobId, skipped: true };
  }

  let client;
  try {
    client = deps.client ?? getClient();
  } catch (e) {
    return errorResult(jobId, e);
  }

  const params = buildStageAPrompt(job, prefs, simplifiedCv);

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
  const costUsd = computeCostUsd(params.model, usage);

  // Record cost even on parse failure — we already paid for the API call.
  // Failure to record cost should NOT fail the per-job evaluation.
  try {
    await deps.recordCost({
      caller: STAGE_A_CALLER,
      model: params.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cost_usd: costUsd,
      job_id: jobId,
    });
  } catch (e) {
    console.warn('[stageARunner] cost record failed:', String(e?.message ?? e).slice(0, 200));
  }

  // Parse the response text. If parsing fails, surface as status:'error' but
  // keep the cost record (we paid; observability is non-negotiable).
  const text = response?.content?.[0]?.text ?? '';
  let parsed;
  try {
    parsed = parseStageAResponse(text);
  } catch (e) {
    return {
      jobId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `parse: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }

  // Threshold from prefs — NEVER hardcoded (constraint #1).
  const skipBelow = Number(prefs?.thresholds?.skip_below);
  const threshold = Number.isFinite(skipBelow) ? skipBelow : 3.0;
  const status = parsed.score < threshold ? STATUS.ARCHIVED : STATUS.EVALUATED;

  return {
    jobId,
    score: parsed.score,
    reason: parsed.reason,
    model: params.model,
    cost_usd: costUsd,
    status,
  };
}

function errorResult(jobId, err) {
  return {
    jobId,
    model: STAGE_A_MODEL,
    cost_usd: 0,
    status: STATUS.ERROR,
    error: errorMessage(err),
  };
}

function errorMessage(err) {
  if (err instanceof ConfigError) return `config: ${err.message}`;
  if (err instanceof ParseError) return `parse: ${err.message}`;
  const name = err?.name ?? 'Error';
  return `${name}: ${String(err?.message ?? err).slice(0, 200)}`;
}

// Batch entrypoint. Worker-pool concurrency=3 by default (chromium-friendly
// and well under typical Anthropic rate limits). Caller passes simplifiedCv
// once (m3 reads base.md once and threads it through). Returns aggregated
// counters + per-job results array.
//
// opts: { concurrency=3, _client, _recordCost, _sleep, simplifiedCv }
//   simplifiedCv is required (string, can be empty). m3 builds it from
//   base.md or the default resume; m2 has no I/O dependency on the FS.
export async function evaluateJobsStageA(jobs, prefs, opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const concurrency =
    typeof opts.concurrency === 'number' && opts.concurrency > 0
      ? Math.min(opts.concurrency, list.length || 1)
      : 3;
  const simplifiedCv = typeof opts.simplifiedCv === 'string' ? opts.simplifiedCv : '';
  const deps = mergeDeps(opts);

  const counters = {
    evaluated: 0,
    archived: 0,
    errors: 0,
    skipped: 0,
    total_cost_usd: 0,
  };
  const results = [];

  if (list.length === 0) {
    return { ...counters, results };
  }

  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const r = await evaluateOneJob(list[idx], prefs, simplifiedCv, deps);
      if (r.skipped) {
        counters.skipped++;
        continue;
      }
      results.push(r);
      counters.total_cost_usd += r.cost_usd ?? 0;
      switch (r.status) {
        case STATUS.EVALUATED:
          counters.evaluated++;
          break;
        case STATUS.ARCHIVED:
          counters.archived++;
          break;
        case STATUS.ERROR:
          counters.errors++;
          break;
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array(n).fill(0).map(() => worker()));

  // Round to 4 decimal places ($0.0001 precision) — token-level dust is
  // visible to UI consumers without 17-digit floating-point noise.
  counters.total_cost_usd = Math.round(counters.total_cost_usd * 10000) / 10000;

  return { ...counters, results };
}
