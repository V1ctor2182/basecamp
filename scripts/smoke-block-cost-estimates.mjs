#!/usr/bin/env node
// Smoke for 03-block-toggles m2: blockCostEstimates module.
// Pure-module asserts — no I/O, no API calls. Validates the math against
// the published Sonnet pricing.

import assert from 'node:assert/strict';
import { MODEL_PRICING } from '../src/career/lib/anthropicPricing.mjs';
import { STAGE_B_MODEL } from '../src/career/evaluator/stageBPrompt.mjs';
import {
  BLOCK_TOKEN_ESTIMATES,
  TOOL_COST_ADD,
  CACHED_SYSTEM_INPUT_TOKENS_EST,
  SONNET_OUTPUT_OVERHEAD_TOKENS,
  estimateStageBCost,
} from '../src/career/evaluator/blockCostEstimates.mjs';

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

function makePrefs(blocks = {}) {
  return { evaluator_strategy: { stage_b: { blocks } } };
}

// Pricing reference (claude-sonnet-4-6 from anthropicPricing):
// input 3 / output 15 / cacheRead 0.375 / cacheWrite 3.75 — per million tokens
const SONNET = MODEL_PRICING[STAGE_B_MODEL];

// Helper: compute expected cost for a token count + per-million rate
function tokensToCost(tokens, perMillionRate) {
  return Math.round(((tokens * perMillionRate) / 1_000_000) * 10000) / 10000;
}

// IEEE 754 boundary cases produce $0.0001 divergences between
// "round-once-at-end" and "subtract-two-round4'd-numbers". Both are valid
// rendering strategies for an illustrative estimate. Use a tolerance for
// derived-quantity asserts.
const PENNY_CENT = 0.0001;
function assertClose(actual, expected, msg = '') {
  if (Math.abs(actual - expected) > PENNY_CENT * 1.5) {
    assert.equal(actual, expected, msg); // throws with a useful diff
  }
}

// ── 1. Module shape + deep-freeze ──────────────────────────────────────
await test('Module exports the documented constants + helper (deep-frozen)', () => {
  assert.equal(typeof estimateStageBCost, 'function');
  assert.ok(Object.isFrozen(BLOCK_TOKEN_ESTIMATES));
  assert.ok(Object.isFrozen(TOOL_COST_ADD));
  // Nested objects must also be frozen so consumers can't silently mutate
  // estimates across the app (review fix H1).
  assert.ok(Object.isFrozen(BLOCK_TOKEN_ESTIMATES.A));
  assert.ok(Object.isFrozen(BLOCK_TOKEN_ESTIMATES.F));
  assert.equal(CACHED_SYSTEM_INPUT_TOKENS_EST, 14000);
  assert.equal(SONNET_OUTPUT_OVERHEAD_TOKENS, 100);
  // F is special — has output_per_story not output
  assert.ok(BLOCK_TOKEN_ESTIMATES.F.output_per_story > 0);
  // Other letters have a flat output count
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'G']) {
    assert.ok(BLOCK_TOKEN_ESTIMATES[letter].output > 0, `${letter} has output`);
  }
  assert.equal(TOOL_COST_ADD.web_search, 0.05);
  assert.equal(TOOL_COST_ADD.verify_job_posting, 0);
});

// ── 2. All-on baseline matches sum of all blocks + cached read + tools ──
await test('All-on baseline: sum of all blocks output + cached read + web_search', () => {
  // Enable all toggleable + sub-toggles on (defaults already true for sub-toggles)
  const prefs = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
  });
  const r = estimateStageBCost(prefs);

  // Expected: A(80) + B(600) + C(200) + D(250) + E(350) + F(8*90=720) + G(120)
  //         + overhead(100) = 2420 output tokens
  // + cached read (14000 * cacheRead) + web_search ($0.05) + playwright ($0)
  const expectedOutputTokens = 80 + 600 + 200 + 250 + 350 + 720 + 120 + 100;
  const expectedCachedRead = (14000 * SONNET.cacheRead) / 1_000_000;
  const expectedTotal =
    Math.round(
      (expectedCachedRead + (expectedOutputTokens * SONNET.output) / 1_000_000 + 0.05) * 10000
    ) / 10000;

  assertClose(r.total_per_call_all_on, expectedTotal, 'baseline math');
  assertClose(r.total_per_call_current, expectedTotal, 'all-on prefs == baseline');
  assert.equal(r.delta_savings_usd, 0, 'no savings when all on');
  assert.equal(r.delta_savings_pct, 0);
});

