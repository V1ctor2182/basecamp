// Block cost estimates for Stage B Sonnet calls.
// Pure-constants module + estimateStageBCost helper. No I/O, no dependencies
// on llm-costs.jsonl history — refining estimates from real runs is a future
// followup. UI labels these as estimates.
//
// 03-block-toggles m2 — consumes:
//   - MODEL_PRICING from anthropicPricing.mjs (per-million-token rates)
//   - BLOCK_KEYS / FORCED_ON_BLOCKS / resolveEnabledBlocks /
//     resolveStageBToolPolicy / STAGE_B_MODEL from stageBPrompt.mjs
//
// Output cost dominates (3-4x input rate); cached system input contributes
// a small per-call read cost (one-time write cost on first batch call is
// reported separately so the UI can show it as "first-call surcharge").

import { MODEL_PRICING } from '../lib/anthropicPricing.mjs';
import {
  BLOCK_KEYS,
  FORCED_ON_BLOCKS,
  STAGE_B_DEFAULT_STORY_COUNT,
  STAGE_B_MODEL,
  resolveEnabledBlocks,
  resolveStageBToolPolicy,
} from './stageBPrompt.mjs';

// Object.freeze is shallow; deep-freeze locks nested objects so a consumer
// can't silently corrupt estimates across the app via e.g.
// BLOCK_TOKEN_ESTIMATES.A.output = 99999.
function deepFreeze(o) {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
}

// Per-block output-token estimates, derived from observed Stage B runs in
// 02-stage-b-sonnet. Block F scales with story_count (estimate per story).
// Block A is always rendered (no toggle); B and E are forced-on per spec
// constraint #1 (Tailor consumes E; B is total-score core).
export const BLOCK_TOKEN_ESTIMATES = deepFreeze({
  A: { output: 80  },                  // Role Summary — 1 paragraph
  B: { output: 600 },                  // CV Match — requirement table (largest)
  C: { output: 200 },                  // Level & Strategy — strategy memo
  D: { output: 250 },                  // Comp & Demand — compact figures
  E: { output: 350 },                  // Personalization — bullet edits
  F: { output_per_story: 90 },         // F scales with story_count
  G: { output: 120 },                  // Posting Legitimacy — short verdict
});

// Marginal tool costs per Stage B call. web_search is a hosted Anthropic
// tool billed per call (~$0.05). verify_job_posting is local Playwright,
// so $0 marginal — included for completeness so the UI can display the
// row consistently.
export const TOOL_COST_ADD = deepFreeze({
  web_search: 0.05,
  verify_job_posting: 0,
});

// Cached system input estimate. ~14k tokens covers cv.md + narrative.md +
// proof-points.md + identity.yml + qa-bank few-shot (per buildSystemBlock
// trim limits in stageBPrompt.mjs).
export const CACHED_SYSTEM_INPUT_TOKENS_EST = 14000;

// Sonnet emits a small overhead per response (block headers + total-score
// line + preamble). Counted into total output tokens.
export const SONNET_OUTPUT_OVERHEAD_TOKENS = 100;

// Compute per-letter output tokens for a given story_count.
function blockOutputTokens(letter, story_count) {
  if (letter === 'F') {
    return BLOCK_TOKEN_ESTIMATES.F.output_per_story * story_count;
  }
  return BLOCK_TOKEN_ESTIMATES[letter]?.output ?? 0;
}

// Resolve a per-block "status" label for UI presentation.
function blockStatus(letter, enabledSet) {
  if (letter === 'A') return 'always-on';
  if (FORCED_ON_BLOCKS.includes(letter)) return 'forced-on';
  return enabledSet.has(letter) ? 'enabled' : 'disabled';
}

// Round a USD figure to 4 decimal places (penny-cents) for stable display.
function round4(usd) {
  return Math.round(usd * 10000) / 10000;
}

