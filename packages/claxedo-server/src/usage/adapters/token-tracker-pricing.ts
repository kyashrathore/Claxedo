export type PricedUsage = {
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  catalog: { adapter: "tokentracker-cli"; version: "0.75.1"; source: string }
}

export async function projectTokenTrackerCost(input: {
  source: string
  model: string
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}): Promise<PricedUsage> {
  const pricing = await import("tokentracker-cli/src/lib/pricing/index.js")
  const rates = pricing.getModelPricing(input.model, { source: input.source })
  const total = Object.values(input.tokens).reduce((sum, value) => sum + value, 0)
  const known = [rates.input, rates.output, rates.cache_read, rates.cache_write]
    .some((rate) => typeof rate === "number" && rate > 0)
  const source = pricing.__getStateForTests()?.source ?? "bundled-seed"
  if (!known) {
    return {
      estimatedUsd: 0,
      pricedTokens: 0,
      unpricedTokens: total,
      catalog: { adapter: "tokentracker-cli", version: "0.75.1", source },
    }
  }
  const inputRate = rates.input ?? 0
  const outputRate = rates.output ?? 0
  const cacheReadRate = rates.cache_read ?? inputRate
  const cacheWriteRate = rates.cache_write ?? inputRate
  const reasoningRate = input.source === "codex" ? 0 : outputRate
  const estimatedUsd = (
    input.tokens.input * inputRate
    + input.tokens.output * outputRate
    + input.tokens.reasoning * reasoningRate
    + input.tokens.cacheRead * cacheReadRate
    + input.tokens.cacheWrite * cacheWriteRate
  ) / 1_000_000
  return {
    estimatedUsd,
    pricedTokens: total,
    unpricedTokens: 0,
    catalog: { adapter: "tokentracker-cli", version: "0.75.1", source },
  }
}
