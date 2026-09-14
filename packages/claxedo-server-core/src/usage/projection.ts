import type { UsageFilterDimension, UsageFilters } from "@claxedo/usage-contract"
import { isJsonRecord } from "../platform/runtime/lib/json"
import type { TurnUsageRevision } from "./contracts"

// The browser-facing contract owns the dimension vocabulary; this module owns
// the server-side facts and the runtime lists that go with it.
export type { UsageFilterDimension, UsageFilters } from "@claxedo/usage-contract"

export type ExternalUsageBucket = {
  app: string
  provider: string
  model: string
  bucketStart: number
  nativeSessionId: string
  turnCount: number
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null }
}

/**
 * A dimension that a single usage revision carries. "app" is excluded: it
 * separates Claxedo's own turns from the other coding tools found on the
 * machine, so it is a property of the source, not of a revision.
 */
export type UsageBreakdownDimension = Exclude<UsageFilterDimension, "app">

/** Every dimension the usage routes accept, in menu order. */
export const USAGE_FILTER_DIMENSIONS = [
  "app",
  "provider",
  "harness",
  "model",
  "location",
  "session",
  "workspace",
] as const satisfies readonly UsageFilterDimension[]

/** The dimensions that can be derived from a revision. */
export const USAGE_BREAKDOWN_DIMENSIONS = [
  "provider",
  "harness",
  "model",
  "location",
  "session",
  "workspace",
] as const satisfies readonly UsageBreakdownDimension[]

/** Narrow a query-string value to a dimension the routes accept. */
export function isUsageFilterDimension(value: string): value is UsageFilterDimension {
  return USAGE_FILTER_DIMENSIONS.some((dimension) => dimension === value)
}

/** Narrow a dimension to the subset a revision can be grouped by. */
export function isUsageBreakdownDimension(value: string): value is UsageBreakdownDimension {
  return USAGE_BREAKDOWN_DIMENSIONS.some((dimension) => dimension === value)
}

export function usageLocation(value: TurnUsageRevision["location"]) {
  return value === "local" || value === "user-hosted" ? "local" : "cloud"
}

export function usageModelKey(provider: string, model: string) {
  return model.includes("/") ? model : `${provider}/${model}`
}

export function usageFactDimension(fact: TurnUsageRevision, dimension: UsageBreakdownDimension) {
  if (dimension === "provider") return fact.providerId
  if (dimension === "harness") return fact.harness
  if (dimension === "model") return usageModelKey(fact.providerId, fact.modelId)
  if (dimension === "location") return usageLocation(fact.location)
  if (dimension === "session") return fact.sessionRef
  return fact.workspaceId ?? "unavailable"
}

export function usageFactMatches(fact: TurnUsageRevision, filters: UsageFilters) {
  if (filters.app && filters.app.toLowerCase() !== "claxedo") return false
  return USAGE_BREAKDOWN_DIMENSIONS
    .every((dimension) => !filters[dimension] || usageFactDimension(fact, dimension) === filters[dimension])
}

export function usageFactFilterOptions(
  facts: readonly TurnUsageRevision[],
): Record<UsageBreakdownDimension, string[]> {
  const values = (dimension: UsageBreakdownDimension) =>
    [...new Set(facts.map((fact) => usageFactDimension(fact, dimension)))].toSorted()
  return {
    provider: values("provider"),
    harness: values("harness"),
    model: values("model"),
    location: values("location"),
    session: values("session"),
    workspace: values("workspace"),
  }
}

export type UsageMetricTotals = {
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

export type UsageDailyPoint = UsageMetricTotals & { date: string }

export type UsageSeries = {
  totals: UsageMetricTotals
  daily: UsageDailyPoint[]
}

export const emptyUsageTotals = (): UsageMetricTotals => ({
  turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0,
  partialTurnCount: 0, unavailableTurnCount: 0, errorTurnCount: 0,
})

export function usageDateFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
}

