#!/usr/bin/env node
// Smoke for Stage B m1: stageBPrompt module (prompt builder + parser).
// All assertions run with no real API calls.

import assert from 'node:assert/strict';
import {
  STAGE_B_MODEL,
  BLOCK_KEYS,
  BLOCK_CONFIG,
  buildSystemBlock,
  buildUserMessage,
  buildStageBPrompt,
  resolveEnabledBlocks,
  extractBlocks,
  parseStageBResponse,
  ParseError,
} from '../src/career/evaluator/stageBPrompt.mjs';

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

// ── Module shape ────────────────────────────────────────────────────────
await test('STAGE_B_MODEL = claude-sonnet-4-6', () => {
  assert.equal(STAGE_B_MODEL, 'claude-sonnet-4-6');
});

await test('BLOCK_KEYS = uppercase A-G, frozen', () => {
  assert.deepEqual(BLOCK_KEYS, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.ok(Object.isFrozen(BLOCK_KEYS));
});

await test('BLOCK_CONFIG covers all 7 letters', () => {
  for (const k of BLOCK_KEYS) {
    assert.ok(typeof BLOCK_CONFIG[k] === 'string' && BLOCK_CONFIG[k].length > 0);
  }
});

// ── buildSystemBlock: cache_control + content order + bundle pieces ─────
await test('buildSystemBlock: ONE block with cache_control:ephemeral', () => {
  const sys = buildSystemBlock({
    cv: 'CV',
    narrative: 'Narrative',
    proofPoints: 'PP',
    identity: 'Identity',
    qaFewShot: [],
    enabledBlocks: ['A', 'B', 'E'],
  });
  assert.equal(sys.length, 1);
  assert.equal(sys[0].type, 'text');
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
});

await test('buildSystemBlock: includes all 4 cv-bundle pieces', () => {
  const sys = buildSystemBlock({
    cv: 'CV_MARKER',
    narrative: 'NARRATIVE_MARKER',
    proofPoints: 'PROOF_MARKER',
    identity: 'IDENTITY_MARKER',
    qaFewShot: [],
    enabledBlocks: ['A', 'B', 'E'],
  });
  assert.match(sys[0].text, /CV_MARKER/);
  assert.match(sys[0].text, /NARRATIVE_MARKER/);
  assert.match(sys[0].text, /PROOF_MARKER/);
  assert.match(sys[0].text, /IDENTITY_MARKER/);
});

await test('buildSystemBlock: empty bundle → graceful placeholders, no throw', () => {
  const sys = buildSystemBlock({});
  assert.equal(sys.length, 1);
  assert.match(sys[0].text, /no CV available/);
  assert.match(sys[0].text, /no narrative available/);
  assert.match(sys[0].text, /no proof points available/);
  assert.match(sys[0].text, /no identity context/);
  assert.match(sys[0].text, /qa-bank.*empty/);
});

await test('buildSystemBlock: qaFewShot=[] → "qa-bank empty" placeholder', () => {
  const sys = buildSystemBlock({ cv: 'CV', qaFewShot: [] });
  assert.match(sys[0].text, /qa-bank.*empty/);
});

await test('buildSystemBlock: 5 qaFewShot entries rendered', () => {
  const fewShot = Array.from({ length: 5 }, (_, i) => ({
    question: `Q${i}`,
    answer: `A${i}`,
  }));
  const sys = buildSystemBlock({ cv: 'CV', qaFewShot: fewShot });
  for (let i = 0; i < 5; i++) {
    assert.match(sys[0].text, new RegExp(`Q${i}`));
    assert.match(sys[0].text, new RegExp(`A${i}`));
  }
});

await test('buildSystemBlock: only first 5 qaFewShot used (cap)', () => {
  const fewShot = Array.from({ length: 10 }, (_, i) => ({
    question: `MarkerQ_${i}`,
    answer: `MarkerA_${i}`,
  }));
  const sys = buildSystemBlock({ cv: 'CV', qaFewShot: fewShot });
  // First 5 should appear
  assert.match(sys[0].text, /MarkerQ_0/);
  assert.match(sys[0].text, /MarkerQ_4/);
  // 6th and beyond should NOT appear
  assert.doesNotMatch(sys[0].text, /MarkerQ_5/);
  assert.doesNotMatch(sys[0].text, /MarkerQ_9/);
});

await test('buildSystemBlock: toggle list shows enabled vs skip per letter', () => {
  const sys = buildSystemBlock({
    cv: 'CV',
    enabledBlocks: ['A', 'B', 'E'],
  });
  // A/B/E enabled
  assert.match(sys[0].text, /A \[enabled\]/);
  assert.match(sys[0].text, /B \[enabled\]/);
  assert.match(sys[0].text, /E \[enabled\]/);
  // C/D/F/G skip
  assert.match(sys[0].text, /C \[skip\]/);
  assert.match(sys[0].text, /D \[skip\]/);
  assert.match(sys[0].text, /F \[skip\]/);
  assert.match(sys[0].text, /G \[skip\]/);
});

// ── resolveEnabledBlocks: forced-on + user toggles ──────────────────────
await test('resolveEnabledBlocks: A/B/E forced even if user disables', () => {
  // User has set B and E to false somehow (UI should prevent this but
  // we defend anyway)
  const enabled = resolveEnabledBlocks({
    evaluator_strategy: {
      stage_b: {
        blocks: { block_b: false, block_c: false, block_d: false, block_e: false, block_f: false, block_g: false },
      },
    },
  });
  assert.deepEqual(enabled, ['A', 'B', 'E']);
});

await test('resolveEnabledBlocks: user toggles C and F → A/B/C/E/F', () => {
  const enabled = resolveEnabledBlocks({
    evaluator_strategy: {
      stage_b: {
        blocks: { block_b: true, block_c: true, block_d: false, block_e: true, block_f: true, block_g: false },
      },
    },
  });
  assert.deepEqual(enabled, ['A', 'B', 'C', 'E', 'F']);
});

await test('resolveEnabledBlocks: missing prefs → just forced-on (A/B/E)', () => {
  assert.deepEqual(resolveEnabledBlocks({}), ['A', 'B', 'E']);
  assert.deepEqual(resolveEnabledBlocks(null), ['A', 'B', 'E']);
  assert.deepEqual(resolveEnabledBlocks(undefined), ['A', 'B', 'E']);
});

// ── buildUserMessage: JD only, no CV ────────────────────────────────────
function makeJob(over = {}) {
  return {
    id: 'aaaabbbbcccc',
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
    evaluation: null,
    ...over,
  };
}

await test('buildUserMessage: includes role/company/location/comp/JD', () => {
  const msg = buildUserMessage(makeJob());
  assert.equal(msg.role, 'user');
  assert.match(msg.content, /Senior Software Engineer/);
  assert.match(msg.content, /Anthropic/);
  assert.match(msg.content, /SF, CA/);
  assert.match(msg.content, /200000–300000 USD\/yr/);
  assert.match(msg.content, /5\+ years required/);
});

await test('buildUserMessage: missing description → conservative placeholder', () => {
  const msg = buildUserMessage(makeJob({ description: null }));
  assert.match(msg.content, /JD body unavailable/);
});

await test('buildUserMessage: trims JD body to 12k chars', () => {
  const longJd = 'X'.repeat(20_000);
  const msg = buildUserMessage(makeJob({ description: longJd }));
  // Should be truncated; let total content stay reasonable
  assert.ok(msg.content.length < 13_000, `expected <13k, got ${msg.content.length}`);
  assert.match(msg.content, /…$/);
});

// ── buildStageBPrompt: full assembly ────────────────────────────────────
await test('buildStageBPrompt: model pinned + max_tokens 4096 + tools absent', () => {
  const params = buildStageBPrompt(makeJob(), {}, { cv: 'CV' });
  assert.equal(params.model, STAGE_B_MODEL);
  assert.equal(params.max_tokens, 4096);
  assert.equal(params.tools, undefined, 'm3 will add tools; m1 leaves absent');
  assert.equal(params.system.length, 1);
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, 'user');
});

