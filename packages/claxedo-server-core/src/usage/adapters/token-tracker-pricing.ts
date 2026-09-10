/// <reference path="../../types/tokentracker-cli.d.ts" />
import { isJsonRecord } from "../../platform/runtime/lib/json"

/** The exact-pinned tokentracker-cli version this adapter prices against. */
export const TOKEN_TRACKER_VERSION = "0.91.0"

export type PricedUsage = {
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  catalog: { adapter: "tokentracker-cli"; version: typeof TOKEN_TRACKER_VERSION; source: string }
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

/** tokentracker-cli ships no types, so its pricing entry point is checked once, here. */
function isPricingModule(value: unknown): value is TokenTrackerPricingModule {
  if (!isJsonRecord(value)) return false
  return typeof value.ensurePricingLoaded === "function" && typeof value.getModelPricing === "function"
}

async function loadPricingModule(): Promise<TokenTrackerPricingModule> {
  // The specifier must stay a literal. Bun inlines a dynamic import only when
  // it can read the specifier statically; hoisting it into a constant leaves
  // tokentracker-cli out of the bundled server entirely, where the import then
  // resolves nowhere and every priced Usage view answers 500.
  const loaded: unknown = await import("tokentracker-cli/src/lib/pricing/index.js")
  if (!isPricingModule(loaded)) {
    throw new Error("tokentracker-cli/src/lib/pricing/index.js does not export the tokentracker-cli pricing API")
  }
  return loaded
}

export async function projectTokenTrackerCost(input: {
  source: string
  model: string
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null }
}): Promise<PricedUsage> {
  const pricing = await loadPricingModule()
  const catalog = await pricing.ensurePricingLoaded()
  const rates = pricing.getModelPricing(input.model, { source: input.source })
  // Resolve the unknown categories to zero before summing: reducing over
  // `(number | null)[]` selects the same-type overload and infers `number | null`.
  const total = Object.values(input.tokens)
    .map((value) => value ?? 0)
    .reduce((sum, value) => sum + value, 0)
  const known = [rates.input, rates.output, rates.cache_read, rates.cache_write]
    .some((rate) => typeof rate === "number" && rate > 0)
  const source = catalog.source ?? "bundled-seed"
  if (!known) {
    return {
      estimatedUsd: 0,
      pricedTokens: 0,
      unpricedTokens: total,
      catalog: { adapter: "tokentracker-cli", version: TOKEN_TRACKER_VERSION, source },
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
    catalog: { adapter: "tokentracker-cli", version: TOKEN_TRACKER_VERSION, source },
  }
}
