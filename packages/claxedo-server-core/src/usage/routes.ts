import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { UnifiedUsageResponse, UsageBreakdownRow, UsageFilterDimension } from "@claxedo/usage-contract"
export type { UnifiedUsageResponse } from "@claxedo/usage-contract"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "../platform/auth/auth"
import type { UsageProjectionLedger } from "./ledger"
export type { UsageProjectionLedger } from "./ledger"
import { TOKEN_TRACKER_VERSION, type PricedUsage, type UsagePricing } from "./adapters/token-tracker-pricing"
import { isJsonRecord } from "../platform/runtime/lib/json"
import {
  readTurnUsageRevision,
  type TurnUsageRevision,
  type UsageOwnedTurnReader,
  type UsageRevisionReader,
} from "./contracts"
import { tokenTrackerSourceForHarness } from "./provenance"
import { cloudWorkspaceUsageContext } from "./usage-report"
import {
  centralProjectionSeries,
  readCentralUsage,
  rowNumber,
  rowText,
  type CentralUsageProjection,
  type CentralUsageRow,
  groupUsageFacts,
  groupUsageFactsBy,
  isUsageFilterDimension,
  latestUsageFacts,
  mergeUsageSeries,
  usageSeriesFromExternal,
  usageSeriesFromFacts,
  usageFactFilterOptions,
  usageFactMatches,
  usageFactDimension,
  usageLocation,
  usageModelKey,
  usageDateFormatter,
  USAGE_FILTER_DIMENSIONS,
  type ExternalUsageBucket,
  type UsageFilters,
  type UsageSeries,
} from "./projection"
import { publicUsageHref } from "./public-href"

type LocalHistorySnapshot = {
  rows: ExternalUsageBucket[]
  totalRows: ExternalUsageBucket[]
  coverage: Array<{ source: string; status: "available" | "degraded" | "unavailable" | "unsupported"; error?: string }>
  classifiedClaxedo: number
  unclassified: number
  scannedAt?: number
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: () => Error) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// Ninety inclusive local calendar days can span one DST fall-back hour.
// This still rejects a 91-day UTC request while accepting the advertised
// 90-day control in every IANA timezone.
const MAX_RANGE_MS = 90 * 86_400_000 + 2 * 3_600_000

type UsageTelemetry = {
  capture(distinctId: string, event: string, properties: Record<string, string | number | boolean>): void
}

function captureUsage(telemetry: UsageTelemetry | undefined, properties: Record<string, string | number | boolean>) {
  try {
    telemetry?.capture("system", "usage.dashboard", properties)
  } catch {
    // Operational evidence cannot fail the dashboard.
  }
}

function validRange(since: number, until: number) {
  return Number.isFinite(since) && Number.isFinite(until) && until >= since && until - since <= MAX_RANGE_MS
}

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone })
    return true
  } catch {
    return false
  }
}

