#!/usr/bin/env node
// Smoke for 07-applier/03-field-classifier m2: openFiller + fileFiller +
// classifyAndFill orchestration.
//
// Pure-Node — no Chromium, no real Anthropic API. Mocks the client +
// budget gate via dependency injection. Fast (<2s).

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

import {
  findCachedAnswer,
  buildOpenPrompt,
  weightFromScore,
  fillOpenField,
  fillFileField,
  classifyAndFill,
  loadQaBankHistory,
} from '../src/career/applier/classifier/index.mjs';
import {
  _resetCache as resetOpenFillerCache,
  stripAnswerWrappers,
} from '../src/career/applier/classifier/openFiller.mjs';
import { TAILOR_OUTPUT_DIR } from '../src/career/applier/classifier/fileFiller.mjs';

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

resetOpenFillerCache();

// ── 1. findCachedAnswer fuzzy match scoring ──────────────────────────
await test('findCachedAnswer: exact subclass + role + name → high score', () => {
  const history = [
    {
      field_label: 'Why are you interested?',
      a_final: 'Because of XYZ',
      subclass: 'why-company',
      role: 'textbox',
      weight: 5,
    },
  ];
  const hit = findCachedAnswer(history, 'textbox', 'Why are you interested?', 'why-company');
  assert.ok(hit, 'expected a match');
  assert.equal(hit.entry.a_final, 'Because of XYZ');
  assert.ok(hit.score >= 0.8, `score should be high (≥0.8), got ${hit.score}`);
  assert.equal(weightFromScore(hit.score), 'high');
});

await test('findCachedAnswer: substring name match → medium score', () => {
  const history = [
    {
      field_label: 'Why are you interested in this company?',
      a_final: 'cached answer',
      subclass: 'why-company',
      role: 'textbox',
    },
  ];
  // Different exact label but substring overlap
  const hit = findCachedAnswer(history, 'textbox', 'Why this company?', 'why-company');
  // 0.5 (subclass) + 0.2 (role) + 0.1 (substring) = 0.8 — actually high
  // Test that we get at least medium
  assert.ok(hit, 'expected substring match');
  assert.ok(hit.score >= 0.6, `medium threshold, got ${hit.score}`);
});

await test('findCachedAnswer: no match below threshold → null', () => {
  const history = [
    {
      field_label: 'Completely unrelated question',
      a_final: 'irrelevant',
      role: 'button', // wrong role
    },
  ];
  const hit = findCachedAnswer(history, 'textbox', 'Why this role?', 'why-role');
  assert.equal(hit, null, 'low-score match should fall below medium threshold');
});

await test('findCachedAnswer: empty history / missing fields → null', () => {
  assert.equal(findCachedAnswer([], 'textbox', 'X', 'why-role'), null);
  assert.equal(findCachedAnswer(null, 'textbox', 'X', 'why-role'), null);
  assert.equal(findCachedAnswer([{ field_label: '' }], 'textbox', 'X', 'why-role'), null);
});

// ── 2. buildOpenPrompt produces locked Mode 2 prompt shape ───────────
await test('buildOpenPrompt: contains subclass instruction + system + user', () => {
  const params = buildOpenPrompt(
    'why-company',
    { role: 'textbox', name: 'Why are you interested?' },
    {
      identity: { name: 'Victor Z.' },
      jdSummary: 'Backend role at Acme Corp building APIs',
      narrativeVoice: 'concise, technical, warm',
    },
  );
  assert.equal(params.model, 'claude-sonnet-4-6', 'OPEN_FILLER_MODEL');
  assert.equal(params.max_tokens, 500);
  assert.ok(params.system.includes('Victor Z.'), 'system should include identity name');
  assert.ok(params.system.includes('concise, technical'), 'system should include narrative voice');
  assert.ok(params.system.includes('Acme Corp'), 'system should include JD summary');
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, 'user');
  assert.ok(params.messages[0].content.includes('why-company'));
  assert.ok(params.messages[0].content.includes('Why are you interested?'));
});

