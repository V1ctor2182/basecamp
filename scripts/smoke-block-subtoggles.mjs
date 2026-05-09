#!/usr/bin/env node
// Smoke for 03-block-toggles m1: fine-grained sub-toggles in stageBPrompt.mjs.
// Pure-module asserts — no server spawn (existing smoke-budget-gate covers
// the full PreferencesSchema PUT round-trip; adding zod fields with .default()
// is non-breaking for that flow).

import assert from 'node:assert/strict';
import {
  buildSystemBlock,
  resolveEnabledBlocks,
  resolveStageBToolPolicy,
  STAGE_B_DEFAULT_STORY_COUNT,
  STAGE_B_STORY_COUNT_MIN,
  STAGE_B_STORY_COUNT_MAX,
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

function makePrefs(blocks = {}) {
  return {
    evaluator_strategy: {
      stage_b: { blocks },
    },
  };
}

// Build a system block and return the joined text for substring asserts.
function systemText(prefs, enabledBlocks) {
  const sys = buildSystemBlock({
    cv: 'CV',
    narrative: 'N',
    proofPoints: 'P',
    identity: 'I',
    qaFewShot: [],
    enabledBlocks,
    prefs,
  });
  return sys[0].text;
}

// ── 1. Module exports ──────────────────────────────────────────────────
await test('Module exports the new public API', () => {
  assert.equal(typeof resolveStageBToolPolicy, 'function');
  assert.equal(STAGE_B_DEFAULT_STORY_COUNT, 8);
  assert.equal(STAGE_B_STORY_COUNT_MIN, 3);
  assert.equal(STAGE_B_STORY_COUNT_MAX, 20);
});

// ── 2. Defaults on empty/missing prefs ─────────────────────────────────
await test('resolveStageBToolPolicy: defaults when blocks object is empty', () => {
  const p = resolveStageBToolPolicy(makePrefs({}));
  assert.equal(p.websearch_for_d, true);
  assert.equal(p.playwright_for_g, true);
  assert.equal(p.story_count, 8);
});

await test('resolveStageBToolPolicy: defaults on undefined prefs', () => {
  const p = resolveStageBToolPolicy(undefined);
  assert.equal(p.websearch_for_d, true);
  assert.equal(p.playwright_for_g, true);
  assert.equal(p.story_count, 8);
});

// ── 3. Explicit overrides read through ─────────────────────────────────
await test('resolveStageBToolPolicy: explicit false reads through', () => {
  const p = resolveStageBToolPolicy(
    makePrefs({ block_d_websearch: false, block_g_playwright: false, block_f_story_count: 12 })
  );
  assert.equal(p.websearch_for_d, false);
  assert.equal(p.playwright_for_g, false);
  assert.equal(p.story_count, 12);
});

// ── 4. Clamping out-of-range story_count ───────────────────────────────
await test('resolveStageBToolPolicy: clamps story_count to [3,20]', () => {
  // Below min clamps to 3 (integer)
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: 1 })).story_count, 3);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: 0 })).story_count, 3);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: -5 })).story_count, 3);
  // Above max clamps to 20
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: 100 })).story_count, 20);
  // Non-integer / non-finite / non-number → default 8
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: 'eight' })).story_count, 8);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: 7.5 })).story_count, 8);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: NaN })).story_count, 8);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: Infinity })).story_count, 8);
  assert.equal(resolveStageBToolPolicy(makePrefs({ block_f_story_count: null })).story_count, 8);
});