function add(target: UsageMetricTotals, value: UsageMetricTotals) {
  for (const field of ["turnCount", "input", "output", "reasoning", "cacheRead", "cacheWrite", "unknownCategories", "partialTurnCount", "unavailableTurnCount", "errorTurnCount"] as const) {
    target[field] += value[field]
  }
}

export function usageSeriesFromFacts(input: {
  facts: readonly TurnUsageRevision[]
  since: number
  until: number
  timeZone: string
}): UsageSeries {
  const totals = emptyUsageTotals()
  const daily = new Map<string, UsageMetricTotals>()
  const formatDate = usageDateFormatter(input.timeZone)
  for (const fact of latestUsageFacts(input.facts)) {
    if (fact.observedAt < input.since || fact.observedAt > input.until) continue
    const values = [fact.tokens.input, fact.tokens.output, fact.tokens.reasoning, fact.tokens.cache.read, fact.tokens.cache.write]
    const contribution: UsageMetricTotals = {
      turnCount: 1,
      input: fact.tokens.input ?? 0,
      output: fact.tokens.output ?? 0,
      reasoning: fact.tokens.reasoning ?? 0,
      cacheRead: fact.tokens.cache.read ?? 0,
      cacheWrite: fact.tokens.cache.write ?? 0,
      unknownCategories: values.filter((value) => value === null).length,
      partialTurnCount: fact.settlement === "partial" ? 1 : 0,
      unavailableTurnCount: fact.settlement === "unavailable" ? 1 : 0,
      errorTurnCount: fact.status === "error" ? 1 : 0,
    }
    add(totals, contribution)
    const key = formatDate.format(new Date(fact.observedAt))
    const point = daily.get(key) ?? emptyUsageTotals()
    add(point, contribution)
    daily.set(key, point)
  }
  return { totals, daily: [...daily].map(([key, value]) => ({ date: key, ...value })).toSorted((a, b) => a.date.localeCompare(b.date)) }
}

export function latestUsageFacts(facts: readonly TurnUsageRevision[]) {
  const latest = new Map<string, TurnUsageRevision>()
  for (const fact of facts) {
    const key = `${fact.hostId}\u0000${fact.sessionRef}\u0000${fact.messageId}`
    const existing = latest.get(key)
    if (!existing || fact.revision > existing.revision) latest.set(key, fact)
  }
  return [...latest.values()]
}

export function usageSeriesFromExternal(input: {
  rows: readonly ExternalUsageBucket[]
  since: number
  until: number
  timeZone: string
}): UsageSeries {
  const rows = input.rows.filter((row) => row.bucketStart >= input.since && row.bucketStart <= input.until)
  const facts = rows.map((row): TurnUsageRevision => ({
    hostId: "external-local",
    sessionRef: `external:${row.app}:${row.nativeSessionId}`,
    sessionId: row.nativeSessionId,
    // TokenTracker's authoritative bucket key includes model. A native session
    // can switch models inside one 30-minute bucket; omitting model here made
    // latestUsageFacts() treat those distinct rows as revisions of one turn,
    // so summary totals disagreed with chart and breakdown totals.
    messageId: `${row.model}:${row.bucketStart}`,
    revision: 1,
    observedAt: row.bucketStart,
    settlement: "final",
    status: "completed",
    location: "local",
    harness: row.app,
    providerId: row.provider,
    modelId: row.model,
    tokens: {
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cache: { read: row.tokens.cacheRead, write: row.tokens.cacheWrite },
    },
    quality: {
      source: "provider",
      knownCategories: [
        ...(row.tokens.input === null ? [] : ["input" as const]),
        ...(row.tokens.output === null ? [] : ["output" as const]),
        ...(row.tokens.reasoning === null ? [] : ["reasoning" as const]),
        ...(row.tokens.cacheRead === null ? [] : ["cache_read" as const]),
        ...(row.tokens.cacheWrite === null ? [] : ["cache_write" as const]),
      ],
    },
  }))
  const series = usageSeriesFromFacts({ ...input, facts })
  const dailyTurnCounts = new Map<string, number>()
  const formatDate = usageDateFormatter(input.timeZone)
  for (const row of rows) {
    const date = formatDate.format(new Date(row.bucketStart))
    dailyTurnCounts.set(date, (dailyTurnCounts.get(date) ?? 0) + row.turnCount)
  }
  series.totals.turnCount = rows.reduce((sum, row) => sum + row.turnCount, 0)
  for (const point of series.daily) point.turnCount = dailyTurnCounts.get(point.date) ?? 0
  return series
}

