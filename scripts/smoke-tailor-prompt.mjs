#!/usr/bin/env node
// Smoke for tailorPrompt — module shape, system block (cache_control +
// NO_FABRICATION + base + proof + emphasize render), user message
// (JD + Block E + optional hint), buildTailorPrompt shape, parser.

import assert from 'node:assert/strict';
import {
  TAILOR_MODEL,
  NO_FABRICATION_INSTRUCTION,
  buildSystemBlock,
  buildUserMessage,
  buildTailorPrompt,
  extractBlockEFromReport,
  parseTailorResponse,
  ParseError,
} from '../src/career/cv/tailorPrompt.mjs';

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

const SAMPLE_JOB = {
  id: '0123456789ab',
  role: 'Senior Backend Engineer',
  company: 'Anthropic',
  location: ['SF, CA'],
  url: 'https://example.com/jobs/1',
  description:
    'Build safe distributed AI systems. Required: 5+ years Python, distributed systems, leadership experience.',
};

const SAMPLE_BUNDLE = {
  baseMd: '# Test Candidate\n\n## Summary\nSenior engineer with 8 years.\n\n## Experience\n- Led team of 5\n- Built ETL pipeline',
  proofPoints: '- Reduced p99 latency 40% in payment service (verifiable)\n- Mentored 3 junior engineers',
  emphasize: {
    projects: ['payment-platform', 'data-mesh'],
    skills: ['Python', 'distributed systems', 'leadership'],
    narrative: 'Focus on platform reliability and scale',
  },
};

const SAMPLE_BLOCK_E = `Inject the following JD keywords into Summary: "distributed AI systems", "safety".
Reorder Experience to lead with leadership work. Avoid mentioning React (out of scope).`;

// ── Module shape ────────────────────────────────────────────────────────
await test('TAILOR_MODEL = claude-sonnet-4-6', () => {
  assert.equal(TAILOR_MODEL, 'claude-sonnet-4-6');
});

await test('NO_FABRICATION_INSTRUCTION matches constraint-tailor-engine-001 verbatim', () => {
  assert.equal(
    NO_FABRICATION_INSTRUCTION,
    'If a metric or claim is not in the source base.md or proof-points.md, DO NOT invent it. Only reorganize or rephrase existing content.'
  );
});