// ── 5. No overrides emitted when all defaults + cache-key invariance ──
await test('buildSystemBlock: no SUB-TOGGLE OVERRIDES section when all defaults', () => {
  const text = systemText(makePrefs({}), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.ok(!text.includes('SUB-TOGGLE OVERRIDES'), 'should NOT mention overrides when no toggles diverge from defaults');
  // H1 fix: empty-overrides path must not introduce extra blank lines
  // (would break Anthropic prompt-cache hits on the always-default path).
  assert.ok(!text.includes('\n\n\n'), 'no triple-newline (extra blank) when overrides are empty');
  // Specifically the toggle list should be followed by exactly ONE blank line
  // before the SCORING WEIGHTS section header
  assert.ok(/G \[(?:enabled|skip)\] — [^\n]+\n\nSCORING WEIGHTS/.test(text),
    'toggle list → blank → SCORING WEIGHTS, byte-identical to pre-m1 layout');
});

// ── 5b. All-parents-disabled-but-sub-toggles-off → no override section ─
await test('buildSystemBlock: dual parents off + sub-toggles off → no override section', () => {
  const text = systemText(
    makePrefs({ block_d: false, block_g: false, block_d_websearch: false, block_g_playwright: false }),
    ['A', 'B', 'E']
  );
  assert.ok(!text.includes('SUB-TOGGLE OVERRIDES'), 'no override section when both parents disabled');
  assert.ok(!text.includes('Block D OVERRIDE'));
  assert.ok(!text.includes('Block G OVERRIDE'));
});

// ── 6. D override emitted only when D enabled + websearch off ──────────
await test('buildSystemBlock: D OVERRIDE present when D enabled AND websearch=false', () => {
  const text = systemText(
    makePrefs({ block_d_websearch: false }),
    ['A', 'B', 'D', 'E']
  );
  assert.ok(text.includes('SUB-TOGGLE OVERRIDES'));
  assert.ok(text.includes('Block D OVERRIDE'));
  assert.ok(text.includes('JD inference'));
});

await test('buildSystemBlock: D OVERRIDE absent when D is disabled (parent skips child)', () => {
  // D is NOT in enabled set — websearch flag is moot
  const text = systemText(
    makePrefs({ block_d_websearch: false }),
    ['A', 'B', 'E']
  );
  assert.ok(!text.includes('Block D OVERRIDE'), 'override skipped when D not in enabled blocks');
});

// ── 7. F story_count override ──────────────────────────────────────────
await test('buildSystemBlock: F OVERRIDE present when story_count differs from 8', () => {
  const text = systemText(
    makePrefs({ block_f_story_count: 5 }),
    ['A', 'B', 'E', 'F']
  );
  assert.ok(text.includes('Block F OVERRIDE'));
  assert.ok(text.includes('exactly 5 STAR + Reflection'));
});

await test('buildSystemBlock: F OVERRIDE absent when story_count == default 8', () => {
  const text = systemText(
    makePrefs({ block_f_story_count: 8 }),
    ['A', 'B', 'E', 'F']
  );
  assert.ok(!text.includes('Block F OVERRIDE'));
});

// ── 8. G playwright override ───────────────────────────────────────────
await test('buildSystemBlock: G OVERRIDE present when G enabled AND playwright=false', () => {
  const text = systemText(
    makePrefs({ block_g_playwright: false }),
    ['A', 'B', 'E', 'G']
  );
  assert.ok(text.includes('Block G OVERRIDE'));
  assert.ok(text.includes('posted_at'));
});

// ── 9. resolveEnabledBlocks unchanged by sub-toggles ───────────────────
await test('resolveEnabledBlocks: sub-toggles do NOT affect parent block enablement', () => {
  // Parent block_d=false → D is skipped regardless of websearch sub-toggle
  const enabled = resolveEnabledBlocks(makePrefs({
    block_d: false,
    block_d_websearch: true,  // sub-flag set but parent off
  }));
  assert.ok(!enabled.includes('D'), 'parent off wins');
  // Forced-on A/B/E always present
  assert.ok(enabled.includes('A'));
  assert.ok(enabled.includes('B'));
  assert.ok(enabled.includes('E'));
});

// ── 10. All three overrides combine cleanly ────────────────────────────
await test('buildSystemBlock: D + F + G overrides all present together', () => {
  const text = systemText(
    makePrefs({
      block_d_websearch: false,
      block_f_story_count: 4,
      block_g_playwright: false,
    }),
    ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  );
  assert.ok(text.includes('Block D OVERRIDE'));
  assert.ok(text.includes('Block F OVERRIDE'));
  assert.ok(text.includes('exactly 4 STAR'));
  assert.ok(text.includes('Block G OVERRIDE'));
  // Single header, not three
  const headerCount = (text.match(/SUB-TOGGLE OVERRIDES/g) ?? []).length;
  assert.equal(headerCount, 1);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