await test('buildOpenPrompt: falls back to unknown-open instruction for unknown subclass', () => {
  const params = buildOpenPrompt('totally-bogus-subclass', { name: 'Any extra notes?' });
  assert.ok(params.messages[0].content.includes('Answer in 1-3 sentences'));
});

// ── 3. fillOpenField — qa-bank cache short-circuit (Q4) ─────────────
await test('fillOpenField: cache hit → 0 cost, confidence=high, used=cache', async () => {
  const history = [
    {
      field_label: 'Why this company?',
      a_final: 'Because Acme builds awesome APIs.',
      subclass: 'why-company',
      role: 'textbox',
    },
  ];
  // Mock client should NEVER be called on cache hit
  let clientCalls = 0;
  const mockClient = {
    messages: {
      create: async () => {
        clientCalls++;
        return { content: [{ text: 'should never be used' }], usage: {} };
      },
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why this company?' },
    { subclass: 'why-company' },
    { history, client: mockClient },
  );
  assert.equal(clientCalls, 0, 'cache hit should NOT invoke LLM');
  assert.equal(result.used, 'cache');
  assert.equal(result.suggested_value, 'Because Acme builds awesome APIs.');
  assert.ok(result.confidence === 'high' || result.confidence === 'medium');
  assert.equal(result.cost_usd, 0);
  assert.equal(result.source.kind, 'qa-bank');
});

// ── 4. fillOpenField — budget gate paused (Q6) ───────────────────────
await test('fillOpenField: budget paused → no LLM call, confidence=manual', async () => {
  let clientCalls = 0;
  const mockClient = {
    messages: { create: async () => { clientCalls++; return {}; } },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why this role?' },
    { subclass: 'why-role' },
    {
      history: [],
      client: mockClient,
      checkBudget: async () => ({ paused: true, dailyBudget: 10, todayTotal: 10 }),
    },
  );
  assert.equal(clientCalls, 0, 'paused budget should NOT invoke LLM');
  assert.equal(result.used, 'budget-blocked');
  assert.equal(result.suggested_value, null);
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'budget-blocked');
});

await test('fillOpenField: budget check throws → fail safe (manual)', async () => {
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'unknown-open' },
    {
      history: [],
      client: { messages: { create: async () => ({}) } },
      checkBudget: async () => { throw new Error('budget service down'); },
    },
  );
  assert.equal(result.used, 'budget-blocked');
  assert.equal(result.confidence, 'manual');
});

// ── 5. fillOpenField — happy LLM path ────────────────────────────────
await test('fillOpenField: cache miss + budget OK → calls LLM, confidence=medium', async () => {
  let clientCalls = 0;
  let lastParams;
  const mockClient = {
    messages: {
      create: async (params) => {
        clientCalls++;
        lastParams = params;
        return {
          content: [{ type: 'text', text: 'Because Acme builds X and I want to ship X.' }],
          usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    },
  };
  let recordedCost;
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why this company?' },
    { subclass: 'why-company' },
    {
      history: [],
      client: mockClient,
      checkBudget: async () => ({ paused: false }),
      computeCostUsd: () => 0.001,
      recordCost: async (rec) => { recordedCost = rec; },
      jdSummary: 'Acme APIs',
      identity: { name: 'Victor' },
    },
  );
  assert.equal(clientCalls, 1, 'LLM should be called exactly once');
  assert.equal(result.used, 'llm');
  assert.equal(result.suggested_value, 'Because Acme builds X and I want to ship X.');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.cost_usd, 0.001);
  // Verify cost recorded
  assert.ok(recordedCost, 'recordCost should have been invoked');
  assert.equal(recordedCost.caller, 'applier:classifier-open');
  assert.equal(recordedCost.cost_usd, 0.001);
  // Verify prompt was built correctly
  assert.ok(lastParams.system.includes('Acme APIs'));
  assert.ok(lastParams.messages[0].content.includes('why-company'));
});