// ── buildSystemBlock ────────────────────────────────────────────────────
await test('buildSystemBlock: ONE text block with cache_control:ephemeral', () => {
  const blocks = buildSystemBlock(SAMPLE_BUNDLE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
});

await test('buildSystemBlock: NO_FABRICATION_INSTRUCTION verbatim in cached text', () => {
  const blocks = buildSystemBlock(SAMPLE_BUNDLE);
  assert.ok(
    blocks[0].text.includes(NO_FABRICATION_INSTRUCTION),
    'system block must contain the verbatim no-fabrication instruction'
  );
});

await test('buildSystemBlock: contains base.md + proof-points + emphasize sections', () => {
  const blocks = buildSystemBlock(SAMPLE_BUNDLE);
  const text = blocks[0].text;
  assert.match(text, /## Source Resume.*base\.md/);
  assert.match(text, /Senior engineer with 8 years/);
  assert.match(text, /## Source Proof Points.*proof-points\.md/);
  assert.match(text, /Reduced p99 latency 40%/);
  assert.match(text, /## Resume Emphasize Hints/);
  assert.match(text, /payment-platform/);
  assert.match(text, /distributed systems/);
  assert.match(text, /Focus on platform reliability/);
});

await test('buildSystemBlock: empty bundle → graceful placeholders, no throw', () => {
  const blocks = buildSystemBlock(undefined);
  assert.equal(blocks.length, 1);
  const text = blocks[0].text;
  assert.match(text, /NO base\.md PROVIDED — refuse this request/);
  assert.match(text, /no proof-points\.md available/);
  assert.match(text, /no emphasize hints/);
  // NO_FABRICATION still present
  assert.ok(text.includes(NO_FABRICATION_INSTRUCTION));
});

await test('buildSystemBlock: emphasize partial (only projects, no skills/narrative)', () => {
  const blocks = buildSystemBlock({
    ...SAMPLE_BUNDLE,
    emphasize: { projects: ['only-this-project'] },
  });
  const text = blocks[0].text;
  assert.match(text, /Emphasize projects: only-this-project/);
  assert.doesNotMatch(text, /Emphasize skills:/);
  assert.doesNotMatch(text, /Narrative emphasis:/);
});

await test('buildSystemBlock: emphasize present but all-empty → empty placeholder', () => {
  const blocks = buildSystemBlock({
    ...SAMPLE_BUNDLE,
    emphasize: { projects: [], skills: [], narrative: '' },
  });
  const text = blocks[0].text;
  assert.match(text, /emphasize present but empty/);
});

await test('buildSystemBlock: trims base.md to 8000 chars', () => {
  const huge = 'x'.repeat(20000);
  const blocks = buildSystemBlock({ baseMd: huge, proofPoints: '', emphasize: {} });
  const text = blocks[0].text;
  // baseMd is 8000 chars + 1-char ellipsis. Confirm by checking original is NOT fully present.
  assert.ok(!text.includes('x'.repeat(20000)));
  assert.ok(text.includes('x'.repeat(8000) + '…'));
});

// ── buildUserMessage ────────────────────────────────────────────────────
await test('buildUserMessage: includes role/company/JD/Block E', () => {
  const msg = buildUserMessage(SAMPLE_JOB, SAMPLE_BLOCK_E);
  assert.equal(msg.role, 'user');
  assert.match(msg.content, /Senior Backend Engineer/);
  assert.match(msg.content, /Anthropic/);
  assert.match(msg.content, /## Job Description/);
  assert.match(msg.content, /Build safe distributed AI/);
  assert.match(msg.content, /## Personalization Plan/);
  assert.match(msg.content, /Inject the following JD keywords/);
});

await test('buildUserMessage: userHint=undefined → no User Hint section', () => {
  const msg = buildUserMessage(SAMPLE_JOB, SAMPLE_BLOCK_E);
  assert.doesNotMatch(msg.content, /## User Hint/);
});

await test('buildUserMessage: userHint provided → User Hint section rendered', () => {
  const msg = buildUserMessage(SAMPLE_JOB, SAMPLE_BLOCK_E, 'Do not modify the Summary section.');
  assert.match(msg.content, /## User Hint/);
  assert.match(msg.content, /Do not modify the Summary section/);
});

await test('buildUserMessage: missing JD description → conservative placeholder', () => {
  const msg = buildUserMessage(
    { role: 'X', company: 'Y', description: null },
    SAMPLE_BLOCK_E
  );
  assert.match(msg.content, /no JD body available.*conservatively/);
});

await test('buildUserMessage: trims JD to 12000 chars', () => {
  const huge = 'j'.repeat(20000);
  const msg = buildUserMessage({ ...SAMPLE_JOB, description: huge }, SAMPLE_BLOCK_E);
  assert.ok(!msg.content.includes('j'.repeat(20000)));
  assert.ok(msg.content.includes('j'.repeat(12000) + '…'));
});

await test('buildUserMessage: trims Block E to 4000 chars', () => {
  const huge = 'b'.repeat(10000);
  const msg = buildUserMessage(SAMPLE_JOB, huge);
  assert.ok(!msg.content.includes('b'.repeat(10000)));
  assert.ok(msg.content.includes('b'.repeat(4000) + '…'));
});

// ── buildTailorPrompt ───────────────────────────────────────────────────
await test('buildTailorPrompt: model pinned + max_tokens 4096 + tools absent', () => {
  const params = buildTailorPrompt(SAMPLE_JOB, SAMPLE_BUNDLE, SAMPLE_BLOCK_E);
  assert.equal(params.model, 'claude-sonnet-4-6');
  assert.equal(params.max_tokens, 4096);
  assert.equal(params.tools, undefined, 'no tools — tailor is single-turn');
  assert.equal(params.system.length, 1);
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, 'user');
});

// ── extractBlockEFromReport ─────────────────────────────────────────────
await test('extractBlockEFromReport: pulls Block E from a Stage B report', () => {
  const report = `## Block A — Role Summary
Strong fit.

## Block E — Personalization Plan
Inject "leadership" into Summary. Reorder bullets.

## Block G — Posting Legitimacy
Live as of today.

**Total: 4.2/5**`;
  const blockE = extractBlockEFromReport(report);
  assert.match(blockE, /Inject "leadership" into Summary/);
  assert.match(blockE, /Reorder bullets/);
});

await test('extractBlockEFromReport: empty / missing E → empty string', () => {
  assert.equal(extractBlockEFromReport(''), '');
  assert.equal(extractBlockEFromReport(null), '');
  assert.equal(
    extractBlockEFromReport('## Block A — Summary\nNo E here\n**Total: 3.5/5**'),
    ''
  );
});

// ── parseTailorResponse ─────────────────────────────────────────────────
await test('parseTailorResponse: text-only content → markdown extracted', () => {
  const content = [{ type: 'text', text: '# Tailored\n\n## Summary\nSenior engineer...' }];
  const r = parseTailorResponse(content);
  assert.match(r.markdown, /# Tailored/);
  assert.match(r.markdown, /Senior engineer/);
});

await test('parseTailorResponse: tool_use intermixed → ignored, text concatenated', () => {
  const content = [
    { type: 'tool_use', id: 'x', name: 'web_search', input: {} },
    { type: 'text', text: '# Tailored A' },
    { type: 'text', text: '## Section' },
  ];
  const r = parseTailorResponse(content);
  assert.match(r.markdown, /Tailored A/);
  assert.match(r.markdown, /Section/);
});

await test('parseTailorResponse: empty content → ParseError', () => {
  assert.throws(() => parseTailorResponse([]), (e) => e instanceof ParseError);
  assert.throws(() => parseTailorResponse(null), (e) => e instanceof ParseError);
  assert.throws(
    () => parseTailorResponse([{ type: 'tool_use', id: 'x', name: 'w', input: {} }]),
    (e) => e instanceof ParseError
  );
});

// ── Review fix HIGH 1: whitespace-only userHint → no hint section ───────
await test('buildUserMessage: whitespace-only userHint → no User Hint section', () => {
  for (const ws of ['   ', '\n\n', '\t \t', '\n   \n']) {
    const msg = buildUserMessage(SAMPLE_JOB, SAMPLE_BLOCK_E, ws);
    assert.doesNotMatch(msg.content, /## User Hint/, `whitespace ${JSON.stringify(ws)} should not render section`);
  }
});

// ── Review fix HIGH 4: tailor parser uses \n\n for paragraph preservation ─
await test('parseTailorResponse: multi text-block content joined with \\n\\n', () => {
  const content = [
    { type: 'text', text: '# Tailored Resume\n\n## Summary\nFirst paragraph.' },
    { type: 'text', text: '## Experience\nSecond paragraph.' },
  ];
  const { markdown } = parseTailorResponse(content);
  // The two text blocks must have a blank line between them, not be glued
  // into one line. Stage B's concatTextBlocks would join with single \n.
  assert.match(markdown, /First paragraph\.\n\n## Experience/);
});

// ── Review fix MED 6: emphasize separator is " | " not ", " ──────────────
await test('renderEmphasize: comma-containing project names safe via " | " separator', () => {
  const blocks = buildSystemBlock({
    baseMd: '...',
    proofPoints: '',
    emphasize: { projects: ['payments, billing', 'infra-platform'], skills: ['Python, Go'] },
  });
  const text = blocks[0].text;
  // Joined with " | " — comma in name does not split
  assert.match(text, /Emphasize projects: payments, billing \| infra-platform/);
  assert.match(text, /Emphasize skills: Python, Go/);
});

// ── Review fix LOW 9: NO_FABRICATION sits at top of TAILOR_INSTRUCTIONS ──
await test('buildSystemBlock: CONSTRAINT #1 leads (appears before YOUR JOB)', () => {
  const blocks = buildSystemBlock(SAMPLE_BUNDLE);
  const text = blocks[0].text;
  const constraintIdx = text.indexOf('CONSTRAINT #1 (HARD');
  const yourJobIdx = text.indexOf('YOUR JOB');
  assert.ok(constraintIdx > -1, 'constraint header found');
  assert.ok(yourJobIdx > -1, 'YOUR JOB header found');
  assert.ok(constraintIdx < yourJobIdx, 'constraint must come before YOUR JOB');
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
