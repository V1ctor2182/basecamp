// Type declarations for blockCostEstimates.mjs (consumed from .tsx files
// via Vite's bundler module resolution). Mirrors the runtime exports.

export type BlockStatus = 'always-on' | 'forced-on' | 'enabled' | 'disabled'

export type PerBlockCost = {
  tokens: number
  cost_usd: number
  status: BlockStatus
  tool_extras_usd: number
}

export type StageBCostEstimate = {
  model: string
  pricing_available: boolean
  per_block: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', PerBlockCost>
  cached_input: {
    tokens: number
    write_cost_first_call: number
    read_cost_subsequent: number
  }
  total_per_call_current: number
  total_per_call_all_on: number
  delta_savings_usd: number
  delta_savings_pct: number
}

// Discriminated per-letter shape so consumers don't have to deal with
// "output_per_story" being optional on A-E,G or vice versa.
export const BLOCK_TOKEN_ESTIMATES: Readonly<{
  A: { output: number }
  B: { output: number }
  C: { output: number }
  D: { output: number }
  E: { output: number }
  F: { output_per_story: number }
  G: { output: number }
}>
export const TOOL_COST_ADD: Readonly<{ web_search: number; verify_job_posting: number }>
export const CACHED_SYSTEM_INPUT_TOKENS_EST: number
export const SONNET_OUTPUT_OVERHEAD_TOKENS: number

export function estimateStageBCost(prefs: unknown): StageBCostEstimate