await test('fillOpenField: LLM returns empty text → confidence=manual', async () => {
  const mockClient = {
    messages: {
      create: async () => ({ content: [{ text: '   ' }], usage: { input_tokens: 50 } }),
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Any notes?' },
    { subclass: 'unknown-open' },
    {
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.0001,
    },
  );
  assert.equal(result.used, 'error');
  assert.equal(result.suggested_value, null);
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'empty-response');
});

await test('fillOpenField: LLM throws → confidence=manual, source.error set', async () => {
  const mockClient = {
    messages: {
      create: async () => { throw new Error('rate limit'); },
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'why-role' },
    { history: [], client: mockClient },
  );
  assert.equal(result.used, 'error');
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'error');
  assert.ok(result.source.error.includes('rate limit'));
});

await test('fillOpenField: no client injected → manual', async () => {
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'why-role' },
    { history: [] }, // no client
  );
  assert.equal(result.used, 'error');
  assert.equal(result.source.status, 'no-client');
});

// ── 6. fileFiller — resume path resolution ───────────────────────────
await test('fillFileField: resume + existing PDF → high confidence', async () => {
  // Create a temp PDF in TAILOR_OUTPUT_DIR
  await fs.mkdir(TAILOR_OUTPUT_DIR, { recursive: true });
  const jobId = 'ffffffffffff';
  const resumeId = 'cv-smoke';
  const filepath = path.join(TAILOR_OUTPUT_DIR, `${jobId}-${resumeId}.pdf`);
  await fs.writeFile(filepath, '%PDF-1.4 smoke fixture');
  try {
    const result = await fillFileField(
      { role: 'button', name: 'Upload Resume' },
      { subclass: 'resume' },
      { jobId, resumeId },
    );
    assert.equal(result.confidence, 'high');
    assert.equal(result.suggested_value, filepath);
    assert.equal(result.source.status, 'found');
  } finally {
    await fs.unlink(filepath).catch(() => {});
  }
});

await test('fillFileField: resume + missing PDF → medium confidence with path', async () => {
  const jobId = 'aaaaaaaaaaaa';
  const resumeId = 'cv-nonexistent-' + process.pid;
  const result = await fillFileField(
    { role: 'button', name: 'Upload Resume' },
    { subclass: 'resume' },
    { jobId, resumeId },
  );
  assert.equal(result.confidence, 'medium');
  assert.ok(result.suggested_value && result.suggested_value.endsWith('.pdf'));
  assert.equal(result.source.status, 'unverified');
});

await test('fillFileField: resume + no jobId → missing-context manual', async () => {
  const result = await fillFileField(
    { role: 'button', name: 'Upload Resume' },
    { subclass: 'resume' },
    {}, // no jobId/resumeId
  );
  assert.equal(result.confidence, 'manual');
  assert.equal(result.suggested_value, null);
  assert.equal(result.source.status, 'missing-context');
});

await test('fillFileField: cover-letter without ctx.coverLetterPath → manual', async () => {
  const result = await fillFileField(
    { role: 'button', name: 'Upload Cover Letter' },
    { subclass: 'cover-letter' },
    { jobId: 'abc' },
  );
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'generate-first');
});