// Main estimator. Returns a fully-resolved cost projection given a prefs
// object. Pure function — no side effects; safe to call in render.
//
// Returns:
//   {
//     model,
//     per_block: { A: {...}, B: {...}, ..., G: {...} },
//     cached_input: {
//       tokens, write_cost_first_call, read_cost_subsequent
//     },
//     total_per_call_current: USD steady-state per-call cost
//     total_per_call_all_on: baseline assuming all C/D/F/G enabled + tools
//     delta_savings_usd: all_on - current
//     delta_savings_pct: integer percentage saved (0-100)
//   }
//
// Per-call totals use the cached-read input rate (steady state).
// First-call write cost reported separately so the UI can surface it.
export function estimateStageBCost(prefs) {
  // pricing_available: surface a missing model key to the UI so it can
  // render an "estimate unavailable" badge instead of misleading $0.00 /
  // $0.00 figures. The fallback math still runs (returns zeros) so the
  // UI shape is stable.
  const rawPricing = MODEL_PRICING[STAGE_B_MODEL];
  const pricing_available = !!rawPricing;
  const pricing = rawPricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const enabled = new Set(resolveEnabledBlocks(prefs));
  const policy = resolveStageBToolPolicy(prefs);

  const per_block = {};
  let currentOutputTokens = SONNET_OUTPUT_OVERHEAD_TOKENS;
  let currentToolExtras = 0;

  for (const letter of BLOCK_KEYS) {
    const status = blockStatus(letter, enabled);
    const isOn = status === 'always-on' || status === 'forced-on' || status === 'enabled';
    // Per-block output tokens — uses live policy.story_count for F
    const tokens = blockOutputTokens(letter, policy.story_count);
    const cost_usd = round4((tokens * pricing.output) / 1_000_000);
    // Tool extras: D contributes web_search cost only when D enabled AND
    // websearch sub-toggle on; G contributes Playwright ($0). The
    // verify_job_posting row is reported regardless of cost so UI can show it.
    let tool_extras_usd = 0;
    if (letter === 'D' && isOn && policy.websearch_for_d) {
      tool_extras_usd = TOOL_COST_ADD.web_search;
    } else if (letter === 'G' && isOn && policy.playwright_for_g) {
      tool_extras_usd = TOOL_COST_ADD.verify_job_posting;
    }
    per_block[letter] = {
      tokens,
      cost_usd,
      status,
      tool_extras_usd,
    };
    if (isOn) {
      currentOutputTokens += tokens;
      currentToolExtras += tool_extras_usd;
    }
  }

  // All-on baseline: every block emitted + every tool on. The baseline is
  // a FIXED reference (independent of user's sub-toggle settings); otherwise
  // turning a tool off would shift the baseline and zero out the visible
  // savings number. F uses live story_count (story_count is a continuous
  // knob — the baseline reflects "all blocks on AT THIS story length").
  let allOnOutputTokens = SONNET_OUTPUT_OVERHEAD_TOKENS;
  let allOnToolExtras = 0;
  for (const letter of BLOCK_KEYS) {
    allOnOutputTokens += blockOutputTokens(letter, policy.story_count);
    if (letter === 'D') {
      allOnToolExtras += TOOL_COST_ADD.web_search;
    } else if (letter === 'G') {
      allOnToolExtras += TOOL_COST_ADD.verify_job_posting;
    }
  }

  const cachedTokens = CACHED_SYSTEM_INPUT_TOKENS_EST;
  const cached_input = {
    tokens: cachedTokens,
    write_cost_first_call: round4((cachedTokens * pricing.cacheWrite) / 1_000_000),
    read_cost_subsequent: round4((cachedTokens * pricing.cacheRead) / 1_000_000),
  };

  const cachedReadCostPerCall = (cachedTokens * pricing.cacheRead) / 1_000_000;
  const total_per_call_current = round4(
    cachedReadCostPerCall + (currentOutputTokens * pricing.output) / 1_000_000 + currentToolExtras
  );
  const total_per_call_all_on = round4(
    cachedReadCostPerCall + (allOnOutputTokens * pricing.output) / 1_000_000 + allOnToolExtras
  );
  const delta_savings_usd = round4(total_per_call_all_on - total_per_call_current);
  const delta_savings_pct =
    total_per_call_all_on > 0
      ? Math.round((delta_savings_usd / total_per_call_all_on) * 100)
      : 0;

  return {
    model: STAGE_B_MODEL,
    pricing_available,
    per_block,
    cached_input,
    total_per_call_current,
    total_per_call_all_on,
    delta_savings_usd,
    delta_savings_pct,
  };
}
