#!/usr/bin/env node
// Smoke for stageARunner. DI-driven — no real Anthropic calls, no fs writes
// to llm-costs.jsonl. Each test injects mocks via opts._client / _recordCost
// / _sleep.

import assert from 'node:assert/strict';
import {
  evaluateJobsStageA,
  STATUS,
} from '../src/career/evaluator/stageARunner.mjs';

// SDK error classes have constructors that expect real Headers objects —
// synthesizing them in tests is brittle (e.g. `new RateLimitError(429, {})`
// throws because the SDK calls `.get()` on the headers arg). The runner's
// `isRetryableError` checks both instanceof AND error.name/status, so test
// errors via the latter — same retry path is exercised.
function fakeError(name, status, message) {
  const e = new Error(message);
  e.name = name;
  if (status != null) e.status = status;
  return e;
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

function makeJob(over = {}) {
  return {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Software Engineer',
    location: ['SF, CA'],
    url: 'https://example.com/jobs/1',
    description: 'Build safe AI. 5+ years required.',
    posted_at: null,
    scraped_at: '2026-05-03T00:00:00Z',
    comp_hint: { min: 200000, max: 300000, currency: 'USD', period: 'yr' },
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: null,
    ...over,
  };
}

const PREFS = {
  thresholds: { strong: 4.5, worth: 4.0, consider: 3.5, skip_below: 3.0 },
};

// Build a mock Anthropic client whose .messages.create returns canned
// content + usage. cb can be a function that receives params and returns the
// response shape, or a static response object.
function makeMockClient(cb) {
  return {
    messages: {
      create: async (params) => (typeof cb === 'function' ? cb(params) : cb),
    },
  };
}

function fastSleep() {
  // Tests inject this so retry backoffs don't actually wait.
  return async () => {};
}

const SAMPLE_USAGE = {
  input_tokens: 1000,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// ── Empty input ─────────────────────────────────────────────────────────
await test('empty jobs[] → counters all 0, no API call', async () => {
  let calls = 0;
  const r = await evaluateJobsStageA([], PREFS, {
    _client: makeMockClient(() => { calls++; return null; }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.evaluated, 0);
  assert.equal(r.archived, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.total_cost_usd, 0);
  assert.deepEqual(r.results, []);
  assert.equal(calls, 0);
});

// ── Happy path: 3 jobs all evaluated ────────────────────────────────────
await test('3 jobs all-evaluated: counters + cost + per-job results', async () => {
  let costRecorded = 0;
  const jobs = [makeJob({ id: 'aaaaaaaaaaa1' }), makeJob({ id: 'aaaaaaaaaaa2' }), makeJob({ id: 'aaaaaaaaaaa3' })];
  const r = await evaluateJobsStageA(jobs, PREFS, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'Score: 4.0/5 — solid match' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async () => { costRecorded++; },
    _sleep: fastSleep(),
    simplifiedCv: 'Senior backend engineer',
  });
  assert.equal(r.evaluated, 3);
  assert.equal(r.archived, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].score, 4);
  assert.equal(r.results[0].status, STATUS.EVALUATED);
  // 3 jobs × $0.001 each = $0.003
  assert.equal(r.total_cost_usd, 0.003);
  assert.equal(costRecorded, 3);
});

// ── Threshold: archive ──────────────────────────────────────────────────
await test('score below skip_below → status archived, NOT evaluated', async () => {
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'Score: 2.5/5 — wrong seniority' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.evaluated, 0);
  assert.equal(r.archived, 1);
  assert.equal(r.results[0].status, STATUS.ARCHIVED);
  assert.equal(r.results[0].score, 2.5);
});

await test('threshold exact-edge: score === skip_below → archived (strict <)', async () => {
  // skip_below = 3.0; score = 3.0 → not archived (3.0 NOT < 3.0)
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'Score: 3.0/5 — borderline' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.results[0].status, STATUS.EVALUATED);
});

await test('threshold from prefs (not hardcoded)', async () => {
  // skip_below 4.0 → score 3.5 → archived
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], { thresholds: { skip_below: 4.0 } }, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'Score: 3.5/5' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.results[0].status, STATUS.ARCHIVED);
});