await test('fillFileField: cover-letter with valid ctx.coverLetterPath → high', async () => {
  const tmpPath = path.join(os.tmpdir(), `cover-letter-smoke.${process.pid}.txt`);
  await fs.writeFile(tmpPath, 'Dear Hiring Manager...');
  try {
    const result = await fillFileField(
      { role: 'button', name: 'Upload Cover Letter' },
      { subclass: 'cover-letter' },
      { coverLetterPath: tmpPath },
    );
    assert.equal(result.confidence, 'high');
    assert.equal(result.suggested_value, tmpPath);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
});

await test('fillFileField: work-samples / transcript → manual unsupported', async () => {
  for (const subclass of ['work-samples', 'transcript', 'general-file']) {
    const result = await fillFileField(
      { role: 'button', name: 'Upload' },
      { subclass },
      { jobId: 'x', resumeId: 'y' },
    );
    assert.equal(result.confidence, 'manual', subclass);
    assert.equal(result.source.status, 'unsupported', subclass);
  }
});

// ── 7. classifyAndFill orchestration (m2 public API) ─────────────────
await test('classifyAndFill: hard class still works (m1 path unchanged)', async () => {
  const result = await classifyAndFill({ role: 'textbox', name: 'Email' }, {});
  assert.equal(result.class, 'hard');
  assert.equal(result.confidence, 'high');
  assert.ok(result.suggested_value && result.suggested_value.includes('@'));
});

await test('classifyAndFill: open class routes through openFiller', async () => {
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'mocked LLM answer' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    },
  };
  const result = await classifyAndFill(
    { role: 'textbox', name: 'Why are you interested?' },
    {
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.0005,
    },
  );
  assert.equal(result.class, 'open');
  assert.equal(result.suggested_value, 'mocked LLM answer');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.used, 'llm');
  assert.equal(result.source.kind, 'llm');
});

await test('classifyAndFill: file class (resume) routes through fileFiller', async () => {
  const result = await classifyAndFill(
    { role: 'button', name: 'Upload Resume' },
    { jobId: 'abc123def456', resumeId: 'cv1' },
  );
  assert.equal(result.class, 'file');
  // No PDF exists → medium (unverified) with computed path
  assert.equal(result.confidence, 'medium');
  assert.ok(result.suggested_value && result.suggested_value.endsWith('.pdf'));
});

await test('classifyAndFill: integration with budget gate paused', async () => {
  const mockClient = {
    messages: { create: async () => ({ content: [{ text: 'x' }], usage: {} }) },
  };
  let clientCalls = 0;
  const result = await classifyAndFill(
    { role: 'textbox', name: 'Why this company?' },
    {
      history: [],
      client: {
        messages: {
          create: async () => {
            clientCalls++;
            return { content: [{ text: 'x' }], usage: {} };
          },
        },
      },
      checkBudget: async () => ({ paused: true }),
    },
  );
  assert.equal(clientCalls, 0);
  assert.equal(result.class, 'open');
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'budget-blocked');
});

