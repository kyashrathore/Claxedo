export type PricedUsage = {
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  catalog: { adapter: "tokentracker-cli"; version: "0.75.1"; source: string }
}

type TokenTrackerPricingModule = {
  ensurePricingLoaded(): Promise<{ source?: string | null }>
  getModelPricing(model: string, options?: { source?: string }): {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

const tokenTrackerPricingModule = "tokentracker-cli/src/lib/pricing/index.js"

export async function projectTokenTrackerCost(input: {
  source: string
  model: string
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null }
}): Promise<PricedUsage> {
  const pricing = await import(tokenTrackerPricingModule) as TokenTrackerPricingModule
  const catalog = await pricing.ensurePricingLoaded()
  const rates = pricing.getModelPricing(input.model, { source: input.source })
  const total = Object.values(input.tokens).reduce<number>((sum, value) => sum + (value ?? 0), 0)
  const known = [rates.input, rates.output, rates.cache_read, rates.cache_write]
    .some((rate) => typeof rate === "number" && rate > 0)
  const source = catalog.source ?? "bundled-seed"
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
  // Canonical usage categories are disjoint: Codex scanner/live adapters
  // subtract reasoning from output before this boundary.
  const reasoningRate = outputRate
  const estimatedUsd = (
    (input.tokens.input ?? 0) * inputRate
    + (input.tokens.output ?? 0) * outputRate
    + (input.tokens.reasoning ?? 0) * reasoningRate
    + (input.tokens.cacheRead ?? 0) * cacheReadRate
    + (input.tokens.cacheWrite ?? 0) * cacheWriteRate
  ) / 1_000_000
  return {
    estimatedUsd,
    pricedTokens: total,
    unpricedTokens: 0,
    catalog: { adapter: "tokentracker-cli", version: "0.75.1", source },
  }
}
