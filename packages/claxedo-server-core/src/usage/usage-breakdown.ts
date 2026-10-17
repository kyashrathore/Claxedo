import type { UsageBreakdownRow, UsageFilterDimension } from "@claxedo/usage-contract"
import type { PricedUsage, UsagePricing } from "./adapters/token-tracker-pricing"
import { priceCentralBreakdown } from "./central-pricing"
import type { TurnUsageRevision } from "./contracts"
import { latestUsageFacts, rowNumber, rowText, usageDateFormatter, usageModelKey, type CentralUsageRow, type UsageSeries } from "./projection"
import { publicUsageHref } from "./public-href"

type CanonicalBreakdownTotals = {
  value: string
  turnCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknownCategories: number
  partialTurnCount: number
  unavailableTurnCount: number
  errorTurnCount: number
}

type UsageChartRow = {
  date: string
  value: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

function chartRow(raw: CentralUsageRow): UsageChartRow | undefined {
  const date = rowText(raw, "date")
  const value = rowText(raw, "value")
  if (!date || !value) return undefined
  return {
    date,
    value,
    input: rowNumber(raw, "input", "input_tokens"),
    output: rowNumber(raw, "output", "output_tokens"),
    reasoning: rowNumber(raw, "reasoning", "reasoning_tokens"),
    cacheRead: rowNumber(raw, "cacheRead", "cache_read_tokens"),
    cacheWrite: rowNumber(raw, "cacheWrite", "cache_write_tokens"),
  }
}

export function mergeChartSeries(dimension: string, ...sources: Array<readonly CentralUsageRow[] | undefined>) {
  const rows = new Map<string, UsageChartRow>()
  for (const source of sources) {
    for (const raw of source ?? []) {
      const next = chartRow(raw)
      if (!next) continue
      const key = `${next.value}\u0000${next.date}`
      const current = rows.get(key) ?? { ...next, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const)
        current[field] += next[field]
      rows.set(key, current)
    }
  }
  const grouped = Map.groupBy([...rows.values()], (row) => row.value)
  return {
    dimension,
    series: [...grouped]
      .map(([value, daily]) => ({
        value,
        label: breakdownLabel(value, dimension),
        daily: daily
          .toSorted((a, b) => a.date.localeCompare(b.date))
          .map(({ date, input, output, reasoning, cacheRead, cacheWrite }) => ({
            date,
            input,
            output,
            reasoning,
            cacheRead,
            cacheWrite,
          })),
      }))
      .toSorted((a, b) => a.value.localeCompare(b.value)),
  }
}

export function chartRowsFromFacts(
  facts: readonly TurnUsageRevision[],
  groupOf: (fact: TurnUsageRevision) => string,
  timeZone: string,
) {
  const formatDate = usageDateFormatter(timeZone)
  return latestUsageFacts(facts).map((fact) => ({
    date: formatDate.format(new Date(fact.observedAt)),
    value: groupOf(fact),
    input: fact.tokens.input ?? 0,
    output: fact.tokens.output ?? 0,
    reasoning: fact.tokens.reasoning ?? 0,
    cacheRead: fact.tokens.cache.read ?? 0,
    cacheWrite: fact.tokens.cache.write ?? 0,
  }))
}

export function chartRowsFromSeries(value: string, series: UsageSeries) {
  return series.daily.map((row) => ({
    date: row.date,
    value,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
  }))
}

function canonicalTotals(row: CentralUsageRow): CanonicalBreakdownTotals {
  return {
    value: rowText(row, "value", "unavailable"),
    turnCount: rowNumber(row, "turnCount", "turn_count"),
    input: rowNumber(row, "input", "input_tokens"),
    output: rowNumber(row, "output", "output_tokens"),
    reasoning: rowNumber(row, "reasoning", "reasoning_tokens"),
    cacheRead: rowNumber(row, "cacheRead", "cache_read_tokens"),
    cacheWrite: rowNumber(row, "cacheWrite", "cache_write_tokens"),
    unknownCategories: rowNumber(row, "unknownCategories", "unknown_token_count"),
    partialTurnCount: rowNumber(row, "partialTurnCount", "partial_turn_count"),
    unavailableTurnCount: rowNumber(row, "unavailableTurnCount", "unavailable_turn_count"),
    errorTurnCount: rowNumber(row, "errorTurnCount", "error_turn_count"),
  }
}

export function mergeBreakdownRows(...sources: Array<readonly CentralUsageRow[] | undefined>) {
  const merged = new Map<string, CanonicalBreakdownTotals>()
  for (const source of sources) {
    for (const raw of source ?? []) {
      const row = canonicalTotals(raw)
      const current = merged.get(row.value) ?? {
        ...row,
        turnCount: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        unknownCategories: 0,
        partialTurnCount: 0,
        unavailableTurnCount: 0,
        errorTurnCount: 0,
      }
      for (const field of [
        "turnCount",
        "input",
        "output",
        "reasoning",
        "cacheRead",
        "cacheWrite",
        "unknownCategories",
        "partialTurnCount",
        "unavailableTurnCount",
        "errorTurnCount",
      ] as const)
        current[field] += row[field]
      merged.set(row.value, current)
    }
  }
  return [...merged.values()]
}

/** One priced model row per fact, filed under the breakdown group it counts toward. */
export function modelRowsFromFacts(facts: readonly TurnUsageRevision[], groupOf: (fact: TurnUsageRevision) => string) {
  return facts.map((fact) => ({
    group: groupOf(fact),
    value: usageModelKey(fact.providerId, fact.modelId),
    input_tokens: fact.tokens.input ?? 0,
    output_tokens: fact.tokens.output ?? 0,
    reasoning_tokens: fact.tokens.reasoning ?? 0,
    cache_read_tokens: fact.tokens.cache.read ?? 0,
    cache_write_tokens: fact.tokens.cache.write ?? 0,
    cache_write_1h_tokens: fact.tokens.cache.write1h ?? 0,
  }))
}

function breakdownStatus(row: CanonicalBreakdownTotals, priced: PricedUsage): UsageBreakdownRow["status"] {
  if (row.unavailableTurnCount > 0 && row.unavailableTurnCount === row.turnCount) return "unavailable"
  // Unpriced outranks partial: every harness leaves some category unreported,
  // so a partial label would hide that the row's cost is missing from the total.
  if (priced.unpricedTokens > 0) return "unpriced"
  return row.partialTurnCount > 0 || row.unknownCategories > 0 ? "partial" : "final"
}

function breakdownLabel(value: string, dimension?: string) {
  if (value === "local") return "Local"
  if (value === "cloud") return "Cloud"
  if (value === "unavailable") return "Unavailable"
  return dimension === "model" ? (value.split("/").at(-1) ?? value) : value
}

export async function canonicalBreakdownPage(input: {
  pricing: UsagePricing
  dimension: UsageFilterDimension
  rows: CanonicalBreakdownTotals[]
  modelRows?: readonly CentralUsageRow[]
  metric: "tokens" | "cost"
  after?: string
  limit?: number
}) {
  const limit = input.limit ?? 25
  const modelRowsByGroup = new Map<string, CentralUsageRow[]>()
  for (const modelRow of input.modelRows ?? []) {
    const group = rowText(modelRow, "group")
    const rows = modelRowsByGroup.get(group) ?? []
    rows.push(modelRow)
    modelRowsByGroup.set(group, rows)
  }
  const priceRow = async (row: CanonicalBreakdownTotals) => {
    const priced = await priceCentralBreakdown(input.pricing, modelRowsByGroup.get(row.value) ?? [])
    const measuredTokens = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
    if (priced.pricedTokens + priced.unpricedTokens < measuredTokens)
      priced.unpricedTokens += measuredTokens - priced.pricedTokens - priced.unpricedTokens
    const href = publicUsageHref(input.dimension, row.value)
    return {
      ...row,
      label: breakdownLabel(row.value, input.dimension),
      estimatedUsd: priced.estimatedUsd,
      pricedTokens: priced.pricedTokens,
      unpricedTokens: priced.unpricedTokens,
      status: breakdownStatus(row, priced),
      ...(href ? { href } : {}),
    }
  }
  const tokens = (row: CanonicalBreakdownTotals) =>
    row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
  const page = <Row extends { value: string }>(ordered: Row[]) => {
    const offset = input.after ? Math.max(0, ordered.findIndex((row) => row.value === input.after) + 1) : 0
    const candidates = ordered.slice(offset, offset + limit + 1)
    return { candidates, hasMore: candidates.length > limit }
  }
  if (input.metric === "tokens") {
    const { candidates, hasMore } = page(
      input.rows.toSorted((a, b) => tokens(b) - tokens(a) || a.value.localeCompare(b.value)),
    )
    const rows = await Promise.all(candidates.slice(0, limit).map(priceRow))
    return { dimension: input.dimension, rows, ...(hasMore ? { next: rows.at(-1)?.value } : {}) }
  }

  const { candidates, hasMore } = page(
    (await Promise.all(input.rows.map(priceRow))).toSorted(
      (a, b) => b.estimatedUsd - a.estimatedUsd || a.value.localeCompare(b.value),
    ),
  )
  const rows = candidates.slice(0, limit)
  return { dimension: input.dimension, rows, ...(hasMore ? { next: rows.at(-1)?.value } : {}) }
}

export function locationShare(...sources: Array<readonly CentralUsageRow[] | undefined>) {
  const rows = mergeBreakdownRows(...sources)
  const tokens = (row: CanonicalBreakdownTotals | undefined) =>
    row ? row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite : 0
  return {
    localTokens: tokens(rows.find((row) => row.value === "local")),
    cloudTokens: tokens(rows.find((row) => row.value === "cloud")),
  }
}

export function appBreakdownRow(series: UsageSeries) {
  return { value: "Claxedo", ...series.totals }
}

/** Rows priced per model, each filed under the model it names. */
export function modelRowsByModel(rows: readonly CentralUsageRow[] | undefined) {
  return (rows ?? []).map((row) => ({ ...row, group: rowText(row, "value") }))
}
