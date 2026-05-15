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

export declare const BLOCK_TOKEN_ESTIMATES: Readonly<{
  A: { output: number }
  B: { output: number }
  C: { output: number }
  D: { output: number }
  E: { output: number }
  F: { output_per_story: number }
  G: { output: number }
}>
export declare const TOOL_COST_ADD: Readonly<{ web_search: number; verify_job_posting: number }>
export declare const CACHED_SYSTEM_INPUT_TOKENS_EST: number
export declare const SONNET_OUTPUT_OVERHEAD_TOKENS: number

export declare function estimateStageBCost(prefs: unknown): StageBCostEstimate