// ── extractBlocks: section-split parser ─────────────────────────────────
await test('extractBlocks: full 7-block extraction', () => {
  const text = `## Block A — Role Summary
Summary text.

## Block B — CV Match
CV match content.

## Block C — Level & Strategy
Strategy text.

## Block D — Comp & Demand
Comp text.

## Block E — Personalization Plan
Personalization.

## Block F — Interview Plan
Interview plan.

## Block G — Posting Legitimacy
Legitimacy.

**Total: 4.2/5**`;
  const parsed = extractBlocks(text);
  assert.match(parsed.A, /Summary text/);
  assert.match(parsed.B, /CV match content/);
  assert.match(parsed.C, /Strategy text/);
  assert.match(parsed.D, /Comp text/);
  assert.match(parsed.E, /Personalization/);
  assert.match(parsed.F, /Interview plan/);
  assert.match(parsed.G, /Legitimacy/);
  assert.equal(parsed.total_score, 4.2);
});

await test('extractBlocks: missing blocks → empty string (no throw)', () => {
  const text = `## Block A — Role Summary
A only.

## Block E — Personalization Plan
E only.

**Total: 3.5/5**`;
  const parsed = extractBlocks(text);
  assert.match(parsed.A, /A only/);
  assert.equal(parsed.B, '');
  assert.equal(parsed.C, '');
  assert.equal(parsed.D, '');
  assert.match(parsed.E, /E only/);
  assert.equal(parsed.F, '');
  assert.equal(parsed.G, '');
  assert.equal(parsed.total_score, 3.5);
});

await test('extractBlocks: total score variants (with/without **/5)', () => {
  assert.equal(extractBlocks('**Total: 4.2/5**').total_score, 4.2);
  assert.equal(extractBlocks('**Total: 4.2**').total_score, 4.2);
  assert.equal(extractBlocks('Total: 4.2/5').total_score, 4.2);
  assert.equal(extractBlocks('Total: 4.2').total_score, 4.2);
  assert.equal(extractBlocks('Total = 4.2/5').total_score, 4.2);
});

