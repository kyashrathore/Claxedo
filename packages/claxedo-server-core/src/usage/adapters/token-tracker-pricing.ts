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

/**
 * Anthropic bills a one-hour cache write at twice the input rate for every
 * model; the catalog carries only the five-minute rate.
 */
const ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER = 2

export async function projectTokenTrackerCost(input: {
  source: string
  model: string
  tokens: {
    input: number | null
    output: number | null
    reasoning: number | null
    cacheRead: number | null
    cacheWrite: number | null
    /** The part of `cacheWrite` written to the one-hour cache; null where the source reports no split. */
    cacheWrite1h: number | null
  }
}): Promise<PricedUsage> {
  const pricing = await loadPricingModule()
  const catalog = await pricing.ensurePricingLoaded()
  const rates = pricing.getModelPricing(input.model, { source: input.source })
  const { tokens } = input
  const total = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]
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
  const cacheWrite = tokens.cacheWrite ?? 0
  const cacheWrite1h = Math.min(tokens.cacheWrite1h ?? 0, cacheWrite)
  const estimatedUsd = (
    (tokens.input ?? 0) * inputRate
    + (tokens.output ?? 0) * outputRate
    + (tokens.reasoning ?? 0) * reasoningRate
    + (tokens.cacheRead ?? 0) * cacheReadRate
    + (cacheWrite - cacheWrite1h) * cacheWriteRate
    + cacheWrite1h * inputRate * ONE_HOUR_CACHE_WRITE_INPUT_MULTIPLIER
  ) / 1_000_000
  return {
    estimatedUsd,
    pricedTokens: total,
    unpricedTokens: 0,
    catalog: { adapter: "tokentracker-cli", version: TOKEN_TRACKER_VERSION, source },
  }
}
