import { Hono } from "hono"
import type { UnifiedUsageResponse, UsageBreakdownRow, UsageFilterDimension } from "@claxedo/usage-contract"
export type { UnifiedUsageResponse } from "@claxedo/usage-contract"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
} from "../platform/auth/auth"
import type { UsageLedger } from "./ledger"
export type { UsageLedger } from "./ledger"
import { projectTokenTrackerCost, TOKEN_TRACKER_VERSION, type PricedUsage } from "./adapters/token-tracker-pricing"
import { isNonEmptyString, isOneOf, jsonRecord } from "../platform/runtime/lib/json"
import {
  knownTokenCategories,
  TURN_USAGE_LOCATIONS,
  TURN_USAGE_SETTLEMENTS,
  TURN_USAGE_STATUSES,
  type TurnUsageRevision,
  type UsageRevisionReader,
} from "./contracts"
import {
  centralProjectionSeries,
  readCentralUsage,
  rowNumber,
  rowText,
  type CentralUsageProjection,
  type CentralUsageRow,
  groupUsageFacts,
  isUsageFilterDimension,
  latestUsageFacts,
  mergeUsageSeries,
  usageSeriesFromExternal,
  usageSeriesFromFacts,
  usageFactFilterOptions,
  usageFactMatches,
  usageFactDimension,
  usageModelKey,
  usageDateFormatter,
  USAGE_FILTER_DIMENSIONS,
  type ExternalUsageBucket,
  type UsageBreakdownDimension,
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
}

type UsageOutboxResult = {
  attempted: number
  delivered: number
  conflicts: number
  pending: number
  acknowledged?: Array<Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">>
}

