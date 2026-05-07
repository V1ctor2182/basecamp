#!/usr/bin/env node
// Smoke for tailorRunner. DI-driven — no real Anthropic calls. Each test
// injects mocks via opts._client / _recordCost / _sleep / _writeOutput.
// Bundle is supplied via opts.bundle so the runner doesn't hit disk.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import {
  tailorOneJob,
  STATUS,
} from '../src/career/cv/tailorRunner.mjs';

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

const SAMPLE_JOB = {
  id: '0123456789ab',
  role: 'Senior Backend Engineer',
  company: 'Anthropic',
  location: ['SF, CA'],
  url: 'https://example.com/jobs/1',
  description: 'Build safe distributed AI systems. 5+ years Python.',
};

const SAMPLE_BUNDLE = {
  baseMd: '# Test Candidate\n\n## Summary\nSenior engineer with 8 years.',
  proofPoints: '- Cut p99 latency 40%',
  emphasize: { projects: ['platform'], skills: ['Python'], narrative: 'Reliability focus' },
  identity: { name: 'Test', email: 't@example.com' },
  blockEText: 'Inject "distributed" keyword. Reorder bullets to lead with leadership.',
};

function makeMockClient(cb) {
  return {
    messages: {
      create: async (params) => (typeof cb === 'function' ? cb(params) : cb),
    },
  };
}

const SAMPLE_USAGE = {
  input_tokens: 4000,
  output_tokens: 600,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 0,
};

function makeOkResponse(text = '# Tailored Resume\n\n## Summary\nDistributed-systems engineer with 8 years.', usage = SAMPLE_USAGE) {
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

// ── Happy path ──────────────────────────────────────────────────────────
await test('tailorOneJob: happy path → status:tailored, markdown returned, output written', async () => {
  const writes = [];
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (jobId, resumeId, content) => {
      writes.push({ jobId, resumeId, contentLen: content.length });
      return `data/career/output/${jobId}-${resumeId}.md`;
    },
  });
  assert.equal(r.status, STATUS.TAILORED);
  assert.equal(r.jobId, '0123456789ab');
  assert.equal(r.resumeId, 'default');
  assert.match(r.tailored_markdown, /Distributed-systems engineer/);
  assert.equal(r.output_path, 'data/career/output/0123456789ab-default.md');
  assert.equal(r.model, 'claude-sonnet-4-6');
  assert.ok(r.cost_usd > 0);
  assert.equal(writes.length, 1);
});

// ── Hint propagation ────────────────────────────────────────────────────
await test('tailorOneJob: userHint propagated into prompt user message', async () => {
  let capturedParams;
  await tailorOneJob(SAMPLE_JOB, 'default', 'Do not modify the Summary section.', {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient((params) => { capturedParams = params; return makeOkResponse(); }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (j, r) => `data/career/output/${j}-${r}.md`,
  });
  const userContent = capturedParams.messages[0].content;
  assert.match(userContent, /## User Hint/);
  assert.match(userContent, /Do not modify the Summary section/);
});

// ── Retry on transient errors ───────────────────────────────────────────
await test('tailorOneJob: 429 RateLimitError → retries → succeeds', async () => {
  let attempts = 0;
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('RateLimitError', 429, 'rate limit');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.TAILORED);
  assert.equal(attempts, 2);
});

await test('tailorOneJob: 503 server error → retries → succeeds', async () => {
  let attempts = 0;
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 3) throw fakeError('APIError', 503, 'overloaded');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.TAILORED);
  assert.equal(attempts, 3);
});

await test('tailorOneJob: 408 timeout → retries → succeeds', async () => {
  let attempts = 0;
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      if (attempts < 2) throw fakeError('APIError', 408, 'timeout');
      return makeOkResponse();
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.TAILORED);
  assert.equal(attempts, 2);
});

// ── 401 fast-fail ───────────────────────────────────────────────────────
await test('tailorOneJob: 401 auth error → fast fail → status:error, no retry', async () => {
  let attempts = 0;
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => {
      attempts++;
      throw fakeError('AuthenticationError', 401, 'invalid api key');
    }),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.ERROR);
  assert.equal(attempts, 1);
  assert.match(r.error, /401|auth/i);
});

// ── Parse error ─────────────────────────────────────────────────────────
await test('tailorOneJob: empty response text → status:error, cost recorded', async () => {
  const costRecords = [];
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse('')), // empty text → ParseError
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.error, /parse:/);
  assert.equal(costRecords.length, 1, 'cost recorded despite parse failure');
  assert.ok(r.cost_usd > 0);
});

