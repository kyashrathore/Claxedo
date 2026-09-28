import { totalTokens, type UsageTotals } from "./model"

export type TokenCategory = "cacheRead" | "cacheWrite" | "input" | "output" | "reasoning"

export type TokenShare = {
  readonly category: TokenCategory
  readonly tokens: number
  readonly share: number
}

export type TokenComposition = {
  readonly total: number
  readonly context: readonly TokenShare[]
  readonly generated: readonly TokenShare[]
}

const CONTEXT: readonly TokenCategory[] = ["cacheRead", "cacheWrite", "input"]
const GENERATED: readonly TokenCategory[] = ["output", "reasoning"]

export function tokenComposition(totals: UsageTotals): TokenComposition {
  const total = totalTokens(totals)
  const share = (category: TokenCategory): TokenShare => ({ category, tokens: totals[category], share: total > 0 ? totals[category] / total : 0 })
  return { total, context: CONTEXT.map(share), generated: GENERATED.map(share) }
}
