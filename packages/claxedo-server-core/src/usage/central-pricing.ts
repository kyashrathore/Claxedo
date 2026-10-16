import type { CentralUsageRow } from "./projection"
import { rowNumber, rowText } from "./projection"
import { TOKEN_TRACKER_VERSION, type PricedUsage, type UsagePricing } from "./adapters/token-tracker-pricing"

export const emptyCost = (): CostWithDaily => ({
  estimatedUsd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  catalog: { adapter: "tokentracker-cli", version: TOKEN_TRACKER_VERSION, source: "bundled-seed" },
  daily: [],
})

export type CostWithDaily = PricedUsage & {
  daily: Array<{ date: string; estimatedUsd: number; pricedTokens: number; unpricedTokens: number }>
}

/** The estimated cost of rows that each name a `provider/model` and its token counts. */
export async function priceCentralBreakdown(pricing: UsagePricing, rows: readonly CentralUsageRow[]) {
  const total = emptyCost()
  for (const row of rows) {
    const [source, ...modelParts] = rowText(row, "value").split("/")
    const model = modelParts.join("/")
    if (!source || !model) continue
    const item = await pricing({
      source,
      model,
      tokens: {
        input: rowNumber(row, "input_tokens"),
        output: rowNumber(row, "output_tokens"),
        reasoning: rowNumber(row, "reasoning_tokens"),
        cacheRead: rowNumber(row, "cache_read_tokens"),
        cacheWrite: rowNumber(row, "cache_write_tokens"),
        cacheWrite1h: rowNumber(row, "cache_write_1h_tokens"),
      },
    })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}