// ── Output write failure ────────────────────────────────────────────────
await test('tailorOneJob: writeOutput throw → status:error, cost recorded', async () => {
  const costRecords = [];
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeOutput: async () => { throw new Error('disk full'); },
  });
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.error, /output_write: .*disk full/);
  assert.equal(costRecords.length, 1);
  assert.ok(r.cost_usd > 0);
});

// ── Cost record schema ──────────────────────────────────────────────────
await test('tailorOneJob: cost record carries caller=cv-tailor + token detail + ids', async () => {
  const costRecords = [];
  await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async (rec) => { costRecords.push(rec); },
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(costRecords.length, 1);
  assert.equal(costRecords[0].caller, 'cv-tailor');
  assert.equal(costRecords[0].model, 'claude-sonnet-4-6');
  assert.equal(costRecords[0].input_tokens, 4000);
  assert.equal(costRecords[0].output_tokens, 600);
  assert.equal(costRecords[0].cache_read_input_tokens, 3000);
  assert.equal(costRecords[0].job_id, '0123456789ab');
  assert.equal(costRecords[0].resume_id, 'default');
});

// ── Cost record failure non-fatal ───────────────────────────────────────
await test('tailorOneJob: cost record throw → eval still succeeds (warn-only)', async () => {
  const r = await tailorOneJob(SAMPLE_JOB, 'default', undefined, {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async () => { throw new Error('disk write fail'); },
    _sleep: fastSleep(),
    _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
  });
  assert.equal(r.status, STATUS.TAILORED);
});

