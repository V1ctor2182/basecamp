// Tailor single-job orchestrator. Mirrors stageBRunner shape (DI seam,
// callWithRetry on 5xx/429/408/APIConnectionError, NEVER throws). Single-
// job — Tailor is user-driven per-Job, not batched. No idempotency gate;
// re-run with userHint IS the expected path (Reject → hint → re-run flow).
//
// Per-job lifecycle:
//   resolve client → loadTailorBundle (or use opts.bundle override) →
//   buildTailorPrompt → callWithRetry → record cost → parse →
//   write atomically → return result
//
// Output: data/career/output/{jobId}-{resumeId}.md (atomic tmp+rename,
// gitignored, both ids regex-validated before path interpolation per the
// path-traversal lessons from Stage B m4 review).

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
  buildTailorPrompt,
  parseTailorResponse,
  TAILOR_MODEL,
} from './tailorPrompt.mjs';
import { computeCostUsd } from '../lib/anthropicPricing.mjs';
import { loadTailorBundle } from './tailorBundle.mjs';

const TAILOR_CALLER = 'cv-tailor';

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
const OUTPUT_DIR = path.join(CAREER_DIR, 'output');
const LLM_COSTS_FILE = path.join(CAREER_DIR, 'llm-costs.jsonl');

// JobSchema.id regex; matches Stage B runner.
const JOB_ID_RE = /^[a-f0-9]{12}$/;
// Resume id regex; matches server.mjs RESUME_ID_RE convention.
const RESUME_ID_RE = /^[a-z0-9-]{1,40}$/;

// Backoff schedule for retry on transient errors. Two retries → 3 attempts.
const RETRY_DELAYS_MS = [500, 2000];

const DEFAULT_DEPS = Object.freeze({
  client: null,
  recordCost: defaultRecordCost,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  writeOutput: defaultWriteOutput,
});

export const STATUS = Object.freeze({
  TAILORED: 'tailored',
  ERROR: 'error',
});

function mergeDeps(opts) {
  if (!opts || typeof opts !== 'object') return DEFAULT_DEPS;
  return {
    client: opts._client ?? DEFAULT_DEPS.client,
    recordCost: opts._recordCost ?? DEFAULT_DEPS.recordCost,
    sleep: opts._sleep ?? DEFAULT_DEPS.sleep,
    writeOutput: opts._writeOutput ?? DEFAULT_DEPS.writeOutput,
  };
}

async function defaultRecordCost(record) {
  if (!existsSync(CAREER_DIR)) await fs.mkdir(CAREER_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  await fs.appendFile(LLM_COSTS_FILE, line);
}

// Atomic write: tmp file → rename. Returns the relative output path with
// forward slashes (Windows-safe). Cleans up stale tmp on rename failure.
// Both ids regex-validated to defeat path-traversal via hand-edited
// pipeline.json or a corrupted resume index.
async function defaultWriteOutput(jobId, resumeId, content) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new Error(`invalid jobId: ${JSON.stringify(jobId)}`);
  }
  if (typeof resumeId !== 'string' || !RESUME_ID_RE.test(resumeId)) {
    throw new Error(`invalid resumeId: ${JSON.stringify(resumeId)}`);
  }
  if (!existsSync(OUTPUT_DIR)) await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `${jobId}-${resumeId}.md`;
  const finalPath = path.join(OUTPUT_DIR, filename);
  const tmpPath = path.join(OUTPUT_DIR, `.${filename}.tmp`);
  await fs.writeFile(tmpPath, content);
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    throw e;
  }
  return `data/career/output/${filename}`;
}

// Same retry predicate as stageBRunner — instanceof + name + status fallbacks
// make it resilient to cross-module prototype-chain breakage in tests.
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

function errorMessage(err) {
  if (err instanceof ConfigError) return `config: ${err.message}`;
  const name = err?.name ?? 'Error';
  return `${name}: ${String(err?.message ?? err).slice(0, 200)}`;
}

function errorResult(jobId, resumeId, err) {
  return {
    jobId,
    resumeId,
    model: TAILOR_MODEL,
    cost_usd: 0,
    status: STATUS.ERROR,
    error: errorMessage(err),
  };
}

