import { totalTokens, type UsageTotals } from "./model"

export type PricedUsage = {
  readonly estimatedUsd: number
  readonly pricedTokens: number
  readonly unpricedTokens: number
}

export type CostEstimate =
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | { readonly kind: "partial"; readonly usd: number }
  | { readonly kind: "complete"; readonly usd: number }

export function costEstimate(cost: PricedUsage, totals: UsageTotals): CostEstimate {
  if (cost.pricedTokens === 0) {
    const measuredNothing = totalTokens(totals) === 0 && cost.unpricedTokens === 0 && !totals.unavailableTurnCount
    return measuredNothing ? { kind: "none" } : { kind: "unknown" }
  }
  if (cost.unpricedTokens > 0) return { kind: "partial", usd: cost.estimatedUsd }
  return { kind: "complete", usd: cost.estimatedUsd }
}
