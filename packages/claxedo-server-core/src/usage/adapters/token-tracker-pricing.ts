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
  getPricingRevision(): number
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
  return typeof value.ensurePricingLoaded === "function"
    && typeof value.getPricingRevision === "function"
    && typeof value.getModelPricing === "function"
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

export type UsagePriceInput = {
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
}

/** Prices one model's tokens. The usage routes take one from their composition. */
export type UsagePricing = (input: UsagePriceInput) => Promise<PricedUsage>

/**
 * Where the rates come from.
 *
 * `bundled` is the curated overrides plus the LiteLLM seed compiled into
 * tokentracker-cli: no disk and no network, which is all a Worker can run.
 * `refreshed` is tokentracker's own loader: a 24-hour cache under the home
 * directory, refreshed from LiteLLM's published list, falling back to the seed.
 */
export type TokenTrackerCatalog = "bundled" | "refreshed"

const BUNDLED_CATALOG_SOURCE = "bundled-seed"

async function catalogSource(pricing: TokenTrackerPricingModule, catalog: TokenTrackerCatalog) {
  if (catalog === "refreshed") return (await pricing.ensurePricingLoaded()).source ?? BUNDLED_CATALOG_SOURCE
  // tokentracker holds one catalog per process, and ensurePricingLoaded()
  // replaces the import-time seed in place and bumps the revision. A bundled
  // price after that would be a refreshed rate carrying the bundled label.
  if (pricing.getPricingRevision() !== 0) {
    throw new Error("tokentracker-cli's bundled pricing catalog was replaced by a refresh in this process")
  }
  return BUNDLED_CATALOG_SOURCE
}

export function tokenTrackerPricing(catalog: TokenTrackerCatalog): UsagePricing {
  return async (input) => {
    const pricing = await loadPricingModule()
    return priceWith(pricing, await catalogSource(pricing, catalog), input)
  }
}

/**
 * The catalog id a reported model is billed under. A `[1m]` context marker
 * and a `-YYYYMMDD` snapshot date name the same model at the same rates; left
 * on, they reach tokentracker's containment match, which prices
 * `claude-fable-5-1[1m]` as Fable 5.
 */
function catalogModelId(model: string) {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")
}

function priceWith(pricing: TokenTrackerPricingModule, source: string, input: UsagePriceInput): PricedUsage {
  const rates = pricing.getModelPricing(catalogModelId(input.model), { source: input.source })
  const { tokens } = input
  const total = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]
    .map((value) => value ?? 0)
    .reduce((sum, value) => sum + value, 0)
  const known = [rates.input, rates.output, rates.cache_read, rates.cache_write]
    .some((rate) => typeof rate === "number" && rate > 0)
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
