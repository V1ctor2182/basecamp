#!/usr/bin/env node
// Smoke for stageBRunner. DI-driven — no real Anthropic calls, no fs writes.
// Each test injects mocks via opts._client / _recordCost / _sleep / _writeReport.
// cvBundle is supplied via opts.cvBundle so the runner doesn't hit disk.

import assert from 'node:assert/strict';
import {
  evaluateJobsStageB,
  STATUS,
  resolveEnabledBlocks,
} from '../src/career/evaluator/stageBRunner.mjs';

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

function fakeError(name, status, message) {
  const e = new Error(message);
  e.name = name;
  if (status != null) e.status = status;
  return e;
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
    scraped_at: '2026-05-04T00:00:00Z',
    comp_hint: { min: 200000, max: 300000, currency: 'USD', period: 'yr' },
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    evaluation: { stage_a: { score: 4.0, status: 'evaluated' }, stage_b: null },
    ...over,
  };
}

const PREFS = {
  thresholds: { strong: 4.5, worth: 4.0, consider: 3.5, skip_below: 3.0 },
  evaluator_strategy: { stage_b: { blocks: { block_c: true, block_f: true } } },
};

const CV_BUNDLE = {
  cv: '# Test CV\nSWE 8y',
  narrative: 'Platform focus.',
  proofPoints: '- Cut latency 40%',
  identity: { name: 'Test' },
  qaFewShot: [],
};

const FULL_REPORT = `## Block A — Role Summary
Strong fit for senior backend role.

## Block B — CV Match
Strong overlap on distributed systems.

## Block C — Level & Strategy
L5 expected. Apply via referral.

## Block E — Personalization Plan
Highlight payments work.

## Block F — Interview Plan
Prepare 3 STAR stories on scaling.

## Block G — Posting Legitimacy
Posted 3 days ago, recruiter active.

**Total: 4.2/5**`;

function makeMockClient(cb) {
  return {
    messages: {
      create: async (params) => (typeof cb === 'function' ? cb(params) : cb),
    },
  };
}

const SAMPLE_USAGE = {
  input_tokens: 5000,
  output_tokens: 800,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 0,
};

function makeOkResponse(text = FULL_REPORT, usage = SAMPLE_USAGE) {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage,
  };
}

const fastSleep = () => async () => {};

// ── Empty input ─────────────────────────────────────────────────────────
await test('empty jobs[] → counters all 0, no API call', async () => {
  let calls = 0;
  const r = await evaluateJobsStageB([], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => { calls++; return makeOkResponse(); }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async () => 'never',
  });
  assert.equal(r.evaluated, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.total_cost_usd, 0);
  assert.deepEqual(r.results, []);
  assert.equal(calls, 0);
});

// ── 3 jobs all evaluated ────────────────────────────────────────────────
await test('3 jobs all OK → evaluated=3, counter sums match results', async () => {
  const writes = [];
  const r = await evaluateJobsStageB(
    [makeJob({ id: 'aaaaaaaaaaaa' }), makeJob({ id: 'bbbbbbbbbbbb' }), makeJob({ id: 'cccccccccccc' })],
    PREFS,
    {
      cvBundle: CV_BUNDLE,
      _client: makeMockClient(() => makeOkResponse()),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      _writeReport: async (jobId, content) => {
        writes.push({ jobId, len: content.length });
        return `data/career/reports/${jobId}.md`;
      },
    }
  );
  assert.equal(r.evaluated, 3);
  assert.equal(r.errors, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.results.length, 3);
  assert.equal(writes.length, 3);
  // Counter sum invariant
  const sumCosts = r.results.reduce((a, x) => a + (x.cost_usd ?? 0), 0);
  assert.ok(Math.abs(sumCosts - r.total_cost_usd) < 0.0001);
  // total_score parsed
  for (const x of r.results) {
    assert.equal(x.total_score, 4.2);
    assert.equal(x.status, STATUS.EVALUATED);
    assert.match(x.report_path, /reports[\\/].*\.md$/);
    assert.ok(Array.isArray(x.blocks_emitted));
    assert.ok(x.blocks_emitted.includes('A'));
    assert.ok(x.blocks_emitted.includes('B'));
  }
});