// ── Skip already-evaluated ──────────────────────────────────────────────
await test('skip jobs that already have evaluation.stage_a (idempotent)', async () => {
  let calls = 0;
  const jobs = [
    makeJob({ id: 'aaaaaaaaaaa1', evaluation: { stage_a: { score: 4.0, status: 'evaluated' } } }),
    makeJob({ id: 'aaaaaaaaaaa2' }),
  ];
  const r = await evaluateJobsStageA(jobs, PREFS, {
    _client: makeMockClient(() => {
      calls++;
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.skipped, 1);
  assert.equal(r.evaluated, 1);
  assert.equal(calls, 1, 'only 1 API call (job 2 only)');
});

await test('skip if evaluation.stage_a.status === error (errored jobs NOT auto-retried)', async () => {
  // Locked design: m4 UI handles manual retry of errored jobs by clearing
  // the field first. m2 treats any stage_a entry as "done".
  let calls = 0;
  const job = makeJob({ id: 'aaaaaaaaaaa1', evaluation: { stage_a: { status: 'error', error: 'parse' } } });
  const r = await evaluateJobsStageA([job], PREFS, {
    _client: makeMockClient(() => { calls++; return null; }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.skipped, 1);
  assert.equal(calls, 0);
});

// ── Retry path ──────────────────────────────────────────────────────────
await test('429 (status) → retry → succeed', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('RateLimitError', 429, 'rate limited');
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 2, 'one retry');
  assert.equal(r.evaluated, 1);
  assert.equal(r.errors, 0);
});

await test('two retries exhausted → status:error (persistent 429)', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      throw fakeError('RateLimitError', 429, 'rate limited');
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 3, '1 initial + 2 retries');
  assert.equal(r.errors, 1);
  assert.equal(r.results[0].status, STATUS.ERROR);
  assert.match(r.results[0].error, /RateLimitError|rate limited/);
});

await test('5xx → retry (server error transient)', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('Error', 503, 'Internal Server Error');
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 2);
  assert.equal(r.evaluated, 1);
});

await test('APIConnectionError (by name) → retry', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('APIConnectionError', null, 'ECONNREFUSED');
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 2);
  assert.equal(r.evaluated, 1);
});

// ── Fast-fail path ──────────────────────────────────────────────────────
await test('401 auth → fast-fail, NO retry, status:error', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      throw fakeError('AuthenticationError', 401, 'invalid api key');
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 1, '4xx auth fast-fails — NO retry');
  assert.equal(r.errors, 1);
  assert.equal(r.results[0].status, STATUS.ERROR);
});

await test('4xx (bad request, not auth) → fast-fail, NO retry', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      const e = new Error('bad request');
      e.status = 400;
      throw e;
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 1);
  assert.equal(r.errors, 1);
});

// ── Parse error ─────────────────────────────────────────────────────────
await test('parse error → status:error, cost still recorded (paid for the API call)', async () => {
  let costRecorded = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'gibberish with no number anywhere' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async () => { costRecorded++; },
    _sleep: fastSleep(),
  });
  assert.equal(r.errors, 1);
  assert.equal(r.results[0].status, STATUS.ERROR);
  assert.match(r.results[0].error, /parse:/);
  assert.equal(costRecorded, 1, 'cost recorded even on parse failure (we paid)');
  assert.ok(r.results[0].cost_usd > 0);
});

// ── 408 timeout retry (review L1 fix) ───────────────────────────────────
await test('408 (request timeout) → retry', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('Error', 408, 'request timeout');
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(attempts, 2, '408 retried');
  assert.equal(r.evaluated, 1);
});

// ── ConfigError per-job fall-through (review L5 fix) ────────────────────
await test('getClient ConfigError → all jobs status:error with config: prefix', async () => {
  // Don't supply _client; force the runner's lazy getClient() path.
  // Unset both env vars so getClient throws ConfigError.
  const { _resetClientForTesting } = await import('../src/career/lib/anthropicClient.mjs');
  _resetClientForTesting();
  const origKey = process.env.ANTHROPIC_API_KEY;
  const origMock = process.env.MOCK_ANTHROPIC;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MOCK_ANTHROPIC;
  try {
    const r = await evaluateJobsStageA(
      [makeJob({ id: 'aaaaaaaaaaa1' }), makeJob({ id: 'aaaaaaaaaaa2' })],
      PREFS,
      { _recordCost: async () => {}, _sleep: fastSleep() }
    );
    assert.equal(r.errors, 2, 'both jobs error out');
    assert.match(r.results[0].error, /^config:/);
    assert.match(r.results[1].error, /^config:/);
    assert.equal(r.results[0].cost_usd, 0, 'no cost when API never called');
  } finally {
    if (origKey != null) process.env.ANTHROPIC_API_KEY = origKey;
    if (origMock != null) process.env.MOCK_ANTHROPIC = origMock;
    _resetClientForTesting();
  }
});