type UsageOutboxSync = {
  flush(identity: { org_id: string; user_id: string }): Promise<UsageOutboxResult>
  clearIdentity(): Promise<UsageOutboxResult>
  notify(): Promise<UsageOutboxResult>
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

async function priceFacts(facts: readonly TurnUsageRevision[], timeZone = "UTC"): Promise<CostWithDaily> {
  const total = emptyCost()
  const days = new Map<string, PricedUsage>()
  const formatDate = usageDateFormatter(timeZone)
  for (const fact of facts) {
    const item = await projectTokenTrackerCost({
      source: fact.providerId,
      model: fact.modelId,
      tokens: {
        input: fact.tokens.input ?? 0,
        output: fact.tokens.output ?? 0,
        reasoning: fact.tokens.reasoning ?? 0,
        cacheRead: fact.tokens.cache.read ?? 0,
        cacheWrite: fact.tokens.cache.write ?? 0,
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

async function priceExternal(rows: LocalHistorySnapshot["rows"], timeZone = "UTC"): Promise<CostWithDaily> {
  const total = emptyCost()
  const days = new Map<string, PricedUsage>()
  const formatDate = usageDateFormatter(timeZone)
  for (const row of rows) {
    const item = await projectTokenTrackerCost({ source: row.app, model: row.model, tokens: row.tokens })
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

async function priceCentralBreakdown(rows: readonly CentralUsageRow[]) {
  const total = emptyCost()
  for (const row of rows) {
    const [source, ...modelParts] = rowText(row, "value").split("/")
    const model = modelParts.join("/")
    if (!source || !model) continue
    const item = await projectTokenTrackerCost({
      source,
      model,
      tokens: {
        input: rowNumber(row, "input_tokens"),
        output: rowNumber(row, "output_tokens"),
        reasoning: rowNumber(row, "reasoning_tokens"),
        cacheRead: rowNumber(row, "cache_read_tokens"),
        cacheWrite: rowNumber(row, "cache_write_tokens"),
      },
    })
    total.estimatedUsd += item.estimatedUsd
    total.pricedTokens += item.pricedTokens
    total.unpricedTokens += item.unpricedTokens
    total.catalog = item.catalog
  }
  return total
}

async function priceAllCentralModels(
  ledger: UsageLedger,
  identity: { org_id: string; user_id: string },
  range: { since: number; until: number },
) {
  const total = emptyCost()
  if (!ledger.usageBreakdown) return total
  let after: string | undefined
  const seen = new Set<string>()
  do {
    const page = readCentralUsage(
      await ledger.usageBreakdown({
        ...identity,
        ...range,
        dimension: "model",
        limit: 100,
        ...(after ? { after } : {}),
      }),
    )
    const priced = await priceCentralBreakdown(page.rows ?? [])
    total.estimatedUsd += priced.estimatedUsd
    total.pricedTokens += priced.pricedTokens
    total.unpricedTokens += priced.unpricedTokens
    total.catalog = priced.catalog
    const next = page.next
    if (next !== undefined && next.length > 0) {
      if (seen.has(next)) throw new Error("central usage breakdown repeated a cursor")
      seen.add(next)
      after = next
    } else after = undefined
  } while (after)
  return total
}

async function priceCentralProjection(
  ledger: UsageLedger,
  identity: { org_id: string; user_id: string },
  range: { since: number; until: number },
  projection: CentralUsageProjection,
) {
  const models = projection.models
  if (models) {
    const total = await priceCentralBreakdown(models)
    const daily = new Map<string, PricedUsage>()
    for (const row of projection.dailyModels ?? []) {
      const date = rowText(row, "date")
      if (!date) continue
      const item = await priceCentralBreakdown([row])
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
  return await priceAllCentralModels(ledger, identity, range)
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
  dimension: UsageBreakdownDimension,
  timeZone: string,
) {
  const formatDate = usageDateFormatter(timeZone)
  return latestUsageFacts(facts).map((fact) => ({
    date: formatDate.format(new Date(fact.observedAt)),
    value: usageFactDimension(fact, dimension),
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
  dimension: "app" | "provider" | "model" | "location",
  timeZone: string,
) {
  const formatDate = usageDateFormatter(timeZone)
  return rows.map((row) => ({
    date: formatDate.format(new Date(row.bucketStart)),
    value:
      externalUsageDimension(row, dimension),
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

function modelBreakdownFromFacts(facts: readonly TurnUsageRevision[], dimension: UsageBreakdownDimension) {
  return facts.map((fact) => ({
    group: usageFactDimension(fact, dimension),
    value: usageModelKey(fact.providerId, fact.modelId),
    input_tokens: fact.tokens.input ?? 0,
    output_tokens: fact.tokens.output ?? 0,
    reasoning_tokens: fact.tokens.reasoning ?? 0,
    cache_read_tokens: fact.tokens.cache.read ?? 0,
    cache_write_tokens: fact.tokens.cache.write ?? 0,
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
    const modelRows = modelRowsByGroup.get(row.value) ?? []
    const priced = await priceCentralBreakdown(
      modelRows.length > 0 ? modelRows : input.dimension === "model" ? [{ ...row }] : [],
    )
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

function revisionKey(value: Pick<TurnUsageRevision, "hostId" | "sessionRef" | "messageId" | "revision">) {
  return `${value.hostId}\u0000${value.sessionRef}\u0000${value.messageId}\u0000${value.revision}`
}

/** One published central revision, or nothing when the row is not a well-formed fact. */
function centralUsageFact(row: CentralUsageRow): TurnUsageRevision | undefined {
  const sessionRef = row.session_ref
  const sessionId = row.session_id
  const messageId = row.message_id
  const harness = row.harness
  const providerId = row.provider_id
  const modelId = row.model_id
  if (
    !isNonEmptyString(sessionRef) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(messageId) ||
    !isNonEmptyString(harness) ||
    !isNonEmptyString(providerId) ||
    !isNonEmptyString(modelId)
  )
    return undefined
  const revision = Number(row.revision)
  const observedAt = Number(row.observed_at)
  const settlement = row.settlement
  const status = row.status
  const location = row.location
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isFinite(observedAt) ||
    !isOneOf(settlement, TURN_USAGE_SETTLEMENTS) ||
    !isOneOf(status, TURN_USAGE_STATUSES) ||
    !isOneOf(location, TURN_USAGE_LOCATIONS)
  )
    return undefined
  const token = (name: string) => {
    const raw = row[name]
    if (raw === null || raw === undefined) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : Number.NaN
  }
  const tokens = {
    input: token("input_tokens"),
    output: token("output_tokens"),
    reasoning: token("reasoning_tokens"),
    cache: { read: token("cache_read_tokens"), write: token("cache_write_tokens") },
  }
  if (
    [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].some(
      (value) => value !== null && !Number.isFinite(value),
    )
  )
    return undefined
  return {
    hostId: isNonEmptyString(row.host_id) ? row.host_id : "central",
    sessionRef,
    sessionId,
    messageId,
    revision,
    observedAt,
    ...(typeof row.completed_at === "number" ? { completedAt: row.completed_at } : {}),
    settlement,
    status,
    location,
    harness,
    providerId,
    modelId,
    ...(typeof row.native_session_id === "string" ? { nativeSessionId: row.native_session_id } : {}),
    ...(typeof row.workspace_id === "string" ? { workspaceId: row.workspace_id } : {}),
    tokens,
    quality: { source: "provider", knownCategories: knownTokenCategories(tokens) },
  }
}

function centralUsageFacts(projection: CentralUsageProjection | undefined): {
  available: boolean
  facts: TurnUsageRevision[]
} {
  const rows = projection?.facts
  if (!rows) return { available: false, facts: [] }
  return { available: true, facts: rows.flatMap((row) => centralUsageFact(row) ?? []) }
}

export function UsageRoutes(input: {
  ledger: UsageLedger
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  telemetry?: UsageTelemetry
}) {
  const app = new Hono()
  // Hosted callers share the desktop lifecycle wake used by local outboxes,
  // but the central authority has no outbox of its own: accepted revisions are
  // already in `ledger`. Authenticate the tenant exactly like the dashboard
  // read and report that authoritative empty state instead of leaving the
  // declared hosted operation as a 404.
  app.post("/sync", async (c) => {
    try {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        config: input.authConfig,
        verifier: input.verifier,
      })
      if (auth.mode !== "signed" || !auth.user.orgId) {
        return c.json({ error: "signed_org_required", message: "A signed organization session is required" }, 401)
      }
      return c.json({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
  })
  app.get("/", async (c) => {
    const startedAt = Date.now()
    try {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        config: input.authConfig,
        verifier: input.verifier,
      })
      if (auth.mode !== "signed" || !auth.user.orgId) {
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
      const identity = { org_id: auth.user.orgId, user_id: auth.user.subject }
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
          sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
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
        ? await priceCentralProjection(input.ledger, identity, { since, until }, summary)
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
        sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
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
        dimension: group,
        rows,
        modelRows,
        metric,
        ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      })
      const modelBreakdown = await canonicalBreakdownPage({
        dimension: "model",
        rows: mergeBreakdownRows(includeClaxedo ? summary.models : []),
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
  central: CentralUsageProjection | undefined
  centralFactsAvailable: boolean
  localFacts: TurnUsageRevision[]
  totalRows: ExternalUsageBucket[]
  claxedoSeries: UsageSeries
  includeClaxedo: boolean
  group: UsageFilterDimension | undefined
  view: "quota" | "claxedo" | "total"
  metric: "tokens" | "cost"
  timeZone: string
  requestedLimit: number | undefined
  after: string | undefined
  modelAfter: string | undefined
}) {
  const {
    central,
    centralFactsAvailable,
    localFacts,
    totalRows,
    claxedoSeries,
    includeClaxedo,
    group,
    view,
    metric,
    timeZone,
    requestedLimit,
    after,
    modelAfter,
  } = input
  const aggregateCentralSource = centralFactsAvailable ? undefined : central
  let breakdown: Awaited<ReturnType<typeof canonicalBreakdownPage>> | undefined
  let modelBreakdown: Awaited<ReturnType<typeof canonicalBreakdownPage>> | undefined
  if (group) {
    const dimension = group === "app" ? undefined : group
    const localHistoryBreakdownRows =
      view === "total"
        ? totalRows.map((row) => ({
            value: externalUsageDimension(row, group),
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
        : []
    const rows =
      view === "total"
        ? mergeBreakdownRows(localHistoryBreakdownRows)
        : group === "app"
          ? mergeBreakdownRows(includeClaxedo ? [appBreakdownRow(claxedoSeries)] : [])
          : mergeBreakdownRows(
              includeClaxedo ? aggregateCentralSource?.breakdown : [],
              includeClaxedo && dimension ? groupUsageFacts(localFacts, dimension) : [],
            )
    const centralModelRows =
      group === "app"
        ? (aggregateCentralSource?.models ?? []).map((row) => ({ ...row, group: "Claxedo" }))
        : (aggregateCentralSource?.breakdownModels ?? [])
    const localModelRows =
      group === "app"
        ? localFacts.map((fact) => ({
            group: "Claxedo",
            value: usageModelKey(fact.providerId, fact.modelId),
            input_tokens: fact.tokens.input ?? 0,
            output_tokens: fact.tokens.output ?? 0,
            reasoning_tokens: fact.tokens.reasoning ?? 0,
            cache_read_tokens: fact.tokens.cache.read ?? 0,
            cache_write_tokens: fact.tokens.cache.write ?? 0,
          }))
        : dimension
          ? modelBreakdownFromFacts(localFacts, dimension)
          : []
    const localHistoryModelRows =
      view === "total"
        ? totalRows.map((row) => ({
            group: externalUsageDimension(row, group),
            value: usageModelKey(row.provider, row.model),
            input_tokens: row.tokens.input ?? 0,
            output_tokens: row.tokens.output ?? 0,
            reasoning_tokens: row.tokens.reasoning ?? 0,
            cache_read_tokens: row.tokens.cacheRead ?? 0,
            cache_write_tokens: row.tokens.cacheWrite ?? 0,
          }))
        : []
    breakdown = await canonicalBreakdownPage({
      dimension: group,
      rows,
      modelRows: view === "total" ? localHistoryModelRows : [...centralModelRows, ...localModelRows],
      metric,
      ...(after ? { after: after } : {}),
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
    })
    const localHistoryModels =
      view === "total"
        ? totalRows.map((row) => ({
            value: usageModelKey(row.provider, row.model),
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
        : []
    modelBreakdown = await canonicalBreakdownPage({
      dimension: "model",
      rows:
        view === "total"
          ? mergeBreakdownRows(localHistoryModels)
          : mergeBreakdownRows(
              includeClaxedo ? aggregateCentralSource?.models : [],
              includeClaxedo ? groupUsageFacts(localFacts, "model") : [],
            ),
      metric,
      ...(modelAfter ? { after: modelAfter } : {}),
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
    })
  }
  const chart = group
    ? view === "total"
      ? mergeChartSeries(
          group,
          group === "app" || group === "provider" || group === "model" || group === "location"
            ? chartRowsFromExternal(totalRows, group, timeZone)
            : [],
        )
      : mergeChartSeries(
          group,
          group === "app"
            ? includeClaxedo
              ? chartRowsFromSeries("Claxedo", claxedoSeries)
              : []
            : includeClaxedo
              ? aggregateCentralSource?.dailyBreakdown
              : [],
          group !== "app" && includeClaxedo ? chartRowsFromFacts(localFacts, group, timeZone) : [],
        )
    : undefined
  return { breakdown, modelBreakdown, chart }
}

export function LocalUsageRoutes(input: {
  local: UsageRevisionReader
  central?: UsageLedger
  outbox: Pick<UsageOutboxSync, "flush" | "clearIdentity">
  identity(request: Request): Promise<{ org_id: string; user_id: string } | undefined>
  /**
   * Plan usage for the quota view. Takes the request because the tenant it
   * answers for is the credential registry's, which only the composition that
   * mounted the credential routes can resolve the same way they do.
   */
  quota?: (input: { request: Request; refresh: boolean }) => Promise<UnifiedUsageResponse["quota"]>
  history?: (range: { since: number; until: number; refresh: boolean }) => Promise<LocalHistorySnapshot>
  telemetry?: UsageTelemetry
}) {
  // Precommitted above the 35s representative cold-scan budget. Warm and
  // changed-file refreshes are expected to stay below 5s; the extra margin is
  // for a first scan competing with desktop startup I/O.
  const LOCAL_HISTORY_DEADLINE_MS = 40_000
  const app = new Hono()
  const centralCache = new Map<string, CentralUsageProjection>()
  const historyCache = new Map<string, LocalHistorySnapshot>()
  const consumedRefreshNonces = new Set<number>()
  const deadline = <T>(promise: Promise<T>, label: string, timeoutMs = 8_000) =>
    withTimeout(promise, timeoutMs, () => new Error(`${label} timed out`))
  const rememberCentral = (key: string, value: CentralUsageProjection) => {
    centralCache.delete(key)
    centralCache.set(key, value)
    while (centralCache.size > 32) centralCache.delete(centralCache.keys().next().value!)
  }
  const rememberHistory = (key: string, value: LocalHistorySnapshot) => {
    historyCache.delete(key)
    historyCache.set(key, value)
    while (historyCache.size > 8) historyCache.delete(historyCache.keys().next().value!)
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
  app.post("/sync", async (c) => {
    let identity: Awaited<ReturnType<typeof input.identity>>
    try {
      identity = await input.identity(c.req.raw)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
    // This endpoint is a lifecycle wakeup, so anonymous desktop windows are a
    // valid caller. They must never upload; clearing any previous tenant
    // binding is the authoritative unsigned transition and reports the local
    // pending count without producing a noisy authentication failure.
    const result = identity ? await input.outbox.flush(identity) : await input.outbox.clearIdentity()
    return c.json({
      attempted: result.attempted,
      delivered: result.delivered,
      conflicts: result.conflicts,
      pending: result.pending,
    })
  })
  app.get("/", async (c) => {
    const startedAt = Date.now()
    const parsed = parseUsageQuery((name) => c.req.query(name))
    if (parsed.error) return c.json({ error: parsed.error }, 400)
    const { since, until, timeZone, group, metric, requestedLimit, view } = parsed.value
    const filters = filtersFromQuery((name) => c.req.query(name))
    const refresh = consumeRefreshNonce(c.req.query("refresh_nonce"))
    if (refresh === undefined) return c.json({ error: "invalid_refresh_nonce" }, 400)
    if (view === "quota") {
      const quota: UnifiedUsageResponse["quota"] = input.quota
        ? await deadline(input.quota({ request: c.req.raw, refresh }), "quota read").catch((error: unknown) => ({
            status: "unavailable" as const,
            error: error instanceof Error ? error.message : String(error),
          }))
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
        sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
      }
      captureUsage(input.telemetry, {
        deployment: "local",
        rangeDays: Math.ceil((until - since) / 86_400_000),
        latencyMs: Date.now() - startedAt,
        claxedoStatus: response.claxedo.status,
        externalStatus: response.externalLocal.status,
        quotaStatus: response.quota.status,
        outboxPending: 0,
        ingestDelivered: 0,
        ingestConflicts: 0,
        scannerDegraded: 0,
        unclassified: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
      })
      return c.json(response)
    }
    const historyTask =
      view === "total" && input.history
        ? deadline(input.history({ since, until, refresh }), "local usage scan", LOCAL_HISTORY_DEADLINE_MS)
            .then((value) => ({ value }))
            .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        : Promise.resolve({
            value: {
              rows: [],
              totalRows: [],
              coverage: [],
              classifiedClaxedo: 0,
              unclassified: 0,
            } as LocalHistorySnapshot,
          })
    let identity: Awaited<ReturnType<typeof input.identity>>
    try {
      identity = await input.identity(c.req.raw)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
    const syncResult = await (identity ? input.outbox.flush(identity) : input.outbox.clearIdentity()).catch(() => ({
      attempted: 0,
      delivered: 0,
      conflicts: 0,
      pending: -1,
      acknowledged: undefined,
    }))
    const acknowledged = new Set(syncResult.acknowledged?.map(revisionKey) ?? [])
    const sync = {
      attempted: syncResult.attempted,
      delivered: syncResult.delivered,
      conflicts: syncResult.conflicts,
      pending: syncResult.pending,
    }

    let central: CentralUsageProjection | undefined
    let centralError: string | undefined
    if (identity && input.central?.usageDashboard) {
      const dimension = group && group !== "app" ? group : undefined
      const centralFilters = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "app"))
      const centralKey = JSON.stringify([
        identity.org_id,
        identity.user_id,
        since,
        until,
        timeZone,
        dimension,
        centralFilters,
      ])
      try {
        const payload = jsonRecord(
          await deadline(
            input.central.usageDashboard({
              ...identity,
              since,
              until,
              timeZone,
              ...(dimension ? { dimension } : {}),
              ...(Object.keys(centralFilters).length ? { filters: centralFilters } : {}),
            }),
            "central usage",
          ),
        )
        // A control plane that answers without an object body counts as no
        // central data at all, exactly like an unreachable one: the response
        // stays local-scoped rather than claiming an empty cross-machine total.
        central = payload && readCentralUsage(payload)
        if (central) rememberCentral(centralKey, central)
      } catch (error) {
        centralError = error instanceof Error ? error.message : String(error)
        central = centralCache.get(centralKey)
      }
    }
    const allLocalFacts = latestUsageFacts(
      (central
        ? await input.local.pendingOutbox({ since, until, all: true })
        : await input.local.current({ since, until })
      ).filter((fact) => !central || !acknowledged.has(revisionKey(fact))),
    )
    const centralFactProjection = centralUsageFacts(central)
    // When the central projection carries its bounded source facts, compose at
    // the revision boundary. This lets a newer pending local revision replace
    // its older central revision instead of adding both snapshots together.
    // Older servers omit `facts`; keep their aggregate composition compatible.
    const allClaxedoFacts = centralFactProjection.available
      ? latestUsageFacts([...centralFactProjection.facts, ...allLocalFacts])
      : allLocalFacts
    const includeClaxedo = !filters.app || filters.app.toLowerCase() === "claxedo"
    const localFacts = includeClaxedo ? allClaxedoFacts.filter((fact) => usageFactMatches(fact, filters)) : []
    const localSeries = usageSeriesFromFacts({ facts: localFacts, since, until, timeZone })
    const centralSeries =
      central && includeClaxedo
        ? centralProjectionSeries(central)
        : usageSeriesFromFacts({ facts: [], since, until, timeZone })
    const claxedoSeries = centralFactProjection.available
      ? localSeries
      : central
        ? mergeUsageSeries(centralSeries, localSeries)
        : localSeries
    const localCost = await priceFacts(localFacts, timeZone)
    let centralCost = emptyCost()
    if (!centralFactProjection.available && central && includeClaxedo && identity && input.central) {
      try {
        centralCost = await priceCentralProjection(input.central, identity, { since, until }, central)
      } catch {
        /* cost coverage remains explicit and does not drop token totals */
      }
    }
    const claxedoCost = mergeCost(centralCost, localCost)

    const historyResult = await historyTask
    // A local-history snapshot is bounded by the exact requested instants.
    // Reusing a same-length but shifted window can leak rows from outside the
    // request after a scanner failure.
    const historyKey = JSON.stringify([since, until, timeZone])
    if ("value" in historyResult) rememberHistory(historyKey, historyResult.value)
    const history =
      "value" in historyResult
        ? historyResult.value
        : (historyCache.get(historyKey) ?? {
            rows: [],
            totalRows: [],
            coverage: [],
            classifiedClaxedo: 0,
            unclassified: 0,
          })
    const historyError = "error" in historyResult ? historyResult.error : undefined
    // Keep the range boundary authoritative even for cached or future scanner
    // implementations; every downstream total, price, chart and option uses
    // this same bounded collection.
    const historyRows = history.rows.filter((row) => row.bucketStart >= since && row.bucketStart <= until)
    const externalRows = historyRows.filter((row) => externalMatches(row, filters))
    const totalRows = history.totalRows
      .filter((row) => row.bucketStart >= since && row.bucketStart <= until)
      .filter((row) => externalMatches(row, filters))
    const externalSeries = usageSeriesFromExternal({ rows: externalRows, since, until, timeZone })
    const externalCost = await priceExternal(externalRows, timeZone)
    const totalSeries = usageSeriesFromExternal({ rows: totalRows, since, until, timeZone })
    const totalCost = await priceExternal(totalRows, timeZone)
    const { breakdown, modelBreakdown, chart } = await localUsageBreakdowns({
      central, centralFactsAvailable: centralFactProjection.available, localFacts, totalRows,
      claxedoSeries, includeClaxedo, group, view, metric, timeZone, requestedLimit,
      after: c.req.query("after"), modelAfter: c.req.query("model_after"),
    })
    const response: UnifiedUsageResponse = {
      version: 1,
      range: { since, until, timeZone },
      quota: { status: "unavailable" },
      claxedo: {
        ...claxedoSeries,
        cost: claxedoCost,
        locationShare: locationShare(
          includeClaxedo && !centralFactProjection.available
            ? central?.locations
            : [],
          includeClaxedo ? groupUsageFacts(localFacts, "location") : [],
        ),
        status: centralError ? "stale" : "available",
        scope: central ? "cross-machine" : "local",
        ...(centralError ? { error: centralError } : {}),
      },
      externalLocal: {
        ...externalSeries,
        cost: externalCost,
        status: historyError ? "degraded" : view === "total" && input.history ? "available" : "unavailable",
        coverage: history.coverage,
        unclassified: history.unclassified,
        ...(historyError ? { error: historyError } : {}),
      },
      total: totalSeries,
      totalCost,
      filterOptions: {
        claxedo: mergeFilterOptions(
          central?.filters,
          usageFactFilterOptions(allClaxedoFacts),
        ),
        total: externalFilterOptions(history.totalRows),
      },
      sync,
      ...(breakdown ? { breakdown } : {}),
      ...(modelBreakdown ? { modelBreakdown } : {}),
      ...(chart ? { chart } : {}),
    }
    captureUsage(input.telemetry, {
      deployment: "local",
      rangeDays: Math.ceil((until - since) / 86_400_000),
      latencyMs: Date.now() - startedAt,
      claxedoStatus: response.claxedo.status,
      externalStatus: response.externalLocal.status,
      quotaStatus: response.quota.status,
      outboxPending: response.sync.pending,
      ingestDelivered: response.sync.delivered,
      ingestConflicts: response.sync.conflicts,
      scannerDegraded: response.externalLocal.coverage.filter((source) => source.status !== "available").length,
      unclassified: response.externalLocal.unclassified,
      pricedTokens: response.totalCost.pricedTokens,
      unpricedTokens: response.totalCost.unpricedTokens,
    })
    return c.json(response)
  })
  return app
}
