#!/usr/bin/env node
// Smoke for Stage A m1: anthropicClient + stageAPrompt module.
// All assertions run in MOCK_ANTHROPIC=1 mode — no real API calls.

import assert from 'node:assert/strict';
import {
  getClient,
  ConfigError,
  APIError,
  AuthenticationError,
  RateLimitError,
  _resetClientForTesting,
} from '../src/career/lib/anthropicClient.mjs';
import {
  buildStageAPrompt,
  parseStageAResponse,
  clampScore,
  ParseError,
  STAGE_A_MODEL,
} from '../src/career/evaluator/stageAPrompt.mjs';

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

// ── Anthropic SDK loaded ────────────────────────────────────────────────
await test('SDK is importable; error classes re-exported', async () => {
  const sdk = await import('@anthropic-ai/sdk');
  assert.ok(sdk.default, '@anthropic-ai/sdk default export exists');
  // Error classes match the SDK's namespace
  assert.equal(typeof APIError, 'function');
  assert.equal(typeof AuthenticationError, 'function');
  assert.equal(typeof RateLimitError, 'function');
  // Import + verify all 4 error classes are real (review L4 fix)
  const { APIConnectionError } = await import('../src/career/lib/anthropicClient.mjs');
  assert.equal(typeof APIConnectionError, 'function');
});

// ── getClient: no key → ConfigError ─────────────────────────────────────
await test('getClient throws ConfigError when ANTHROPIC_API_KEY unset and not mock', () => {
  _resetClientForTesting();
  const origKey = process.env.ANTHROPIC_API_KEY;
  const origMock = process.env.MOCK_ANTHROPIC;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MOCK_ANTHROPIC;
  try {
    assert.throws(() => getClient(), ConfigError);
  } finally {
    if (origKey != null) process.env.ANTHROPIC_API_KEY = origKey;
    if (origMock != null) process.env.MOCK_ANTHROPIC = origMock;
    _resetClientForTesting();
  }
});