// ── 3. Disabling D (parent off) saves output tokens AND web_search extra ─
await test('D disabled: saves D output (250 tokens) + $0.05 web_search', () => {
  const prefs = makePrefs({
    block_b: true, block_c: true, block_d: false, block_e: true, block_f: true, block_g: true,
  });
  const r = estimateStageBCost(prefs);

  // Difference vs all-on: -250 output tokens (-$0.00375) + -$0.05 web_search
  const expectedDelta =
    Math.round(((250 * SONNET.output) / 1_000_000 + 0.05) * 10000) / 10000;
  assertClose(r.delta_savings_usd, expectedDelta);
  // per_block.D should be marked disabled with no tool_extras
  assert.equal(r.per_block.D.status, 'disabled');
  assert.equal(r.per_block.D.tool_extras_usd, 0);
  // per_block.D.cost_usd is still the per-block estimate (the helper
  // reports cost regardless of enabled status — UI strikes through it)
  assert.equal(r.per_block.D.cost_usd, tokensToCost(250, SONNET.output));
});

// ── 4. block_d_websearch off (D enabled but no web_search): saves $0.05 ─
await test('block_d_websearch=false with D enabled: saves $0.05 only (still emits D output)', () => {
  const prefs = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
    block_d_websearch: false,
  });
  const r = estimateStageBCost(prefs);

  // D still outputs (250 tokens), but no web_search → save exactly $0.05
  assertClose(r.delta_savings_usd, 0.05);
  assert.equal(r.per_block.D.status, 'enabled');
  assert.equal(r.per_block.D.tool_extras_usd, 0, 'no tool extras when websearch off');
});

// ── 5. F story_count change recomputes output tokens ────────────────────
await test('F story_count: 8 → 12 increases F output tokens by 4*90=360', () => {
  const prefsAt8 = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
  });
  const prefsAt12 = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
    block_f_story_count: 12,
  });
  const r8 = estimateStageBCost(prefsAt8);
  const r12 = estimateStageBCost(prefsAt12);

  // F at 8: 720 tokens / F at 12: 1080 tokens → diff = 360 output tokens
  const expectedDeltaCost =
    Math.round(((360 * SONNET.output) / 1_000_000) * 10000) / 10000;
  // Both are "all on" → both have current==all_on → savings 0 each
  assert.equal(r8.delta_savings_usd, 0);
  assert.equal(r12.delta_savings_usd, 0);
  // BUT total_per_call_all_on at 12 should be ~$0.0054 higher than at 8
  // (tolerance 1.5×PENNY_CENT covers IEEE 754 boundary cases on round4'd
  // subtraction).
  assertClose(
    r12.total_per_call_all_on - r8.total_per_call_all_on,
    expectedDeltaCost,
    `story_count 8→12 should add ~${expectedDeltaCost}, got ${r12.total_per_call_all_on - r8.total_per_call_all_on}`
  );
  // per_block.F.tokens should reflect story_count
  assert.equal(r8.per_block.F.tokens, 720);
  assert.equal(r12.per_block.F.tokens, 1080);
});