// ── Idempotent skip ─────────────────────────────────────────────────────
await test('jobs with stage_b already set → skipped', async () => {
  const job = makeJob({
    evaluation: {
      stage_a: { score: 4.0, status: 'evaluated' },
      stage_b: { total_score: 4.0, status: 'evaluated' },
    },
  });
  let calls = 0;
  const r = await evaluateJobsStageB([job], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => { calls++; return makeOkResponse(); }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async () => 'never',
  });
  assert.equal(r.skipped, 1);
  assert.equal(r.evaluated, 0);
  assert.equal(calls, 0);
});

// ── 429 retry ───────────────────────────────────────────────────────────
await test('429 RateLimitError → retries → succeeds', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('RateLimitError', 429, 'rate limit');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.evaluated, 1);
  assert.equal(attempts, 2);
});

// ── 5xx retry ───────────────────────────────────────────────────────────
await test('500 server error → retries → succeeds', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 3) throw fakeError('APIError', 503, 'overloaded');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.evaluated, 1);
  assert.equal(attempts, 3);
});

// ── 408 retry ───────────────────────────────────────────────────────────
await test('408 request timeout → retries', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('APIError', 408, 'timeout');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.evaluated, 1);
  assert.equal(attempts, 2);
});

// ── 401 fast-fail ───────────────────────────────────────────────────────
await test('401 auth error → fast fail (no retry) → status:error', async () => {
  let attempts = 0;
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      throw fakeError('AuthenticationError', 401, 'invalid api key');
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.errors, 1);
  assert.equal(r.evaluated, 0);
  assert.equal(attempts, 1);
  assert.match(r.results[0].error, /401|auth/i);
});

// ── Parse error ─────────────────────────────────────────────────────────
await test('parser failure → status:error, cost still recorded', async () => {
  const costRecords = [];
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() =>
      makeOkResponse('', SAMPLE_USAGE) // empty text → parseStageBResponse throws
    ),
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.errors, 1);
  assert.equal(costRecords.length, 1, 'cost recorded despite parse failure');
  assert.match(r.results[0].error, /parse:/);
  assert.ok(r.results[0].cost_usd > 0);
});

// ── Report write failure ────────────────────────────────────────────────
await test('writeReport throw → status:error, cost still recorded', async () => {
  const costRecords = [];
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeReport: async () => { throw new Error('disk full'); },
  });
  assert.equal(r.errors, 1);
  assert.equal(costRecords.length, 1);
  assert.match(r.results[0].error, /report_write: .*disk full/);
  assert.ok(r.results[0].cost_usd > 0);
});

// ── Cost recording with caller field ────────────────────────────────────
await test('cost record carries caller=evaluator:stage-b + token detail', async () => {
  const costRecords = [];
  await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(costRecords.length, 1);
  assert.equal(costRecords[0].caller, 'evaluator:stage-b');
  assert.equal(costRecords[0].model, 'claude-sonnet-4-6');
  assert.equal(costRecords[0].input_tokens, 5000);
  assert.equal(costRecords[0].output_tokens, 800);
  assert.equal(costRecords[0].cache_read_input_tokens, 4000);
  assert.equal(costRecords[0].job_id, '0123456789ab');
});

// ── Cost record failure is non-fatal ────────────────────────────────────
await test('cost record throw → eval still succeeds (warn-only)', async () => {
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async () => { throw new Error('disk write fail'); },
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(r.evaluated, 1);
  assert.equal(r.errors, 0);
});

// ── Concurrency=3 observable via in-flight counter ──────────────────────
await test('concurrency=3 — max in-flight is 3, never higher', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const jobs = Array.from({ length: 9 }, (_, i) =>
    makeJob({ id: String(i).padStart(12, '0') })
  );
  await evaluateJobsStageB(jobs, PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `reports/${jobId}.md`,
  });
  assert.equal(maxInFlight, 3);
});

// ── Mixed batch (success + parse error + 401) ───────────────────────────
await test('mixed batch — counters and results align', async () => {
  let n = 0;
  const r = await evaluateJobsStageB(
    [
      makeJob({ id: 'aaaaaaaaaaaa' }),
      makeJob({ id: 'bbbbbbbbbbbb' }),
      makeJob({ id: 'cccccccccccc' }),
    ],
    PREFS,
    {
      cvBundle: CV_BUNDLE,
      _client: makeMockClient(() => {
        const i = n++;
        if (i === 0) return makeOkResponse(); // ok
        if (i === 1) return makeOkResponse('', SAMPLE_USAGE); // parse fail
        throw fakeError('AuthenticationError', 401, 'bad key'); // 401
      }),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      _writeReport: async (jobId) => `reports/${jobId}.md`,
    }
  );
  // Batch is concurrent so the per-job mapping is undefined; just check totals.
  assert.equal(r.evaluated + r.errors, 3);
  assert.equal(r.evaluated, 1);
  assert.equal(r.errors, 2);
});