export function mergeUsageSeries(...series: readonly UsageSeries[]): UsageSeries {
  const totals = emptyUsageTotals()
  const days = new Map<string, UsageMetricTotals>()
  for (const item of series) {
    add(totals, item.totals)
    for (const point of item.daily) {
      const target = days.get(point.date) ?? emptyUsageTotals()
      add(target, point)
      days.set(point.date, target)
    }
  }
  return { totals, daily: [...days].map(([key, value]) => ({ date: key, ...value })).toSorted((a, b) => a.date.localeCompare(b.date)) }
}

export function centralProjectionSeries(source: CentralUsageProjection): UsageSeries {
  const map = (row: CentralUsageRow = {}): UsageMetricTotals => ({
    turnCount: rowNumber(row, "turn_count"),
    input: rowNumber(row, "input_tokens"),
    output: rowNumber(row, "output_tokens"),
    reasoning: rowNumber(row, "reasoning_tokens"),
    cacheRead: rowNumber(row, "cache_read_tokens"),
    cacheWrite: rowNumber(row, "cache_write_tokens"),
    unknownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"]
      .reduce((sum, name) => sum + rowNumber(row, "turn_count") - rowNumber(row, `${name}_known_count`), 0),
    partialTurnCount: rowNumber(row, "partial_turn_count"),
    unavailableTurnCount: rowNumber(row, "unavailable_turn_count"),
    errorTurnCount: rowNumber(row, "error_turn_count"),
  })
  return {
    totals: map(source.totals),
    // A daily point without a date keeps its long-standing "undefined" key so a
    // malformed payload still shows up as one visibly wrong bucket rather than
    // silently merging into a real day.
    daily: (source.daily ?? []).map((row) => ({ date: rowText(row, "date", "undefined"), ...map(row) })),
  }
}

export function groupUsageFacts(facts: readonly TurnUsageRevision[], dimension: UsageBreakdownDimension) {
  const grouped = new Map<string, UsageMetricTotals>()
  for (const fact of facts) {
    const value = usageFactDimension(fact, dimension)
    const row = grouped.get(value) ?? emptyUsageTotals()
    add(row, {
      turnCount: 1,
      input: fact.tokens.input ?? 0,
      output: fact.tokens.output ?? 0,
      reasoning: fact.tokens.reasoning ?? 0,
      cacheRead: fact.tokens.cache.read ?? 0,
      cacheWrite: fact.tokens.cache.write ?? 0,
      unknownCategories: [fact.tokens.input, fact.tokens.output, fact.tokens.reasoning, fact.tokens.cache.read, fact.tokens.cache.write]
        .filter((item) => item === null).length,
      partialTurnCount: fact.settlement === "partial" ? 1 : 0,
      unavailableTurnCount: fact.settlement === "unavailable" ? 1 : 0,
      errorTurnCount: fact.status === "error" ? 1 : 0,
    })
    grouped.set(value, row)
  }
  return [...grouped].map(([value, totals]) => ({ value, ...totals })).toSorted((a, b) => a.value.localeCompare(b.value))
}