// ── getClient: MOCK_ANTHROPIC=1 ─────────────────────────────────────────
await test('MOCK_ANTHROPIC=1 returns mock client with .messages.create()', async () => {
  _resetClientForTesting();
  const orig = process.env.MOCK_ANTHROPIC;
  process.env.MOCK_ANTHROPIC = '1';
  try {
    const c = getClient();
    assert.ok(c, 'mock client returned');
    const r = await c.messages.create({
      model: STAGE_A_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.ok(Array.isArray(r.content));
    assert.equal(r.content[0].type, 'text');
    assert.match(r.content[0].text, /Score:/);
    assert.equal(typeof r.usage.input_tokens, 'number');
    assert.equal(typeof r.usage.output_tokens, 'number');
    // cache_*_input_tokens is `number | null` per SDK v0.92.0 type. Mock
    // returns null (matches real-API shape when caching is not used).
    assert.ok(
      r.usage.cache_read_input_tokens === null || typeof r.usage.cache_read_input_tokens === 'number'
    );
  } finally {
    if (orig != null) process.env.MOCK_ANTHROPIC = orig;
    else delete process.env.MOCK_ANTHROPIC;
    _resetClientForTesting();
  }
});

// ── getClient: cached on second call ────────────────────────────────────
await test('getClient caches the client (idempotent)', () => {
  _resetClientForTesting();
  const orig = process.env.MOCK_ANTHROPIC;
  process.env.MOCK_ANTHROPIC = '1';
  try {
    const a = getClient();
    const b = getClient();
    assert.equal(a, b, 'second call returns same instance');
  } finally {
    if (orig != null) process.env.MOCK_ANTHROPIC = orig;
    else delete process.env.MOCK_ANTHROPIC;
    _resetClientForTesting();
  }
});

// ── buildStageAPrompt: shape + cache_control ────────────────────────────
function makeJob(over = {}) {
  return {
    id: 'aaaabbbbcccc',
    source: { type: 'greenhouse', name: 'Anthropic', url: null },
    company: 'Anthropic',
    role: 'Senior Software Engineer',
    location: ['San Francisco, CA'],
    url: 'https://example.com/jobs/1',
    description: 'Build safe AI. 5+ years Python or Go required.',
    posted_at: null,
    scraped_at: '2026-05-02T00:00:00Z',
    comp_hint: { min: 200000, max: 300000, currency: 'USD', period: 'yr' },
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: false,
    ...over,
  };
}

await test('buildStageAPrompt: model pinned + system has ONE cache_control block', () => {
  const params = buildStageAPrompt(
    makeJob(),
    { targets: [{ title: 'SWE', seniority: 'IC4' }] },
    'Senior backend, 6yr Python.'
  );
  assert.equal(params.model, STAGE_A_MODEL);
  assert.equal(params.max_tokens, 256);
  assert.ok(Array.isArray(params.system));
  assert.equal(params.system.length, 1, 'single system block (locked design)');
  assert.equal(params.system[0].type, 'text');
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
});

await test('buildStageAPrompt: user message includes JD body + comp + location', () => {
  const params = buildStageAPrompt(makeJob(), {}, 'CV summary');
  const userText = params.messages[0].content;
  assert.match(userText, /Senior Software Engineer/);
  assert.match(userText, /Anthropic/);
  assert.match(userText, /San Francisco, CA/);
  assert.match(userText, /200000–300000 USD\/yr/);
  assert.match(userText, /5\+ years Python/);
});

await test('buildStageAPrompt: missing description handled gracefully', () => {
  const params = buildStageAPrompt(makeJob({ description: null }), {}, 'CV');
  assert.match(params.messages[0].content, /JD body unavailable/);
});

await test('buildStageAPrompt: empty prefs + missing CV produce a usable system block', () => {
  const params = buildStageAPrompt(makeJob(), {}, '');
  assert.match(params.system[0].text, /no CV summary/);
  assert.match(params.system[0].text, /no target roles/);
});

// ── parseStageAResponse: 5 input formats ────────────────────────────────
await test('parse: JSON shape `{"score": 3.5, "reason": "..."}`', () => {
  const r = parseStageAResponse('{"score": 3.5, "reason": "marginal seniority"}');
  assert.equal(r.score, 3.5);
  assert.equal(r.reason, 'marginal seniority');
});

await test('parse: documented format "Score: 4.0/5 — reason"', () => {
  const r = parseStageAResponse('Score: 4.0/5 — strong backend AI infra fit');
  assert.equal(r.score, 4);
  assert.equal(r.reason, 'strong backend AI infra fit');
});

await test('parse: numeric prefix "3.5: reason"', () => {
  const r = parseStageAResponse('3.5: solid match on Python');
  assert.equal(r.score, 3.5);
  assert.equal(r.reason, 'solid match on Python');
});

await test('parse: numeric only', () => {
  const r = parseStageAResponse('4.5');
  assert.equal(r.score, 4.5);
  assert.equal(r.reason, '');
});

await test('parse: malformed (no number) → ParseError', () => {
  assert.throws(() => parseStageAResponse('I think this looks great!'), ParseError);
});

// ── Review-fix regression tests ─────────────────────────────────────────
await test('parse [H1]: multi-digit/decimal score "Score: 3.55 — reason"', () => {
  // Pre-fix the regex would capture "3.5" leaving "5 — reason" as junk.
  const r = parseStageAResponse('Score: 3.55 — strong fit');
  assert.equal(r.score, 3.6, 'rounds 3.55 → 3.6 cleanly');
  assert.equal(r.reason, 'strong fit');
});

await test('parse [H1]: out-of-range "Score: 10/5" still parses + clamps', () => {
  const r = parseStageAResponse('Score: 10/5 — overshoot');
  assert.equal(r.score, 5, 'clamps to 5');
  assert.equal(r.reason, 'overshoot');
});

await test('parse [H2]: arbitrary prefix "Output: 3.5 — reason"', () => {
  // Pre-fix tier-3 anchored ^ rejected this.
  const r = parseStageAResponse('Output: 3.5 — solid match');
  assert.equal(r.score, 3.5);
  assert.match(r.reason, /solid match/);
});

await test('parse [H2]: "Result: 4.0/5 — reason"', () => {
  const r = parseStageAResponse('Result: 4.0/5 — strong on backend');
  assert.equal(r.score, 4);
  assert.match(r.reason, /strong on backend/);
});

await test('parse [M1]: pure JSON full-document parse', () => {
  // Tier 0 (full JSON.parse) handles this even with whitespace.
  const r = parseStageAResponse('  {"score": 3.5, "reason": "tight"}  ');
  assert.equal(r.score, 3.5);
  assert.equal(r.reason, 'tight');
});

await test('parse [M1]: JSON with string-valued score "score": "3.5"', () => {
  // clampScore coerces strings; tier 0 reads score directly from JSON.parse.
  const r = parseStageAResponse('{"score": "3.5", "reason": "ok"}');
  assert.equal(r.score, 3.5);
  assert.equal(r.reason, 'ok');
});

await test('parse [L1]: multi-line response with Score on line 2', () => {
  // /im flag on tier 2 should match across lines.
  const r = parseStageAResponse('Hmm.\nScore: 3.5 — solid');
  assert.equal(r.score, 3.5);
});

// ── Mock usage shape (review M2 fix) ────────────────────────────────────
await test('mock usage: cache fields are null (match real SDK shape)', async () => {
  _resetClientForTesting();
  const orig = process.env.MOCK_ANTHROPIC;
  process.env.MOCK_ANTHROPIC = '1';
  try {
    const c = getClient();
    const r = await c.messages.create({ model: STAGE_A_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    // Match the real SDK v0.92.0: `number | null` for cache fields.
    assert.equal(r.usage.cache_creation_input_tokens, null);
    assert.equal(r.usage.cache_read_input_tokens, null);
  } finally {
    if (orig != null) process.env.MOCK_ANTHROPIC = orig;
    else delete process.env.MOCK_ANTHROPIC;
    _resetClientForTesting();
  }
});

// ── Comp hint all-null suppression (review L2 fix) ──────────────────────
await test('buildStageAPrompt [L2]: comp_hint with all-null fields → no Comp hint line', async () => {
  const { buildStageAPrompt } = await import('../src/career/evaluator/stageAPrompt.mjs');
  const params = buildStageAPrompt(
    makeJob({ comp_hint: { min: null, max: null, currency: null, period: null } }),
    {},
    'CV'
  );
  assert.doesNotMatch(params.messages[0].content, /Comp hint/);
});

await test('parse: empty/whitespace → ParseError', () => {
  assert.throws(() => parseStageAResponse(''), ParseError);
  assert.throws(() => parseStageAResponse('   '), ParseError);
});

await test('parse: non-string input → ParseError', () => {
  assert.throws(() => parseStageAResponse(null), ParseError);
  assert.throws(() => parseStageAResponse(undefined), ParseError);
  assert.throws(() => parseStageAResponse(3.5), ParseError);
});

// ── clampScore boundaries ───────────────────────────────────────────────
await test('clampScore: out-of-range clamps to [1.0, 5.0]', () => {
  assert.equal(clampScore(0.5), 1);
  assert.equal(clampScore(0), 1);
  assert.equal(clampScore(6), 5);
  assert.equal(clampScore(100), 5);
});

await test('clampScore: rounds to 1 decimal', () => {
  assert.equal(clampScore(3.55), 3.6);
  assert.equal(clampScore(3.54), 3.5);
  assert.equal(clampScore(3.5), 3.5);
  assert.equal(clampScore(4), 4);
});

await test('clampScore: coerces numeric strings', () => {
  assert.equal(clampScore('3.5'), 3.5);
  assert.equal(clampScore('4'), 4);
});

await test('clampScore: NaN / Infinity / non-numeric → ParseError', () => {
  assert.throws(() => clampScore(NaN), ParseError);
  assert.throws(() => clampScore(Infinity), ParseError);
  assert.throws(() => clampScore('not a number'), ParseError);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
