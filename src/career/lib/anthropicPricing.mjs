// Single source of truth for Claude API per-million-token pricing (USD).
// Both server.mjs (daily cost rollup) and the evaluator runners
// (stage-a, future stage-b) import from here.
//
// Update this table when Anthropic changes pricing. Cost reports across
// the whole career system depend on these values being current.

export const MODEL_PRICING = Object.freeze({
  'claude-opus-4-6':            { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
  'claude-opus-4-5-20251101':   { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
  'claude-haiku-4-5-20251001':  { input: 0.80, output: 4,   cacheRead: 0.08,  cacheWrite: 1.0   },
});

// Compute USD cost from a Claude API response's `usage` block.
//
// Anthropic API contract: `usage.input_tokens` does NOT overlap with
// `cache_creation_input_tokens` or `cache_read_input_tokens`. The three
// fields are disjoint and sum to the total billed input. cache_*_*_tokens
// can be `null` (when caching isn't used) — coerce to 0.
//
// Returns 0 if the model isn't in the pricing table (caller can decide
// whether to log a warning). Returns a non-negative number always.
export function computeCostUsd(model, usage) {
  const p = MODEL_PRICING[model];
  if (!p || !usage || typeof usage !== 'object') return 0;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.cacheRead +
      cacheCreation * p.cacheWrite) /
    1_000_000
  );
}