function parseUsageQuery(query: (name: string) => string | undefined) {
  const since = Number(query("since"))
  const until = Number(query("until"))
  const timeZone = query("timezone") || "UTC"
  if (!validRange(since, until)) return { error: "invalid_usage_range" } as const
  if (!validTimeZone(timeZone)) return { error: "invalid_timezone" } as const
  const requestedGroup = query("group")
  const group = requestedGroup && isUsageFilterDimension(requestedGroup) ? requestedGroup : undefined
  if (requestedGroup && !group) return { error: "invalid_usage_group" } as const
  const metric = query("metric") || "tokens"
  if (metric !== "tokens" && metric !== "cost") return { error: "invalid_usage_metric" } as const
  const requestedLimit = query("limit") === undefined ? undefined : Number(query("limit"))
  if (
    requestedLimit !== undefined &&
    (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
  ) {
    return { error: "invalid_usage_limit" } as const
  }
  const view = query("view") || "claxedo"
  if (view !== "quota" && view !== "claxedo" && view !== "total") return { error: "invalid_usage_view" } as const
  return { value: { since, until, timeZone, group, metric, requestedLimit, view } } as const
}

const emptyCost = (): CostWithDaily => ({
  estimatedUsd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  catalog: { adapter: "tokentracker-cli", version: TOKEN_TRACKER_VERSION, source: "bundled-seed" },
  daily: [],
})

type CostWithDaily = PricedUsage & {
  daily: Array<{ date: string; estimatedUsd: number; pricedTokens: number; unpricedTokens: number }>
}

function filtersFromQuery(query: (name: string) => string | undefined): UsageFilters {
  const filters: UsageFilters = {}
  for (const dimension of USAGE_FILTER_DIMENSIONS) {
    const value = query(`filter_${dimension}`)
    if (value) filters[dimension] = value
  }
  return filters
}

async function priceFacts(
  pricing: UsagePricing,
  facts: readonly TurnUsageRevision[],
  timeZone = "UTC",
): Promise<CostWithDaily> {
  const total = emptyCost()
  const days = new Map<string, PricedUsage>()
  const formatDate = usageDateFormatter(timeZone)
  for (const fact of facts) {
    const item = await pricing({
      source: fact.providerId,
      model: fact.modelId,
      tokens: {
        input: fact.tokens.input ?? 0,
        output: fact.tokens.output ?? 0,
        reasoning: fact.tokens.reasoning ?? 0,
        cacheRead: fact.tokens.cache.read ?? 0,
        cacheWrite: fact.tokens.cache.write ?? 0,
        cacheWrite1h: fact.tokens.cache.write1h ?? null,
      },
    })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
    const date = formatDate.format(new Date(fact.observedAt))
    const day = days.get(date) ?? emptyCost()
    day.estimatedUsd += item.estimatedUsd
    day.pricedTokens += item.pricedTokens
    day.unpricedTokens += item.unpricedTokens
    day.catalog = item.catalog
    days.set(date, day)
  }
  total.daily = [...days]
    .map(([date, item]) => ({
      date,
      estimatedUsd: item.estimatedUsd,
      pricedTokens: item.pricedTokens,
      unpricedTokens: item.unpricedTokens,
    }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
  return total
}

async function priceExternal(
  pricing: UsagePricing,
  rows: LocalHistorySnapshot["rows"],
  timeZone = "UTC",
): Promise<CostWithDaily> {
  const total = emptyCost()
  const days = new Map<string, PricedUsage>()
  const formatDate = usageDateFormatter(timeZone)
  for (const row of rows) {
    const item = await pricing({ source: row.app, model: row.model, tokens: row.tokens })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
    const date = formatDate.format(new Date(row.bucketStart))
    const day = days.get(date) ?? emptyCost()
    day.estimatedUsd += item.estimatedUsd
    day.pricedTokens += item.pricedTokens
    day.unpricedTokens += item.unpricedTokens
    day.catalog = item.catalog
    days.set(date, day)
  }
  total.daily = [...days]
    .map(([date, item]) => ({
      date,
      estimatedUsd: item.estimatedUsd,
      pricedTokens: item.pricedTokens,
      unpricedTokens: item.unpricedTokens,
    }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
  return total
}

function mergeCost(...costs: CostWithDaily[]) {
  const total = emptyCost()
  const days = new Map<string, { estimatedUsd: number; pricedTokens: number; unpricedTokens: number }>()
  for (const item of costs) {
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
    for (const day of item.daily) {
      const current = days.get(day.date) ?? { estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 0 }
      current.estimatedUsd += day.estimatedUsd
      current.pricedTokens += day.pricedTokens
      current.unpricedTokens += day.unpricedTokens
      days.set(day.date, current)
    }
  }
  total.daily = [...days].map(([date, value]) => ({ date, ...value })).toSorted((a, b) => a.date.localeCompare(b.date))
  return total
}

async function priceCentralBreakdown(pricing: UsagePricing, rows: readonly CentralUsageRow[]) {
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

async function priceCentralProjection(pricing: UsagePricing, projection: CentralUsageProjection) {
  const total = await priceCentralBreakdown(pricing, projection.models ?? [])
  const daily = new Map<string, PricedUsage>()
  for (const row of projection.dailyModels ?? []) {
    const date = rowText(row, "date")
    if (!date) continue
    const item = await priceCentralBreakdown(pricing, [row])
    const current = daily.get(date) ?? emptyCost()
    current.estimatedUsd += item.estimatedUsd
    current.pricedTokens += item.pricedTokens
    current.unpricedTokens += item.unpricedTokens
    current.catalog = item.catalog
    daily.set(date, current)
  }
  total.daily = [...daily]
    .map(([date, item]) => ({
      date,
      estimatedUsd: item.estimatedUsd,
      pricedTokens: item.pricedTokens,
      unpricedTokens: item.unpricedTokens,
    }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
  return total
}

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

function mergeChartSeries(dimension: string, ...sources: Array<readonly CentralUsageRow[] | undefined>) {
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

function chartRowsFromFacts(
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

function externalUsageDimension(row: ExternalUsageBucket, dimension: string) {
  if (dimension === "app") return row.app
  if (dimension === "provider") return row.provider
  if (dimension === "model") return usageModelKey(row.provider, row.model)
  return dimension === "location" ? "local" : "unavailable"
}

function chartRowsFromExternal(
  rows: LocalHistorySnapshot["rows"],
  groupOf: (row: ExternalUsageBucket) => string,
  timeZone: string,
) {
  const formatDate = usageDateFormatter(timeZone)
  return rows.map((row) => ({
    date: formatDate.format(new Date(row.bucketStart)),
    value: groupOf(row),
    input: row.tokens.input ?? 0,
    output: row.tokens.output ?? 0,
    reasoning: row.tokens.reasoning ?? 0,
    cacheRead: row.tokens.cacheRead ?? 0,
    cacheWrite: row.tokens.cacheWrite ?? 0,
  }))
}

function chartRowsFromSeries(value: string, series: UsageSeries) {
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

function mergeBreakdownRows(...sources: Array<readonly CentralUsageRow[] | undefined>) {
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
function modelRowsFromFacts(facts: readonly TurnUsageRevision[], groupOf: (fact: TurnUsageRevision) => string) {
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

/** One priced model row per history bucket, filed under the breakdown group it counts toward. */
function modelRowsFromExternal(rows: readonly ExternalUsageBucket[], groupOf: (row: ExternalUsageBucket) => string) {
  return rows.map((row) => ({
    group: groupOf(row),
    value: usageModelKey(row.provider, row.model),
    input_tokens: row.tokens.input ?? 0,
    output_tokens: row.tokens.output ?? 0,
    reasoning_tokens: row.tokens.reasoning ?? 0,
    cache_read_tokens: row.tokens.cacheRead ?? 0,
    cache_write_tokens: row.tokens.cacheWrite ?? 0,
    cache_write_1h_tokens: row.tokens.cacheWrite1h ?? 0,
  }))
}

/** History buckets as breakdown totals, grouped the way `groupOf` names them. */
function breakdownRowsFromExternal(rows: readonly ExternalUsageBucket[], groupOf: (row: ExternalUsageBucket) => string) {
  return rows.map((row) => ({
    value: groupOf(row),
    turnCount: row.turnCount,
    ...row.tokens,
    unknownCategories: [
      row.tokens.input,
      row.tokens.output,
      row.tokens.reasoning,
      row.tokens.cacheRead,
      row.tokens.cacheWrite,
    ].filter((value) => value === null).length,
  }))
}

function breakdownStatus(row: CanonicalBreakdownTotals, priced: PricedUsage): UsageBreakdownRow["status"] {
  if (row.unavailableTurnCount > 0 && row.unavailableTurnCount === row.turnCount) return "unavailable"
  if (row.partialTurnCount > 0 || row.unknownCategories > 0) return "partial"
  return priced.unpricedTokens > 0 ? "unpriced" : "final"
}

function breakdownLabel(value: string, dimension?: string) {
  if (value === "local") return "Local"
  if (value === "cloud") return "Cloud"
  if (value === "unavailable") return "Unavailable"
  return dimension === "model" ? (value.split("/").at(-1) ?? value) : value
}

async function canonicalBreakdownPage(input: {
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

function externalMatches(row: LocalHistorySnapshot["rows"][number], filters: UsageFilters) {
  return (
    (!filters.app || row.app === filters.app) &&
    (!filters.provider || row.provider === filters.provider) &&
    (!filters.model || usageModelKey(row.provider, row.model) === filters.model || row.model === filters.model) &&
    (!filters.location || filters.location === "local")
  )
}

function externalFilterOptions(rows: LocalHistorySnapshot["rows"]) {
  return {
    app: [...new Set(rows.map((row) => row.app))].toSorted(),
    provider: [...new Set(rows.map((row) => row.provider))].toSorted(),
    model: [...new Set(rows.map((row) => usageModelKey(row.provider, row.model)))].toSorted(),
    location: rows.length > 0 ? ["local"] : [],
  }
}

/**
 * The tool a cloud turn counts toward in Total, where this machine's own
 * turns are filed under the CLI whose transcript recorded them.
 */
function totalFactApp(fact: TurnUsageRevision) {
  return tokenTrackerSourceForHarness(fact.harness) ?? fact.harness
}

function totalFactDimension(fact: TurnUsageRevision, dimension: UsageFilterDimension) {
  return dimension === "app" ? totalFactApp(fact) : usageFactDimension(fact, dimension)
}

/** The Total filters `externalMatches` applies, asked of a cloud turn. */
function totalFactMatches(fact: TurnUsageRevision, filters: UsageFilters) {
  const model = usageModelKey(fact.providerId, fact.modelId)
  return (
    (!filters.app || totalFactApp(fact) === filters.app) &&
    (!filters.provider || fact.providerId === filters.provider) &&
    (!filters.model || model === filters.model || fact.modelId === filters.model) &&
    (!filters.location || filters.location === usageLocation(fact.location))
  )
}

function totalFactFilterOptions(facts: readonly TurnUsageRevision[]) {
  const values = (value: (fact: TurnUsageRevision) => string) => [...new Set(facts.map(value))].toSorted()
  return {
    app: values(totalFactApp),
    provider: values((fact) => fact.providerId),
    model: values((fact) => usageModelKey(fact.providerId, fact.modelId)),
    location: values((fact) => usageLocation(fact.location)),
  }
}

function mergeFilterOptions(...values: Array<Record<string, string[]> | undefined>) {
  const merged = new Map<string, Set<string>>()
  for (const value of values)
    for (const [dimension, rows] of Object.entries(value ?? {})) {
      const target = merged.get(dimension) ?? new Set<string>()
      for (const row of rows) target.add(row)
      merged.set(dimension, target)
    }
  return Object.fromEntries([...merged].map(([dimension, rows]) => [dimension, [...rows].toSorted()]))
}

function locationShare(...sources: Array<readonly CentralUsageRow[] | undefined>) {
  const rows = mergeBreakdownRows(...sources)
  const tokens = (row: CanonicalBreakdownTotals | undefined) =>
    row ? row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite : 0
  return {
    localTokens: tokens(rows.find((row) => row.value === "local")),
    cloudTokens: tokens(rows.find((row) => row.value === "cloud")),
  }
}

function appBreakdownRow(series: UsageSeries) {
  return { value: "Claxedo", ...series.totals }
}

/** Rows priced per model, each filed under the model it names. */
function modelRowsByModel(rows: readonly CentralUsageRow[] | undefined) {
  return (rows ?? []).map((row) => ({ ...row, group: rowText(row, "value") }))
}

/**
 * The most cloud revisions one usage answer carries. A revision serializes to
 * about 1 KB (994 bytes with ULID ids and a full quality block), so the hosted
 * answer, the desktop's IPC hop and the sidecar request stay near 10 MB.
 */
const MAX_CLOUD_USAGE_FACTS = 10_000
const MAX_CLOUD_USAGE_BODY_BYTES = 16 * 1024 * 1024
const MAX_CLOUD_USAGE_ERROR_LENGTH = 500

export function UsageRoutes(input: {
  ledger: UsageProjectionLedger
  /**
   * The signed account a request reads as, resolved by the composition that
   * owns authentication. Nothing for an unsigned caller; a rejected credential
   * throws the `ControlPlaneAuthError` its verifier raised.
   */
  identity(request: Request): Promise<{ org_id: string; user_id: string } | undefined>
  pricing: UsagePricing
  telemetry?: UsageTelemetry
}) {
  const app = new Hono()
  // A signed desktop draws its Usage view from its own sidecar, which holds no
  // account credential; Electron main fetches the account's cloud turns here
  // and the renderer hands them to the sidecar with the usage request.
  app.get("/cloud-facts", async (c) => {
    try {
      const identity = await input.identity(c.req.raw)
      if (!identity) {
        return c.json(
          { error: { code: "signed_org_required", message: "A signed organization session is required" } },
          401,
        )
      }
      const since = Number(c.req.query("since"))
      const until = Number(c.req.query("until"))
      if (!validRange(since, until)) {
        return c.json(
          { error: { code: "invalid_usage_range", message: "since and until must define a range of at most 90 days" } },
          400,
        )
      }
      if (!input.ledger.cloudUsageFacts) {
        return c.json({ error: { code: "usage_projection_unavailable", message: "Cloud usage is not stored here" } }, 503)
      }
      const facts = await input.ledger.cloudUsageFacts({ ...identity, since, until, limit: MAX_CLOUD_USAGE_FACTS + 1 })
      if (facts.length > MAX_CLOUD_USAGE_FACTS) {
        return c.json(
          {
            error: {
              code: "cloud_usage_range_too_large",
              message: `More than ${MAX_CLOUD_USAGE_FACTS} cloud turns fall in this range; choose a shorter one`,
            },
          },
          422,
        )
      }
      return c.json({ facts })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
  })
  app.get("/", async (c) => {
    const startedAt = Date.now()
    try {
      const identity = await input.identity(c.req.raw)
      if (!identity) {
        return c.json({ error: "signed_org_required", message: "A signed organization session is required" }, 401)
      }
      const parsed = parseUsageQuery((name) => c.req.query(name))
      if (parsed.error) {
        const messages: Partial<Record<typeof parsed.error, string>> = {
          invalid_usage_range: "since and until must define a range of at most 90 days",
          invalid_usage_group: "group is invalid",
          invalid_usage_limit: "limit must be between 1 and 100",
        }
        const message = messages[parsed.error]
        return c.json({ error: parsed.error, ...(message ? { message } : {}) }, 400)
      }
      const { since, until, timeZone, group, metric, requestedLimit, view } = parsed.value
      if (view === "quota") {
        const series = usageSeriesFromFacts({ facts: [], since, until, timeZone })
        captureUsage(input.telemetry, {
          deployment: "hosted",
          rangeDays: Math.ceil((until - since) / 86_400_000),
          latencyMs: Date.now() - startedAt,
          claxedoStatus: "unavailable",
          externalStatus: "unavailable",
          quotaStatus: "unavailable",
          pricedTokens: 0,
          unpricedTokens: 0,
        })
        return c.json({
          version: 1 as const,
          range: { since, until, timeZone },
          quota: { status: "unavailable" as const },
          claxedo: {
            ...series,
            cost: emptyCost(),
            locationShare: { localTokens: 0, cloudTokens: 0 },
            status: "unavailable" as const,
            scope: "cross-machine" as const,
          },
          externalLocal: {
            ...series,
            cost: emptyCost(),
            status: "unavailable" as const,
            coverage: [],
            unclassified: 0,
          },
          total: series,
          totalCost: emptyCost(),
          filterOptions: { claxedo: {}, total: {} },
        })
      }
      if (!input.ledger.usageDashboard) {
        return c.json({ error: "usage projection unavailable" }, 503)
      }
      const filters = filtersFromQuery((name) => c.req.query(name))
      const dimension = group && group !== "app" ? group : undefined
      const centralFilters = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "app"))
      const includeClaxedo = !filters.app || filters.app.toLowerCase() === "claxedo"
      const summary = readCentralUsage(
        await input.ledger.usageDashboard({
          ...identity,
          since,
          until,
          timeZone,
          ...(dimension ? { dimension } : {}),
          ...(Object.keys(centralFilters).length ? { filters: centralFilters } : {}),
        }),
      )
      const claxedo = includeClaxedo
        ? centralProjectionSeries(summary)
        : usageSeriesFromFacts({ facts: [], since, until, timeZone })
      const claxedoCost = includeClaxedo
        ? await priceCentralProjection(input.pricing, summary)
        : emptyCost()
      const chart = group
        ? mergeChartSeries(
            group,
            group === "app"
              ? includeClaxedo
                ? chartRowsFromSeries("Claxedo", claxedo)
                : []
              : includeClaxedo
                ? summary.dailyBreakdown
                : [],
          )
        : undefined
      const base = {
        version: 1 as const,
        range: { since, until, timeZone },
        quota: { status: "unavailable" as const },
        claxedo: {
          ...claxedo,
          cost: claxedoCost,
          locationShare: locationShare(includeClaxedo ? summary.locations : []),
          status: "available" as const,
          scope: "cross-machine" as const,
        },
        externalLocal: {
          ...usageSeriesFromExternal({ rows: [], since, until, timeZone: "UTC" }),
          status: "unavailable" as const,
          coverage: [],
          unclassified: 0,
          cost: emptyCost(),
        },
        total: claxedo,
        totalCost: claxedoCost,
        filterOptions: {
          claxedo: summary.filters ?? {},
          total: mergeFilterOptions({ app: ["Claxedo"] }, summary.filters),
        },
        ...(chart ? { chart } : {}),
      }
      const captureRequest = () =>
        captureUsage(input.telemetry, {
          deployment: "hosted",
          rangeDays: Math.ceil((until - since) / 86_400_000),
          latencyMs: Date.now() - startedAt,
          claxedoStatus: "available",
          externalStatus: "unavailable",
          quotaStatus: "unavailable",
          pricedTokens: claxedoCost.pricedTokens,
          unpricedTokens: claxedoCost.unpricedTokens,
        })
      if (!group) {
        captureRequest()
        return c.json(base)
      }
      const rows =
        group === "app"
          ? mergeBreakdownRows(includeClaxedo ? [appBreakdownRow(claxedo)] : [])
          : mergeBreakdownRows(includeClaxedo ? summary.breakdown : [])
      const modelRows =
        group === "app"
          ? (includeClaxedo ? (summary.models ?? []) : []).map((row) => ({ ...row, group: "Claxedo" }))
          : includeClaxedo
            ? summary.breakdownModels
            : []
      const breakdown = await canonicalBreakdownPage({
        pricing: input.pricing,
        dimension: group,
        rows,
        modelRows,
        metric,
        ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      })
      const modelBreakdown = await canonicalBreakdownPage({
        pricing: input.pricing,
        dimension: "model",
        rows: mergeBreakdownRows(includeClaxedo ? summary.models : []),
        modelRows: includeClaxedo ? modelRowsByModel(summary.models) : [],
        metric,
        ...(c.req.query("model_after") ? { after: c.req.query("model_after") } : {}),
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      })
      captureRequest()
      return c.json({ ...base, breakdown, modelBreakdown })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status)
      }
      throw error
    }
  })
  return app
}

async function localUsageBreakdowns(input: {
  pricing: UsagePricing
  includeClaxedo: boolean
  claxedoFacts: TurnUsageRevision[]
  claxedoSeries: UsageSeries
  totalRows: ExternalUsageBucket[]
  totalCloudFacts: TurnUsageRevision[]
  group: UsageFilterDimension
  view: "claxedo" | "total"
  metric: "tokens" | "cost"
  timeZone: string
  requestedLimit: number | undefined
  after: string | undefined
  modelAfter: string | undefined
}) {
  const { pricing, claxedoFacts, claxedoSeries, totalRows, totalCloudFacts, group, view, metric, timeZone } = input
  const page = {
    pricing,
    metric,
    ...(input.requestedLimit === undefined ? {} : { limit: input.requestedLimit }),
  }
  const model = (fact: TurnUsageRevision) => usageModelKey(fact.providerId, fact.modelId)
  const externalModel = (row: ExternalUsageBucket) => usageModelKey(row.provider, row.model)
  if (view === "total") {
    const groupOfRow = (row: ExternalUsageBucket) => externalUsageDimension(row, group)
    const groupOfFact = (fact: TurnUsageRevision) => totalFactDimension(fact, group)
    return {
      breakdown: await canonicalBreakdownPage({
        ...page,
        dimension: group,
        rows: mergeBreakdownRows(
          breakdownRowsFromExternal(totalRows, groupOfRow),
          groupUsageFactsBy(totalCloudFacts, groupOfFact),
        ),
        modelRows: [...modelRowsFromExternal(totalRows, groupOfRow), ...modelRowsFromFacts(totalCloudFacts, groupOfFact)],
        ...(input.after ? { after: input.after } : {}),
      }),
      modelBreakdown: await canonicalBreakdownPage({
        ...page,
        dimension: "model",
        rows: mergeBreakdownRows(
          breakdownRowsFromExternal(totalRows, externalModel),
          groupUsageFactsBy(totalCloudFacts, model),
        ),
        modelRows: [...modelRowsFromExternal(totalRows, externalModel), ...modelRowsFromFacts(totalCloudFacts, model)],
        ...(input.modelAfter ? { after: input.modelAfter } : {}),
      }),
      chart: mergeChartSeries(
        group,
        chartRowsFromExternal(totalRows, groupOfRow, timeZone),
        chartRowsFromFacts(totalCloudFacts, groupOfFact, timeZone),
      ),
    }
  }
  const groupOf = (fact: TurnUsageRevision) => (group === "app" ? "Claxedo" : usageFactDimension(fact, group))
  return {
    breakdown: await canonicalBreakdownPage({
      ...page,
      dimension: group,
      rows: mergeBreakdownRows(
        group !== "app"
          ? groupUsageFactsBy(claxedoFacts, groupOf)
          : input.includeClaxedo
            ? [appBreakdownRow(claxedoSeries)]
            : [],
      ),
      modelRows: modelRowsFromFacts(claxedoFacts, groupOf),
      ...(input.after ? { after: input.after } : {}),
    }),
    modelBreakdown: await canonicalBreakdownPage({
      ...page,
      dimension: "model",
      rows: mergeBreakdownRows(groupUsageFacts(claxedoFacts, "model")),
      modelRows: modelRowsFromFacts(claxedoFacts, model),
      ...(input.modelAfter ? { after: input.modelAfter } : {}),
    }),
    chart: mergeChartSeries(
      group,
      group === "app" ? chartRowsFromSeries("Claxedo", claxedoSeries) : chartRowsFromFacts(claxedoFacts, groupOf, timeZone),
    ),
  }
}

/**
 * What a signed desktop learned of its account's cloud turns before asking
 * this machine for usage. `dropped` counts the revisions it sent that cannot
 * be merged: the view names how many rather than refusing the rest with them.
 */
type CloudUsage = { facts: TurnUsageRevision[]; dropped: number } | { error: string }

/**
 * Whether a revision is filed the way the plane files a cloud workspace's
 * turn. Such a revision can never share a key with one this machine metered,
 * so merging it cannot stand in for a local turn.
 */
function isCloudWorkspaceFiling(fact: TurnUsageRevision) {
  if (fact.location !== "cloud-workspace" || !fact.workspaceId) return false
  const filing = cloudWorkspaceUsageContext({ workspaceId: fact.workspaceId, sessionId: fact.sessionId })
  return fact.hostId === filing.hostId && fact.sessionRef === filing.sessionRef
}

function readCloudUsage(body: unknown):
  | { value: CloudUsage }
  | { error: { code: string; message: string }; status: 400 | 413 } {
  const cloud = isJsonRecord(body) && isJsonRecord(body.cloud) ? body.cloud : undefined
  if (cloud?.status === "unavailable" && typeof cloud.error === "string") {
    return { value: { error: cloud.error.trim().slice(0, MAX_CLOUD_USAGE_ERROR_LENGTH) } }
  }
  if (cloud?.status !== "available" || !Array.isArray(cloud.facts)) {
    return {
      status: 400,
      error: {
        code: "invalid_cloud_usage",
        message: 'cloud must be { status: "available", facts } or { status: "unavailable", error }',
      },
    }
  }
  if (cloud.facts.length > MAX_CLOUD_USAGE_FACTS) {
    return {
      status: 413,
      error: { code: "cloud_usage_too_large", message: `At most ${MAX_CLOUD_USAGE_FACTS} cloud revisions are accepted` },
    }
  }
  const facts: TurnUsageRevision[] = []
  let dropped = 0
  for (const raw of cloud.facts) {
    const fact = readTurnUsageRevision(raw)
    if (fact && isCloudWorkspaceFiling(fact)) facts.push(fact)
    else dropped += 1
  }
  return { value: { facts, dropped } }
}

/** Why the account's cloud turns are missing from this answer, or partly so. */
function cloudUsageNotice(cloud: CloudUsage | undefined) {
  if (!cloud) return undefined
  if ("error" in cloud) return cloud.error ? `Cloud usage is unavailable: ${cloud.error}` : "Cloud usage is unavailable."
  if (cloud.dropped === 0) return undefined
  return `${cloud.dropped} cloud ${cloud.dropped === 1 ? "turn" : "turns"} could not be read and ${
    cloud.dropped === 1 ? "is" : "are"
  } not counted.`
}

const emptyHistory = (): LocalHistorySnapshot => ({
  rows: [],
  totalRows: [],
  coverage: [],
  classifiedClaxedo: 0,
  unclassified: 0,
})

export function LocalUsageRoutes(input: {
  local: UsageRevisionReader & UsageOwnedTurnReader
  identity(request: Request): Promise<{ org_id: string; user_id: string } | undefined>
  /**
   * Whether this caller stands for the machine itself. Machine-scoped reads
   * (external history, quota, turns no producer account owns, the account's
   * cloud turns merged into them) are operator-only; other signed callers see
   * only what their identity produced. When absent, a request without a
   * bearer token counts as the operator — the unsigned-local posture where
   * the machine has exactly one user.
   */
  machineOperator?: (request: Request) => Promise<boolean> | boolean
  /**
   * Plan usage for the quota view. Takes the request because the tenant it
   * answers for is the credential registry's, which only the composition that
   * mounted the credential routes can resolve the same way they do.
   */
  quota?: (input: { request: Request; refresh: boolean }) => Promise<UnifiedUsageResponse["quota"]>
  history?: (range: { since: number; until: number; refresh: boolean }) => Promise<LocalHistorySnapshot>
  pricing: UsagePricing
  telemetry?: UsageTelemetry
}) {
  // Precommitted above the 35s representative cold-scan budget. Warm and
  // changed-file refreshes are expected to stay below 5s; the extra margin is
  // for a first scan competing with desktop startup I/O.
  const LOCAL_HISTORY_DEADLINE_MS = 40_000
  const app = new Hono()
  const historyCache = new Map<string, LocalHistorySnapshot>()
  const quotaCache = new Map<string, UnifiedUsageResponse["quota"]>()
  const consumedRefreshNonces = new Set<number>()
  const deadline = <T>(promise: Promise<T>, label: string, timeoutMs = 8_000) =>
    withTimeout(promise, timeoutMs, () => new Error(`${label} timed out`))
  const rememberHistory = (key: string, value: LocalHistorySnapshot) => {
    historyCache.delete(key)
    historyCache.set(key, value)
    while (historyCache.size > 8) historyCache.delete(historyCache.keys().next().value!)
  }
  const rememberQuota = (key: string, value: UnifiedUsageResponse["quota"]) => {
    quotaCache.delete(key)
    quotaCache.set(key, value)
    while (quotaCache.size > 8) quotaCache.delete(quotaCache.keys().next().value!)
  }
  const consumeRefreshNonce = (raw: string | undefined) => {
    if (raw === undefined) return false
    const nonce = Number(raw)
    if (!Number.isSafeInteger(nonce) || nonce <= 0) return undefined
    if (consumedRefreshNonces.has(nonce)) return false
    consumedRefreshNonces.add(nonce)
    while (consumedRefreshNonces.size > 64) consumedRefreshNonces.delete(consumedRefreshNonces.values().next().value!)
    return true
  }
  // Machine scope — external history, stored quota, facts no producer owns —
  // belongs to the machine's operator. A signed member is not one just for
  // reaching the route; when the composition names no predicate, only a
  // bearer-less request counts (unsigned-local has exactly one user).
  const machineOperator = (request: Request) =>
    input.machineOperator ? input.machineOperator(request) : !request.headers.get("authorization")
  const operatorRequired = (c: Context) =>
    c.json({ error: { code: "operator_required", message: "Machine operator access is required" } }, 403)
  const readUsage = async (c: Context, cloud: CloudUsage | undefined) => {
    const startedAt = Date.now()
    const parsed = parseUsageQuery((name) => c.req.query(name))
    if (parsed.error) return c.json({ error: parsed.error }, 400)
    const { since, until, timeZone, group, metric, requestedLimit, view } = parsed.value
    const filters = filtersFromQuery((name) => c.req.query(name))
    const refresh = consumeRefreshNonce(c.req.query("refresh_nonce"))
    if (refresh === undefined) return c.json({ error: "invalid_refresh_nonce" }, 400)
    let operator: boolean
    try {
      operator = await machineOperator(c.req.raw)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
    if (view === "quota") {
      // Stored plan credentials and the machine's own CLI logins are the
      // operator's data; a signed member asking for plans is asking for the
      // machine's accounts, which is exactly what `operator_required` exists
      // to refuse.
      if (!operator) return operatorRequired(c)
      // The last good plans stand when a read fails, the same way the history
      // view holds its snapshot: the figures a user is looking at did not stop
      // being true because a refresh could not reach a vendor, and blanking
      // every card is how Refresh came to lose the whole view.
      //
      // Held per bearer, because the quota reader resolves its own tenant from
      // the request: one principal's plans must never be drawn for another.
      const quotaKey = c.req.header("authorization") ?? ""
      const quota: UnifiedUsageResponse["quota"] = input.quota
        ? await deadline(input.quota({ request: c.req.raw, refresh }), "quota read")
            .then((answer) => {
              // The plans are what a later failed read stands in with; the
              // spacing of the refresh that produced them expires on its own
              // and would date a held answer as if it had just been throttled.
              if (answer.snapshot) rememberQuota(quotaKey, { status: answer.status, snapshot: answer.snapshot })
              return answer
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              const held = quotaCache.get(quotaKey)
              return held ? { ...held, error: message } : { status: "unavailable" as const, error: message }
            })
        : { status: "unavailable" }
      const series = usageSeriesFromFacts({ facts: [], since, until, timeZone })
      const response: UnifiedUsageResponse = {
        version: 1,
        range: { since, until, timeZone },
        quota,
        claxedo: {
          ...series,
          cost: emptyCost(),
          locationShare: { localTokens: 0, cloudTokens: 0 },
          status: "unavailable",
          scope: "local",
        },
        externalLocal: {
          ...series,
          cost: emptyCost(),
          status: "unavailable",
          coverage: [],
          unclassified: 0,
        },
        total: series,
        totalCost: emptyCost(),
        filterOptions: { claxedo: {}, total: {} },
      }
      captureUsage(input.telemetry, {
        deployment: "local",
        rangeDays: Math.ceil((until - since) / 86_400_000),
        latencyMs: Date.now() - startedAt,
        claxedoStatus: response.claxedo.status,
        externalStatus: response.externalLocal.status,
        quotaStatus: response.quota.status,
        scannerDegraded: 0,
        unclassified: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
      })
      return c.json(response)
    }
    // The Total view scans the machine's own CLI history — every other
    // account's sessions live in it, so a signed member who is not the
    // operator is refused before the scan is even started.
    if (view === "total" && input.history && !operator) return operatorRequired(c)
    const historyTask =
      view === "total" && input.history
        ? deadline(input.history({ since, until, refresh }), "local usage scan", LOCAL_HISTORY_DEADLINE_MS)
            .then((value) => ({ value }))
            .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        : Promise.resolve({ value: emptyHistory() })
    let identity: Awaited<ReturnType<typeof input.identity>>
    try {
      identity = await input.identity(c.req.raw)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
    // A signed caller who is not the machine's operator still sees this
    // node's facts, but only the turns their own account produced.
    const localFacts = identity && !operator
      ? await input.local.ownedBy(identity, { since, until })
      : await input.local.current({ since, until })
    const cloudNotice = cloudUsageNotice(cloud)
    const cloudFacts = cloud && "facts" in cloud
      ? cloud.facts.filter((fact) => fact.observedAt >= since && fact.observedAt <= until)
      : []
    const allClaxedoFacts = latestUsageFacts([...localFacts, ...cloudFacts])
    const includeClaxedo = !filters.app || filters.app.toLowerCase() === "claxedo"
    const claxedoFacts = includeClaxedo ? allClaxedoFacts.filter((fact) => usageFactMatches(fact, filters)) : []
    const claxedoSeries = usageSeriesFromFacts({ facts: claxedoFacts, since, until, timeZone })
    const claxedoCost = await priceFacts(input.pricing, claxedoFacts, timeZone)

    const historyResult = await historyTask
    // A local-history snapshot is bounded by the exact requested instants.
    // Reusing a same-length but shifted window can leak rows from outside the
    // request after a scanner failure.
    const historyKey = JSON.stringify([since, until, timeZone])
    if ("value" in historyResult) rememberHistory(historyKey, historyResult.value)
    const history = "value" in historyResult ? historyResult.value : (historyCache.get(historyKey) ?? emptyHistory())
    const historyError = "error" in historyResult ? historyResult.error : undefined
    // Keep the range boundary authoritative even for cached or future scanner
    // implementations; every downstream total, price, chart and option uses
    // this same bounded collection.
    const historyRows = history.rows.filter((row) => row.bucketStart >= since && row.bucketStart <= until)
    const externalRows = historyRows.filter((row) => externalMatches(row, filters))
    const totalRows = history.totalRows
      .filter((row) => row.bucketStart >= since && row.bucketStart <= until)
      .filter((row) => externalMatches(row, filters))
    // A cloud turn's transcript lives in its sandbox, never in this machine's
    // history, so Total takes it from the revisions instead.
    const cloudRevisions = allClaxedoFacts.filter((fact) => fact.location === "cloud-workspace")
    const totalCloudFacts = view === "total" ? cloudRevisions.filter((fact) => totalFactMatches(fact, filters)) : []
    const externalSeries = usageSeriesFromExternal({ rows: externalRows, since, until, timeZone })
    const externalCost = await priceExternal(input.pricing, externalRows, timeZone)
    const totalSeries = mergeUsageSeries(
      usageSeriesFromExternal({ rows: totalRows, since, until, timeZone }),
      usageSeriesFromFacts({ facts: totalCloudFacts, since, until, timeZone }),
    )
    const totalCost = mergeCost(
      await priceExternal(input.pricing, totalRows, timeZone),
      await priceFacts(input.pricing, totalCloudFacts, timeZone),
    )
    const breakdowns = group
      ? await localUsageBreakdowns({
          pricing: input.pricing,
          includeClaxedo,
          claxedoFacts,
          claxedoSeries,
          totalRows,
          totalCloudFacts,
          group,
          view,
          metric,
          timeZone,
          requestedLimit,
          after: c.req.query("after"),
          modelAfter: c.req.query("model_after"),
        })
      : undefined
    const response: UnifiedUsageResponse = {
      version: 1,
      range: { since, until, timeZone },
      quota: { status: "unavailable" },
      claxedo: {
        ...claxedoSeries,
        cost: claxedoCost,
        locationShare: locationShare(groupUsageFacts(claxedoFacts, "location")),
        ...(cloudNotice ? { status: "degraded" as const, error: cloudNotice } : { status: "available" as const }),
        scope: (cloud && "facts" in cloud) || cloudRevisions.length > 0 ? "cross-machine" : "local",
      },
      externalLocal: {
        ...externalSeries,
        cost: externalCost,
        status: historyError ? "degraded" : view === "total" && input.history ? "available" : "unavailable",
        coverage: history.coverage,
        unclassified: history.unclassified,
        ...(history.scannedAt === undefined ? {} : { scannedAt: history.scannedAt }),
        ...(historyError ? { error: historyError } : {}),
      },
      total: totalSeries,
      totalCost,
      filterOptions: {
        claxedo: usageFactFilterOptions(allClaxedoFacts),
        total: mergeFilterOptions(
          externalFilterOptions(history.totalRows),
          totalFactFilterOptions(view === "total" ? cloudRevisions : []),
        ),
      },
      ...breakdowns,
    }
    captureUsage(input.telemetry, {
      deployment: "local",
      rangeDays: Math.ceil((until - since) / 86_400_000),
      latencyMs: Date.now() - startedAt,
      claxedoStatus: response.claxedo.status,
      externalStatus: response.externalLocal.status,
      quotaStatus: response.quota.status,
      scannerDegraded: response.externalLocal.coverage.filter((source) => source.status !== "available").length,
      unclassified: response.externalLocal.unclassified,
      pricedTokens: response.totalCost.pricedTokens,
      unpricedTokens: response.totalCost.unpricedTokens,
    })
    return c.json(response)
  }
  app.get("/", (c) => readUsage(c, undefined))
  // The same read, carrying the cloud turns a signed desktop fetched from its
  // hosted plane. They are the operator's account's, merged into this
  // machine's view, so only the operator may bring them.
  app.post(
    "/",
    bodyLimit({
      maxSize: MAX_CLOUD_USAGE_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "cloud_usage_too_large",
              message: `Request body exceeds the ${MAX_CLOUD_USAGE_BODY_BYTES}-byte limit`,
            },
          },
          413,
        ),
    }),
    async (c) => {
      let operator: boolean
      try {
        operator = await machineOperator(c.req.raw)
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
      if (!operator) return operatorRequired(c)
      const cloud = readCloudUsage(await c.req.json().catch(() => undefined))
      if ("error" in cloud) return c.json({ error: cloud.error }, cloud.status)
      return readUsage(c, cloud.value)
    },
  )
  return app
}