// ── Malformed response shapes (review L6 fix) ───────────────────────────
await test('response.content === undefined → status:error (parse)', async () => {
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({ usage: SAMPLE_USAGE }), // no content field at all
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.errors, 1);
  assert.match(r.results[0].error, /^parse:/);
});

await test('response.content === [] → status:error (parse)', async () => {
  const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({ content: [], usage: SAMPLE_USAGE }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.errors, 1);
});

// ── Mixed batch ─────────────────────────────────────────────────────────
await test('mixed batch: counter sums == jobs.length', async () => {
  // 4 jobs: 1 evaluated (4.0), 1 archived (2.5), 1 error (auth), 1 skipped (already evaluated)
  const jobs = [
    makeJob({ id: 'aaaaaaaaaaa1' }),                                                 // → evaluated
    makeJob({ id: 'aaaaaaaaaaa2' }),                                                 // → archived
    makeJob({ id: 'aaaaaaaaaaa3' }),                                                 // → error
    makeJob({ id: 'aaaaaaaaaaa4', evaluation: { stage_a: { score: 4 } } }),          // → skipped
  ];
  let attempts = 0;
  const r = await evaluateJobsStageA(jobs, PREFS, {
    _client: makeMockClient(() => {
      attempts++;
      if (attempts === 1) return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
      if (attempts === 2) return { content: [{ type: 'text', text: 'Score: 2.5/5' }], usage: SAMPLE_USAGE };
      throw fakeError('AuthenticationError', 401, 'bad key');
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
  });
  assert.equal(r.evaluated, 1);
  assert.equal(r.archived, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.skipped, 1);
  // Counter-sum invariant — evaluated + archived + errors + skipped == jobs.length.
  // Catches double-counting regressions (review L4 fix).
  assert.equal(r.evaluated + r.archived + r.errors + r.skipped, jobs.length);
  // skipped jobs don't appear in results array (only attempted ones do)
  assert.equal(r.results.length, 3);
});

// ── Concurrency observed via in-flight counter ──────────────────────────
await test('concurrency=3: max 3 in-flight observed', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => makeJob({ id: 'aaaaaaaaaaa' + i }));
  let inflight = 0;
  let maxInflight = 0;
  const r = await evaluateJobsStageA(jobs, PREFS, {
    _client: makeMockClient(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((res) => setTimeout(res, 30));
      inflight--;
      return { content: [{ type: 'text', text: 'Score: 4.0/5' }], usage: SAMPLE_USAGE };
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    concurrency: 3,
  });
  assert.equal(r.evaluated, 6);
  assert.equal(maxInflight, 3, `expected max 3 in-flight, got ${maxInflight}`);
});

// ── Cost recording shape ────────────────────────────────────────────────
await test('cost record contains caller, model, tokens, cost, job_id', async () => {
  const records = [];
  await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
    _client: makeMockClient({
      content: [{ type: 'text', text: 'Score: 4.0/5' }],
      usage: SAMPLE_USAGE,
    }),
    _recordCost: async (rec) => records.push(rec),
    _sleep: fastSleep(),
  });
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.caller, 'evaluator:stage-a');
  assert.equal(rec.model, 'claude-haiku-4-5-20251001');
  assert.equal(rec.input_tokens, 1000);
  assert.equal(rec.output_tokens, 50);
  assert.equal(rec.job_id, 'aaaaaaaaaaa1');
  assert.equal(rec.cost_usd, 0.001);
});

// ── Cost record failure doesn't fail the eval ───────────────────────────
await test('cost record throws → eval still succeeds (cost append is non-fatal)', async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = await evaluateJobsStageA([makeJob({ id: 'aaaaaaaaaaa1' })], PREFS, {
      _client: makeMockClient({
        content: [{ type: 'text', text: 'Score: 4.0/5' }],
        usage: SAMPLE_USAGE,
      }),
      _recordCost: async () => { throw new Error('disk full'); },
      _sleep: fastSleep(),
    });
    assert.equal(r.evaluated, 1);
    assert.equal(r.errors, 0);
  } finally {
    console.warn = origWarn;
  }
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