// ── Path-traversal defense in defaultWriteOutput ────────────────────────
await test('defaultWriteOutput: rejects malformed jobId (path traversal)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tailor-runner-smoke-'));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import(`../src/career/cv/tailorRunner.mjs?t=${Date.now()}_${Math.random()}`);
    const badJob = { ...SAMPLE_JOB, id: '../etc/passwd' };
    const r = await mod.tailorOneJob(badJob, 'default', undefined, {
      bundle: SAMPLE_BUNDLE,
      _client: makeMockClient(() => makeOkResponse()),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      // No _writeOutput → real defaultWriteOutput runs
    });
    assert.equal(r.status, STATUS.ERROR);
    // Runner now short-circuits BEFORE any API call (review fix) — error
    // message comes from the early-id-validation guard, not output_write.
    assert.match(r.error, /invalid jobId/);
    let leaked = false;
    try { await fs.access(path.join(tmp, '..', 'etc', 'passwd')); leaked = true; } catch {}
    assert.equal(leaked, false);
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('runner: rejects malformed resumeId BEFORE API call (path traversal + cost defense)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tailor-runner-smoke-'));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import(`../src/career/cv/tailorRunner.mjs?t=${Date.now()}_${Math.random()}`);
    let apiCalls = 0;
    const r = await mod.tailorOneJob(SAMPLE_JOB, '../config', undefined, {
      bundle: SAMPLE_BUNDLE,
      _client: makeMockClient(() => { apiCalls++; return makeOkResponse(); }),
      _recordCost: async () => {},
      _sleep: fastSleep(),
    });
    assert.equal(r.status, STATUS.ERROR);
    assert.match(r.error, /invalid resumeId/);
    // Verify NO API call was made — the whole point of the early-validation
    // fix is to avoid burning Anthropic tokens on malformed ids.
    assert.equal(apiCalls, 0, 'malformed resumeId must short-circuit before API call');
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── Real atomic-write path coverage ─────────────────────────────────────
await test('defaultWriteOutput: real atomic write to data/career/output/{jobId}-{resumeId}.md', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tailor-runner-write-'));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import(`../src/career/cv/tailorRunner.mjs?t=${Date.now()}_${Math.random()}`);
    const r = await mod.tailorOneJob(SAMPLE_JOB, 'backend', undefined, {
      bundle: SAMPLE_BUNDLE,
      _client: makeMockClient(() => makeOkResponse()),
      _recordCost: async () => {},
      _sleep: fastSleep(),
    });
    assert.equal(r.status, STATUS.TAILORED);
    assert.equal(r.output_path, 'data/career/output/0123456789ab-backend.md');
    const written = await fs.readFile(
      path.join(tmp, 'data', 'career', 'output', '0123456789ab-backend.md'),
      'utf8'
    );
    assert.match(written, /Tailored Resume/);
    // Tmp file cleaned up after rename
    let tmpExists = false;
    try {
      await fs.access(path.join(tmp, 'data', 'career', 'output', '.0123456789ab-backend.md.tmp'));
      tmpExists = true;
    } catch {}
    assert.equal(tmpExists, false, 'tmp file should be renamed away');
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── loadTailorBundle: graceful on missing files (separate test) ─────────
await test('loadTailorBundle: missing files → empty bundle, no throw', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tailor-bundle-smoke-'));
  const orig = process.cwd();
  process.chdir(tmp);
  await fs.mkdir(path.join(tmp, 'data', 'career', 'reports'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'data', 'career', 'resumes'), { recursive: true });
  try {
    const mod = await import(`../src/career/cv/tailorBundle.mjs?t=${Date.now()}_${Math.random()}`);
    const b = await mod.loadTailorBundle('nonexistent', '0123456789ab');
    assert.equal(b.baseMd, '');
    assert.equal(b.proofPoints, '');
    assert.deepEqual(b.emphasize, {});
    assert.deepEqual(b.identity, {});
    assert.equal(b.blockEText, '');
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

await test('loadTailorBundle: full happy fixture → all fields populated', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tailor-bundle-happy-'));
  const orig = process.cwd();
  process.chdir(tmp);
  await fs.mkdir(path.join(tmp, 'data', 'career', 'reports'), { recursive: true });
  const resumeDir = path.join(tmp, 'data', 'career', 'resumes', 'backend');
  await fs.mkdir(resumeDir, { recursive: true });
  try {
    await fs.writeFile(path.join(resumeDir, 'base.md'), '# CANDIDATE BASE');
    await fs.writeFile(
      path.join(resumeDir, 'metadata.yml'),
      "archetype: backend\nemphasize:\n  projects: [foo, bar]\n  skills: [Python]\n"
    );
    await fs.writeFile(path.join(tmp, 'data', 'career', 'proof-points.md'), '- proof line');
    await fs.writeFile(path.join(tmp, 'data', 'career', 'identity.yml'), 'name: Test\n');
    await fs.writeFile(
      path.join(tmp, 'data', 'career', 'reports', 'aabbccddeeff.md'),
      '## Block E — Personalization Plan\nReorder things.\n\n**Total: 4.0/5**'
    );
    const mod = await import(`../src/career/cv/tailorBundle.mjs?t=${Date.now()}_${Math.random()}`);
    const b = await mod.loadTailorBundle('backend', 'aabbccddeeff');
    assert.match(b.baseMd, /CANDIDATE BASE/);
    assert.match(b.proofPoints, /proof line/);
    assert.deepEqual(b.emphasize.projects, ['foo', 'bar']);
    assert.deepEqual(b.emphasize.skills, ['Python']);
    assert.equal(b.identity.name, 'Test');
    assert.match(b.blockEText, /Reorder things/);
  } finally {
    process.chdir(orig);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── Early-validation: non-string id types caught (review fix HIGH) ──────
await test('tailorOneJob: non-string jobId (numeric / undefined) → status:error, no API call', async () => {
  const cases = [
    { id: 12345 }, // numeric id
    { id: undefined }, // missing id
    { id: 'not-hex-id' }, // wrong format
    {}, // no id at all
  ];
  for (const jobMeta of cases) {
    let apiCalls = 0;
    const r = await tailorOneJob(jobMeta, 'default', undefined, {
      bundle: SAMPLE_BUNDLE,
      _client: makeMockClient(() => { apiCalls++; return makeOkResponse(); }),
      _recordCost: async () => {},
      _sleep: fastSleep(),
      _writeOutput: async (j, rid) => `data/career/output/${j}-${rid}.md`,
    });
    assert.equal(r.status, STATUS.ERROR, `expected error for jobMeta=${JSON.stringify(jobMeta)}`);
    assert.match(r.error, /invalid jobId/);
    assert.equal(apiCalls, 0);
  }
});

// ── No idempotency: re-run with hint produces new output ────────────────
await test('tailorOneJob: no idempotency gate (re-run with hint is the expected path)', async () => {
  // Simulate two consecutive runs (with different hints) — both succeed.
  const writes = [];
  const writeOutput = async (jobId, resumeId, content) => {
    writes.push({ jobId, resumeId, contentLen: content.length });
    return `data/career/output/${jobId}-${resumeId}.md`;
  };
  const opts = {
    bundle: SAMPLE_BUNDLE,
    _client: makeMockClient(() => makeOkResponse()),
    _recordCost: async () => {},
    _sleep: fastSleep(),
    _writeOutput: writeOutput,
  };
  const r1 = await tailorOneJob(SAMPLE_JOB, 'default', undefined, opts);
  const r2 = await tailorOneJob(SAMPLE_JOB, 'default', 'Do not touch the Summary', opts);
  assert.equal(r1.status, STATUS.TAILORED);
  assert.equal(r2.status, STATUS.TAILORED);
  assert.equal(writes.length, 2);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