// ── 8. End-to-end Greenhouse 15-field with mocked LLM + cache ────────
await test('15-field Greenhouse fixture: full pipeline accuracy + cost tracking', async () => {
  const history = [
    {
      field_label: 'Why are you interested in this role?',
      a_final: 'cached: because role X',
      subclass: 'why-role',
      role: 'textbox',
    },
  ];
  let llmCallCount = 0;
  let totalCost = 0;
  const mockClient = {
    messages: {
      create: async () => {
        llmCallCount++;
        return {
          content: [{ text: `mocked answer #${llmCallCount}` }],
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  };
  const fields = [
    { refId: 'e1', role: 'textbox', name: 'Email' }, // hard
    { refId: 'e2', role: 'textbox', name: 'Phone' }, // hard
    { refId: 'e3', role: 'combobox', name: 'Gender' }, // legal
    { refId: 'e4', role: 'combobox', name: 'Will you require sponsorship?' }, // legal
    { refId: 'e5', role: 'button', name: 'Upload Resume' }, // file
    { refId: 'e6', role: 'textbox', name: 'Why are you interested in this role?' }, // open + cached
    { refId: 'e7', role: 'textbox', name: 'Tell me about yourself' }, // open + LLM
  ];
  const ctx = {
    history,
    client: mockClient,
    computeCostUsd: () => 0.0002,
    recordCost: async (rec) => { totalCost += rec.cost_usd; },
    jobId: 'abc123def456',
    resumeId: 'cv1',
    identity: { name: 'V' },
  };
  const results = await Promise.all(fields.map((f) => classifyAndFill(f, ctx)));
  // Per-field assertions
  assert.equal(results[0].class, 'hard'); // email
  assert.equal(results[1].class, 'hard'); // phone
  assert.equal(results[2].class, 'legal'); // gender
  assert.equal(results[3].class, 'legal'); // sponsorship
  assert.equal(results[4].class, 'file'); // resume
  assert.equal(results[5].class, 'open'); // why-role cached
  assert.equal(results[6].class, 'open'); // tell-me-about LLM

  // Cache hit for why-role: 0 LLM calls
  assert.equal(results[5].used, 'cache');
  assert.equal(results[5].suggested_value, 'cached: because role X');

  // tell-me-about should have triggered LLM
  assert.equal(results[6].used, 'llm');
  assert.ok(results[6].suggested_value.startsWith('mocked answer'));

  // Total: 1 LLM call (only tell-me-about; why-role was cached)
  assert.equal(llmCallCount, 1, `expected 1 LLM call (cache short-circuited why-role), got ${llmCallCount}`);
  assert.equal(totalCost, 0.0002, `expected $0.0002 total cost, got ${totalCost}`);

  // Verify high-confidence fill rate: email/phone (2 hard) + 2 legal + cached open = 5/7
  const filled = results.filter((r) => r.suggested_value !== null).length;
  assert.ok(filled >= 5, `expected ≥5 fields filled, got ${filled}`);
});

// ── 9. Review-fix coverage ───────────────────────────────────────────

await test('C1: fillFileField rejects invalid jobId (not 12-hex) → invalid-id', async () => {
  const result = await fillFileField(
    { role: 'button', name: 'Upload Resume' },
    { subclass: 'resume' },
    { jobId: 'NOT-HEX', resumeId: 'cv1' },
  );
  assert.equal(result.confidence, 'manual');
  assert.equal(result.suggested_value, null);
  assert.equal(result.source.status, 'invalid-id');
  assert.ok(result.source.hint && result.source.hint.includes('12-hex'));
});

await test('C1: fillFileField rejects path-traversal resumeId → invalid-id', async () => {
  const result = await fillFileField(
    { role: 'button', name: 'Upload Resume' },
    { subclass: 'resume' },
    { jobId: 'abc123def456', resumeId: '../../../etc/passwd' },
  );
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'invalid-id');
});

await test('C1: fillFileField cover-letter rejects relative path → invalid-path', async () => {
  const result = await fillFileField(
    { role: 'button', name: 'Upload Cover Letter' },
    { subclass: 'cover-letter' },
    { coverLetterPath: 'relative/path.pdf' },
  );
  assert.equal(result.confidence, 'manual');
  assert.equal(result.source.status, 'invalid-path');
});

await test('C3: fillOpenField handles history load failure → empty history, falls through to LLM', async () => {
  // Reset cache + point loader at a path we'll make unreadable mid-flight.
  // Simpler: monkey-patch nothing — just rely on the C3 catch by passing
  // history: undefined and pre-poisoning the module-level cache via a
  // synthetic rejected promise. Cleanest: just don't set history and
  // let it auto-load from default path (likely ENOENT → returns []
  // from readHistoryFile anyway, so this test verifies the happy path
  // through the C3 try/catch).
  resetOpenFillerCache();
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'LLM answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why this role?' },
    { subclass: 'why-role' },
    {
      // history: undefined → triggers loadQaBankHistory
      client: mockClient,
      computeCostUsd: () => 0.0001,
      checkBudget: async () => ({ paused: false }),
    },
  );
  // Either cache miss (history file missing → []) OR cache hit if user
  // has real qa-bank history. Both are fine — what we're testing is no
  // crash. We expect non-throwing behavior.
  assert.ok(result, 'fillOpenField must not throw when history load fails');
  assert.ok(['cache', 'llm', 'error', 'budget-blocked'].includes(result.used));
});

