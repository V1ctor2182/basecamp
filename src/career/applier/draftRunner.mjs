// Mode 1 draft runner. Orchestrates the single-Sonnet draft pipeline:
//   buildDraftPrompt → callWithRetry (2x on 429/5xx/APIConnectionError) →
//   parseDraftResponse → computeCostUsd → recordCost → return
//
// NEVER throws — every failure mode lands as { jobId, status:'error',
// error: '...' }. The m3 endpoint maps 'error' to a 502 with the error
// message in the body.
//
// Pattern mirrors stageBRunner (06-evaluator/02-stage-b-sonnet) but
// scoped to a SINGLE-job at a time (no batch worker pool — Mode 1 is
// per-Apply-click, not per-batch).

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  getClient,
  RateLimitError,
  APIConnectionError,
} from '../lib/anthropicClient.mjs';
import { computeCostUsd } from '../lib/anthropicPricing.mjs';
import {
  buildDraftPrompt,
  parseDraftResponse,
  ParseError,
  APPLIER_MODEL,
} from './draftPrompt.mjs';

const DRAFT_CALLER = 'applier:draft';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const LLM_COSTS_FILE = path.join(CAREER_DIR, 'llm-costs.jsonl');

const RETRY_DELAYS_MS = [500, 2000];

export const STATUS = Object.freeze({
  DRAFTED: 'drafted',
  ERROR: 'error',
});

const DEFAULT_DEPS = Object.freeze({
  client: null, // lazy via getClient()
  recordCost: defaultRecordCost,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

function mergeDeps(opts) {
  if (!opts || typeof opts !== 'object') return DEFAULT_DEPS;
  return {
    client: opts._client ?? DEFAULT_DEPS.client,
    recordCost: opts._recordCost ?? DEFAULT_DEPS.recordCost,
    sleep: opts._sleep ?? DEFAULT_DEPS.sleep,
  };
}

async function defaultRecordCost(record) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  await fs.appendFile(LLM_COSTS_FILE, line);
}

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

function errorResult(jobId, err, costUsd = 0) {
  return {
    jobId,
    status: STATUS.ERROR,
    model: APPLIER_MODEL,
    cost_usd: costUsd,
    error: String(err?.message ?? err).slice(0, 300),
  };
}

/**
 * Generate a Mode 1 draft for one job.
 *
 * @param {object} job — pipeline.json job (id, role, company, url, description, …)
 * @param {object} bundle — { reportText, legalYml, templatesText, identityYml, qaHistory, pdfPath? }
 * @param {object} opts — { _client, _recordCost, _sleep } for tests
 *
 * @returns {Promise<{
 *   jobId: string,
 *   status: 'drafted' | 'error',
 *   model: string,
 *   cost_usd: number,
 *   fields?: Array,        // present when status='drafted'
 *   generated_at?: string, // ISO datetime when status='drafted'
 *   error?: string,        // present when status='error'
 * }>}
 */
export async function generateDraft(job, bundle, opts = {}) {
  const jobId = job?.id ?? null;
  const deps = mergeDeps(opts);

  // Resolve client up-front — fail-fast on missing API key
  let client;
  try {
    client = deps.client ?? getClient();
  } catch (e) {
    return errorResult(jobId, e);
  }

  // Build prompt + send
  const params = buildDraftPrompt(job, bundle, { pdfPath: bundle?.pdfPath });

  let response;
  try {
    response = await callWithRetry(
      () => client.messages.create(params),
      deps.sleep
    );
  } catch (e) {
    return errorResult(jobId, new Error(`api: ${e?.message ?? e}`));
  }

  // Compute cost first — we paid Anthropic regardless of parse success
  const usage = response?.usage ?? {};
  const rawCost = computeCostUsd(params.model, usage);
  const costUsd = Number.isFinite(rawCost) ? rawCost : 0;

  // Record cost — failure to record MUST NOT fail the draft generation
  try {
    await deps.recordCost({
      caller: DRAFT_CALLER,
      model: params.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      job_id: jobId,
    });
  } catch (e) {
    console.warn('[draftRunner] cost record failed:', String(e?.message ?? e).slice(0, 200));
  }

  // Parse the JSON response
  let fields;
  try {
    fields = parseDraftResponse(response?.content);
  } catch (e) {
    const tag = e instanceof ParseError ? 'parse:' : 'validate:';
    return errorResult(jobId, new Error(`${tag} ${e.message}`), costUsd);
  }

  return {
    jobId,
    status: STATUS.DRAFTED,
    model: params.model,
    cost_usd: costUsd,
    fields,
    generated_at: new Date().toISOString(),
  };
}