await test('extractBlocks: total score clamps to [1, 5]', () => {
  assert.equal(extractBlocks('**Total: 0.5/5**').total_score, 1);
  assert.equal(extractBlocks('**Total: 6.0/5**').total_score, 5);
  assert.equal(extractBlocks('**Total: 4.55/5**').total_score, 4.6);
});

await test('extractBlocks: no headers found → preamble captures everything', () => {
  const parsed = extractBlocks('Just some prose with no block headers.');
  assert.equal(parsed.A, '');
  assert.equal(parsed.B, '');
  assert.equal(parsed.preamble, 'Just some prose with no block headers.');
  assert.equal(parsed.total_score, null);
});

await test('extractBlocks: preamble before Block A captured separately', () => {
  const text = `Some intro prose.

## Block A — Role Summary
A content.`;
  const parsed = extractBlocks(text);
  assert.match(parsed.preamble, /Some intro prose/);
  assert.match(parsed.A, /A content/);
});

await test('extractBlocks: total score line is stripped from final block content', () => {
  const text = `## Block G — Posting Legitimacy
Legitimacy content.

**Total: 4.2/5**`;
  const parsed = extractBlocks(text);
  // G content should NOT contain the total line
  assert.match(parsed.G, /Legitimacy content/);
  assert.doesNotMatch(parsed.G, /Total:/);
});

await test('extractBlocks: dash variants in headers (— en-dash, – em-dash, - hyphen)', () => {
  const variants = [
    '## Block A — Role Summary\ncontent A',
    '## Block A – Role Summary\ncontent A',
    '## Block A - Role Summary\ncontent A',
  ];
  for (const text of variants) {
    const parsed = extractBlocks(text);
    assert.match(parsed.A, /content A/);
  }
});

await test('extractBlocks: tolerant headers — colon variant + bold + H3', () => {
  // Sonnet sometimes uses colon, bold-wraps the header, or downgrades to H3.
  const variants = [
    '## Block A: Role Summary\ncontent A',           // colon
    '## **Block A — Role Summary**\ncontent A',     // bold inside ##
    '**## Block A — Role Summary**\ncontent A',     // bold wraps the whole line
    '### Block A — Role Summary\ncontent A',         // H3 fallback
    '##  Block A   —   Role Summary\ncontent A',     // wonky whitespace
  ];
  for (const text of variants) {
    const parsed = extractBlocks(text);
    assert.match(parsed.A, /content A/, `failed: ${JSON.stringify(text)}`);
  }
});

await test('extractBlocks: total score with decimal denominator (4.5/5.0)', () => {
  // Sonnet sometimes writes 4.5/5.0 — the .0 must NOT leak into the last block.
  const text = `## Block G — Posting Legitimacy
G content here.

**Total: 4.5/5.0**`;
  const parsed = extractBlocks(text);
  assert.equal(parsed.total_score, 4.5);
  assert.match(parsed.G, /G content here/);
  assert.doesNotMatch(parsed.G, /\.0/);
  assert.doesNotMatch(parsed.G, /Total/i);
});

await test('extractBlocks: anchored — inline "Total: 3" in prose is NOT stripped', () => {
  // If Block B prose says "...Total: 3 years required" it must NOT match as score.
  const text = `## Block B — CV Match
The candidate has Total: 3 years of relevant experience.

## Block G — Posting Legitimacy
G content.

**Total: 4.5/5**`;
  const parsed = extractBlocks(text);
  assert.equal(parsed.total_score, 4.5); // anchored line, not the prose
  assert.match(parsed.B, /Total: 3 years of relevant/);
  assert.match(parsed.G, /G content/);
});

// ── parseStageBResponse: content[] handling, tool_use intermix ──────────
await test('parseStageBResponse: text-only content[]', () => {
  const content = [{ type: 'text', text: '## Block A — x\nA content\n**Total: 4.0/5**' }];
  const parsed = parseStageBResponse(content);
  assert.match(parsed.A, /A content/);
  assert.equal(parsed.total_score, 4);
});

await test('parseStageBResponse: tool_use blocks ignored, text concatenated', () => {
  const content = [
    { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} },
    { type: 'text', text: '## Block A — Role\nA content\n' },
    { type: 'tool_use', id: 'toolu_2', name: 'verify_job_posting', input: { url: 'x' } },
    { type: 'text', text: '## Block G — Legit\nG content\n**Total: 4.5/5**' },
  ];
  const parsed = parseStageBResponse(content);
  assert.match(parsed.A, /A content/);
  assert.match(parsed.G, /G content/);
  assert.equal(parsed.total_score, 4.5);
});

await test('parseStageBResponse: empty content[] → ParseError', () => {
  assert.throws(() => parseStageBResponse([]), ParseError);
});

await test('parseStageBResponse: only tool_use blocks (no text) → ParseError', () => {
  const content = [{ type: 'tool_use', id: 't1', name: 'x', input: {} }];
  assert.throws(() => parseStageBResponse(content), ParseError);
});

await test('parseStageBResponse: non-array content → ParseError-friendly (empty text → throws)', () => {
  assert.throws(() => parseStageBResponse(null), ParseError);
  assert.throws(() => parseStageBResponse(undefined), ParseError);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