// Single-job tailor lifecycle. NEVER throws — every failure mode lands as
// status:'error'. Caller (m3 endpoint) maps the result onto its own
// response shape.
//
// jobMeta: { id, role, company, location, url, description, ... } (Job
//   from pipeline.json — we only read the LLM-relevant fields)
// resumeId: must be the explicitly resolved id (caller does Auto-Select
//   fallback when missing, NOT this layer)
// userHint: optional string from the Reject-and-Retry flow
// opts: { _client, _recordCost, _sleep, _writeOutput, bundle? }
//   bundle override lets m3/smoke pre-load the bundle once and pass
//   through (also useful when user has multi-tab tailor running)
export async function tailorOneJob(jobMeta, resumeId, userHint, opts = {}) {
  const jobId = jobMeta?.id ?? null;
  const deps = mergeDeps(opts);

  // Validate ids BEFORE any I/O / API call. Defends two failure modes:
  //  (1) Path-traversal: malformed ids interpolated into bundle / output
  //      paths. defaultWriteOutput already validates, but checking here
  //      avoids a wasted Anthropic API call (~$0.01 per malformed id).
  //  (2) Real-money waste: corrupted pipeline.json with non-string
  //      jobId burns API tokens before defaultWriteOutput catches it.
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    return errorResult(jobId, resumeId, new Error(`invalid jobId: ${JSON.stringify(jobId)}`));
  }
  if (typeof resumeId !== 'string' || !RESUME_ID_RE.test(resumeId)) {
    return errorResult(jobId, resumeId, new Error(`invalid resumeId: ${JSON.stringify(resumeId)}`));
  }

  let client;
  try {
    client = deps.client ?? getClient();
  } catch (e) {
    return errorResult(jobId, resumeId, e);
  }

  // Load (or accept pre-loaded) bundle. Wrapped in try/catch — non-ENOENT
  // FS errors (EACCES, EISDIR, EMFILE) would otherwise reject the call;
  // NEVER-throws contract requires a status:'error' result instead.
  let bundle;
  try {
    bundle = opts.bundle ?? (await loadTailorBundle(resumeId, jobId));
  } catch (e) {
    return errorResult(jobId, resumeId, e);
  }

  const params = buildTailorPrompt(jobMeta, bundle, bundle.blockEText, userHint);

  let response;
  try {
    response = await callWithRetry(
      () => client.messages.create(params),
      deps.sleep
    );
  } catch (e) {
    return errorResult(jobId, resumeId, e);
  }

  const usage = response?.usage ?? {};
  const rawCost = computeCostUsd(params.model, usage);
  // Guard NaN propagation (matches Stage B m2 review fix).
  const costUsd = Number.isFinite(rawCost) ? rawCost : 0;

  // Record cost even on parse / write failure — we paid Anthropic regardless.
  // recordCost throw is non-fatal (warn-only).
  try {
    await deps.recordCost({
      caller: TAILOR_CALLER,
      model: params.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      job_id: jobId,
      resume_id: resumeId,
    });
  } catch (e) {
    console.warn('[tailorRunner] cost record failed:', String(e?.message ?? e).slice(0, 200));
  }

  // Parse the response. parseTailorResponse uses concatMarkdownBlocks (\n\n
  // join) so paragraph boundaries survive multi-block responses.
  let parsed;
  try {
    parsed = parseTailorResponse(response?.content);
  } catch (e) {
    return {
      jobId,
      resumeId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `parse: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }

  let outputPath;
  try {
    outputPath = await deps.writeOutput(jobId, resumeId, parsed.markdown);
  } catch (e) {
    return {
      jobId,
      resumeId,
      model: params.model,
      cost_usd: costUsd,
      status: STATUS.ERROR,
      error: `output_write: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }

  return {
    jobId,
    resumeId,
    tailored_markdown: parsed.markdown,
    output_path: outputPath,
    model: params.model,
    cost_usd: costUsd,
    status: STATUS.TAILORED,
  };
}