// ── 6. Forced-on / always-on status labels + cached_input shape ────────
await test('per_block status labels + cached_input write/read costs', () => {
  // All optional disabled, only A/B/E forced on
  const prefs = makePrefs({
    block_b: true, block_c: false, block_d: false, block_e: true, block_f: false, block_g: false,
  });
  const r = estimateStageBCost(prefs);

  assert.equal(r.per_block.A.status, 'always-on');
  assert.equal(r.per_block.B.status, 'forced-on');
  assert.equal(r.per_block.E.status, 'forced-on');
  assert.equal(r.per_block.C.status, 'disabled');
  assert.equal(r.per_block.D.status, 'disabled');
  assert.equal(r.per_block.F.status, 'disabled');
  assert.equal(r.per_block.G.status, 'disabled');

  assert.equal(r.cached_input.tokens, 14000);
  assertClose(r.cached_input.write_cost_first_call, tokensToCost(14000, SONNET.cacheWrite));
  assertClose(r.cached_input.read_cost_subsequent, tokensToCost(14000, SONNET.cacheRead));

  // Current = forced-on output (A 80 + B 600 + E 350) + overhead 100 = 1130
  // + cached read; no tool extras because D + G disabled
  const expectedCurrentTokens = 80 + 600 + 350 + 100;
  const expectedCurrent =
    Math.round(
      (((14000 * SONNET.cacheRead) / 1_000_000) +
        ((expectedCurrentTokens * SONNET.output) / 1_000_000)) *
        10000
    ) / 10000;
  assertClose(r.total_per_call_current, expectedCurrent);
  // Savings should be > 0 vs all-on
  assert.ok(r.delta_savings_usd > 0, 'positive savings vs all-on');
  assert.ok(r.delta_savings_pct > 0 && r.delta_savings_pct <= 100);
});

// ── 7. G disabled (parent off) zeroes G's tool_extras_usd ──────────────
await test('G disabled: tool_extras_usd is 0 (parent off skips child sub-toggle)', () => {
  const prefs = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: false,
  });
  const r = estimateStageBCost(prefs);
  assert.equal(r.per_block.G.status, 'disabled');
  assert.equal(r.per_block.G.tool_extras_usd, 0, 'no playwright extras when G off');
  // delta_savings should at least include G's output cost (120 tokens worth)
  assert.ok(r.delta_savings_usd > 0);
});

// ── 8. block_g_playwright off (G enabled, playwright disabled) ─────────
await test('block_g_playwright=false with G enabled: tool_extras_usd=0, savings=0', () => {
  const prefs = makePrefs({
    block_b: true, block_c: true, block_d: true, block_e: true, block_f: true, block_g: true,
    block_g_playwright: false,
  });
  const r = estimateStageBCost(prefs);
  assert.equal(r.per_block.G.status, 'enabled');
  assert.equal(r.per_block.G.tool_extras_usd, 0);
  // Playwright is $0 marginal so savings vs baseline is 0
  assert.equal(r.delta_savings_usd, 0, 'playwright is local + $0 marginal');
});

// ── 9. Empty / undefined prefs → defaults (forced-on only, sub-toggles default) ─
await test('estimateStageBCost handles empty + undefined prefs gracefully', () => {
  const rEmpty = estimateStageBCost({});
  const rUndef = estimateStageBCost(undefined);
  // No optional blocks → only A/B/E forced-on; C/D/F/G all disabled
  for (const r of [rEmpty, rUndef]) {
    assert.equal(r.per_block.A.status, 'always-on');
    assert.equal(r.per_block.B.status, 'forced-on');
    assert.equal(r.per_block.C.status, 'disabled');
    assert.equal(r.per_block.D.status, 'disabled');
    assert.equal(r.per_block.E.status, 'forced-on');
    assert.equal(r.per_block.F.status, 'disabled');
    assert.equal(r.per_block.G.status, 'disabled');
    // F tokens uses default story_count = 8 (90*8=720)
    assert.equal(r.per_block.F.tokens, 720);
    // pricing_available reflects MODEL_PRICING table
    assert.equal(r.pricing_available, true);
  }
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