/**
 * `UsageLedger.usageDashboard` and `UsageLedger.usageBreakdown` return the
 * remote control plane's JSON, so their declared type is `unknown`. This is the
 * one boundary it crosses: `readCentralUsage` turns that `unknown` into a typed
 * projection and the row accessors read the individual fields, so the payload's
 * shape is stated once and checked rather than re-described by an inline cast
 * at every consumer.
 *
 * It lives beside `centralProjectionSeries` because that is what consumes it:
 * the central payload's only job here is to become a `UsageSeries`.
 *
 * Rows stay `Record<string, unknown>` on purpose. Server versions differ on
 * spelling (`input` vs `input_tokens`), so a row is read field by field
 * through `rowNumber` / `rowText`, which take the candidate keys in order.
 */
/** One row of a control-plane usage payload, in whichever spelling that server used. */
export type CentralUsageRow = Record<string, unknown>

/** The fields of the control-plane usage payload this package reads. */
export type CentralUsageProjection = {
  /** Summary totals for the whole range. */
  totals?: CentralUsageRow
  /** Per-day summary totals. */
  daily?: CentralUsageRow[]
  /** Breakdown rows for the requested dimension. */
  breakdown?: CentralUsageRow[]
  /** Per-day breakdown rows for the requested dimension. */
  dailyBreakdown?: CentralUsageRow[]
  /** Model rows attributed to the requested dimension's groups. */
  breakdownModels?: CentralUsageRow[]
  /** Model rows for the whole range. */
  models?: CentralUsageRow[]
  /** Per-day model rows. */
  dailyModels?: CentralUsageRow[]
  /** Local/cloud split rows. */
  locations?: CentralUsageRow[]
  /**
   * The bounded source revisions behind the aggregate. Present only on servers
   * that publish them; it stays `undefined` otherwise, so a caller can tell
   * "no facts published" from "published, and empty".
   */
  facts?: CentralUsageRow[]
  /** Rows of a paged breakdown response. */
  rows?: CentralUsageRow[]
  /** Filter options the server can offer, by dimension. */
  filters?: Record<string, string[]>
  /** Cursor for the next page of a paged breakdown response. */
  next?: string
}

/** Every payload field that carries a list of rows. */
const ROW_FIELDS = [
  "daily",
  "breakdown",
  "dailyBreakdown",
  "breakdownModels",
  "models",
  "dailyModels",
  "locations",
  "facts",
  "rows",
] as const

function readRows(value: unknown): CentralUsageRow[] | undefined {
  return Array.isArray(value) ? value.filter(isJsonRecord) : undefined
}

function readFilterOptions(value: unknown): Record<string, string[]> | undefined {
  if (!isJsonRecord(value)) return undefined
  const options: Record<string, string[]> = {}
  for (const [dimension, entries] of Object.entries(value)) {
    if (Array.isArray(entries)) options[dimension] = entries.filter((entry) => typeof entry === "string")
  }
  return options
}

/** Parse a control-plane usage payload. A payload that is not an object reads as empty. */
export function readCentralUsage(value: unknown): CentralUsageProjection {
  if (!isJsonRecord(value)) return {}
  const projection: CentralUsageProjection = {}
  if (isJsonRecord(value.totals)) projection.totals = value.totals
  for (const field of ROW_FIELDS) {
    const rows = readRows(value[field])
    if (rows) projection[field] = rows
  }
  const filters = readFilterOptions(value.filters)
  if (filters) projection.filters = filters
  if (typeof value.next === "string") projection.next = value.next
  return projection
}

/**
 * Read a numeric field, taking the first key that is present.
 * A present-but-unparsable value stays `NaN` rather than falling through to the
 * next spelling, so a malformed payload does not look like a valid zero.
 */
export function rowNumber(row: CentralUsageRow, ...keys: string[]): number {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null) return Number(value)
  }
  return 0
}

/**
 * Read an identity field. Anything that is not a string, number or boolean —
 * an object, an array, a missing key — reads as `fallback`, which callers use
 * to drop the row. Stringifying an object here produced `"[object Object]"`
 * breakdown rows.
 */
export function rowText(row: CentralUsageRow, key: string, fallback = ""): string {
  const value = row[key]
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return fallback
}