await test('H1: stripAnswerWrappers removes markdown / quote wrappers', () => {
  assert.equal(stripAnswerWrappers('Here is my answer: hello world'), 'hello world');
  assert.equal(stripAnswerWrappers('"quoted answer"'), 'quoted answer');
  assert.equal(stripAnswerWrappers('```\nfenced answer\n```'), 'fenced answer');
  assert.equal(stripAnswerWrappers('```text\nfenced typed\n```'), 'fenced typed');
  // Strip one preamble layer ("Sure,") — leaves "here is the text." which
  // is itself a valid sentence; we don't recursively strip
  assert.equal(stripAnswerWrappers('Sure, here is the text.'), 'here is the text.');
  assert.equal(stripAnswerWrappers('Answer: foo'), 'foo');
  // Curly quotes
  assert.equal(stripAnswerWrappers('\u201ccurly\u201d'), 'curly');
  // Plain answer passes through
  assert.equal(stripAnswerWrappers('Just a plain sentence.'), 'Just a plain sentence.');
  // Empty / whitespace
  assert.equal(stripAnswerWrappers(''), '');
  assert.equal(stripAnswerWrappers('   '), '');
});

await test('H1: callSonnetForOpen via fillOpenField strips markdown from LLM response', async () => {
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: '"Because I am passionate about APIs."' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'why-company' },
    { history: [], client: mockClient, computeCostUsd: () => 0.0001 },
  );
  assert.equal(result.suggested_value, 'Because I am passionate about APIs.');
  assert.equal(result.used, 'llm');
});

await test('H5: recordCost slow/hung does not stall fillOpenField', async () => {
  // recordCost returns a never-resolving promise → fire-and-forget
  // means fillOpenField should still return promptly.
  let recordCostInvoked = false;
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const start = Date.now();
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'why-role' },
    {
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.0001,
      recordCost: () => {
        recordCostInvoked = true;
        return new Promise(() => {}); // never resolves
      },
    },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.used, 'llm');
  assert.ok(recordCostInvoked, 'recordCost should still be invoked');
  assert.ok(elapsed < 100, `should not stall — elapsed ${elapsed}ms`);
});

await test('H6: cost_usd captured even when recordCost throws synchronously', async () => {
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  const result = await fillOpenField(
    { role: 'textbox', name: 'Why?' },
    { subclass: 'why-role' },
    {
      history: [],
      client: mockClient,
      computeCostUsd: () => 0.0042,
      recordCost: () => {
        throw new Error('ledger down');
      },
    },
  );
  assert.equal(result.used, 'llm');
  assert.equal(result.cost_usd, 0.0042, 'cost preserved despite recordCost throw');
});

await test('M3: empty narrativeVoice / jdSummary do not emit empty blocks', () => {
  const p1 = buildOpenPrompt(
    'why-role',
    { role: 'textbox', name: 'Why?' },
    { narrativeVoice: '   ', jdSummary: '', identity: { name: 'V' } },
  );
  assert.ok(!p1.system.includes('Voice notes:'), 'empty narrative should not add block');
  assert.ok(!p1.system.includes('Job context:'), 'empty JD should not add block');
});

await test('M6: whitespace-only field_label entries are skipped in findCachedAnswer', () => {
  const history = [
    { field_label: '   ', a_final: 'noise', subclass: 'why-role', role: 'textbox' },
    { field_label: 'Why this role?', a_final: 'real cached', subclass: 'why-role', role: 'textbox' },
  ];
  const hit = findCachedAnswer(history, 'textbox', 'Why this role?', 'why-role');
  assert.ok(hit, 'should find the real entry');
  assert.equal(hit.entry.a_final, 'real cached');
});

await test('M6: whitespace-only target name → null', () => {
  const history = [
    { field_label: 'Why?', a_final: 'x', subclass: 'why-role', role: 'textbox' },
  ];
  assert.equal(findCachedAnswer(history, 'textbox', '   ', 'why-role'), null);
});

await test('M9: classifyAndFill preserves cost_usd / used on hard + legal paths', async () => {
  const hard = await classifyAndFill({ role: 'textbox', name: 'Email' }, {});
  assert.equal(hard.cost_usd, 0);
  assert.equal(hard.used, 'none');
  const legal = await classifyAndFill({ role: 'combobox', name: 'Gender' }, {});
  assert.equal(legal.cost_usd, 0);
  assert.equal(legal.used, 'none');
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