// ── resolveEnabledBlocks re-export ──────────────────────────────────────
await test('resolveEnabledBlocks re-exported from runner module', async () => {
  const enabled = resolveEnabledBlocks(PREFS);
  // PREFS toggles C and F; A/B/E forced-on
  assert.deepEqual(enabled, ['A', 'B', 'C', 'E', 'F']);
});

// ── Degenerate response rejected (review fix C3/H5) ─────────────────────
await test('response missing total_score → status:error (degenerate)', async () => {
  const noTotal = `## Block A — Role Summary
Content.
## Block B — CV Match
Content.
## Block E — Personalization Plan
Content.`; // no total line
  const writes = [];
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => makeOkResponse(noTotal)),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => { writes.push(jobId); return `data/career/reports/${jobId}.md`; },
  });
  assert.equal(r.errors, 1);
  assert.equal(r.evaluated, 0);
  assert.match(r.results[0].error, /degenerate.*missing total_score/);
  assert.equal(writes.length, 0, 'no report written for degenerate response');
});

await test('response missing forced-on Block E → status:error', async () => {
  const missingE = `## Block A — Role Summary
content.
## Block B — CV Match
content.

**Total: 4.0/5**`; // missing E (forced-on)
  const r = await evaluateJobsStageB([makeJob()], PREFS, {
    cvBundle: CV_BUNDLE,
    _client: makeMockClient(() => makeOkResponse(missingE)),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeReport: async (jobId) => `data/career/reports/${jobId}.md`,
  });
  assert.equal(r.errors, 1);
  assert.match(r.results[0].error, /degenerate.*forced.*E/);
});

// ── Path-traversal protection (review fix C2) ───────────────────────────
await test('defaultWriteReport rejects malformed jobId', async () => {
  // Spawn a fresh tmp cwd so the real defaultWriteReport doesn't touch the
  // repo's data/career/reports/ dir.
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-b-runner-smoke-'));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    // Re-import to pick up fresh path.resolve('data') anchor.
    const mod = await import(`../src/career/evaluator/stageBRunner.mjs?t=${Date.now()}`);
    const badJob = makeJob({ id: '../etc/passwd' });
    const r = await mod.evaluateJobsStageB([badJob], PREFS, {
      cvBundle: CV_BUNDLE,
      _client: makeMockClient(() => makeOkResponse()),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      // No _writeReport injection → real defaultWriteReport runs
    });
    assert.equal(r.errors, 1);
    assert.match(r.results[0].error, /report_write: invalid jobId/);
    // Verify nothing escaped
    const escapeAttempt = path.join(tmp, '..', 'etc', 'passwd');
    let leaked = false;
    try { await fs.access(escapeAttempt); leaked = true; } catch {}
    assert.equal(leaked, false);
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── Real atomic-write path coverage (review fix L12) ────────────────────
await test('defaultWriteReport actually writes data/career/reports/{jobId}.md', async () => {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-b-runner-write-'));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import(`../src/career/evaluator/stageBRunner.mjs?t=${Date.now()}_${Math.random()}`);
    const r = await mod.evaluateJobsStageB([makeJob({ id: 'abcdef012345' })], PREFS, {
      cvBundle: CV_BUNDLE,
      _client: makeMockClient(() => makeOkResponse()),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      // No _writeReport injection → real atomic write
    });
    assert.equal(r.evaluated, 1);
    assert.equal(r.results[0].report_path, 'data/career/reports/abcdef012345.md');
    const written = await fs.readFile(
      path.join(tmp, 'data', 'career', 'reports', 'abcdef012345.md'),
      'utf8'
    );
    assert.match(written, /Block A.*Role Summary/);
    // Tmp file cleaned up after rename
    let tmpExists = false;
    try {
      await fs.access(path.join(tmp, 'data', 'career', 'reports', '.abcdef012345.md.tmp'));
      tmpExists = true;
    } catch {}
    assert.equal(tmpExists, false, 'tmp file should be renamed away');
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
