import { Hono } from "hono"
import type { UnifiedUsageResponse, UsageBreakdownRow, UsageFilterDimension } from "@claxedo/usage-contract"
export type { UnifiedUsageResponse } from "@claxedo/usage-contract"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../platform/auth/auth"
import type { SqliteUsageLedger } from "./adapters/sqlite-usage-ledger"
import type { UsageLedger } from "./ledger"
export type { UsageLedger } from "./ledger"
import { projectTokenTrackerCost, TOKEN_TRACKER_VERSION, type PricedUsage } from "./adapters/token-tracker-pricing"
import type { TurnUsageRevision } from "./contracts"
import {
  centralProjectionSeries,
  groupUsageFacts,
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
  type UsageFilters,
  type UsageSeries,
} from "./projection"
import { publicUsageHref } from "./public-href"

type ExternalUsageBucket = {
  app: string
  provider: string
  model: string
  bucketStart: number
  nativeSessionId: string
  turnCount: number
  tokens: {
    input: number | null
    output: number | null
    reasoning: number | null
    cacheRead: number | null
    cacheWrite: number | null
  }
}

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

const dimensions = new Set(["provider", "harness", "model", "location", "session", "workspace", "app"] as const)
const filterDimensions = [...dimensions]
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
  return Object.fromEntries(
    filterDimensions.flatMap((dimension) => {
      const value = query(`filter_${dimension}`)
      return value ? [[dimension, value]] : []
    }),
  )
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

async function priceCentralBreakdown(value: unknown) {
  const rows = (value as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []
  const total = emptyCost()
  for (const row of rows) {
    const [source, ...modelParts] = String(row.value ?? "").split("/")
    const model = modelParts.join("/")
    if (!source || !model) continue
    const item = await projectTokenTrackerCost({
      source,
      model,
      tokens: {
        input: Number(row.input_tokens ?? 0),
        output: Number(row.output_tokens ?? 0),
        reasoning: Number(row.reasoning_tokens ?? 0),
        cacheRead: Number(row.cache_read_tokens ?? 0),
        cacheWrite: Number(row.cache_write_tokens ?? 0),
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
    const page = await ledger.usageBreakdown({
      ...identity,
      ...range,
      dimension: "model",
      limit: 100,
      ...(after ? { after } : {}),
    })
    const priced = await priceCentralBreakdown(page)
    total.estimatedUsd += priced.estimatedUsd
    total.pricedTokens += priced.pricedTokens
    total.unpricedTokens += priced.unpricedTokens
    total.catalog = priced.catalog
    const next = (page as { next?: unknown } | null)?.next
    if (typeof next === "string" && next.length > 0) {
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
  projection: unknown,
) {
  const source = projection as { models?: unknown; dailyModels?: unknown } | null
  const models = source?.models
  if (Array.isArray(models)) {
    const total = await priceCentralBreakdown({ rows: models })
    const daily = new Map<string, PricedUsage>()
    const dailyModels = Array.isArray(source?.dailyModels) ? (source.dailyModels as Array<Record<string, unknown>>) : []
    for (const row of dailyModels) {
      const date = String(row.date ?? "")
      if (!date) continue
      const item = await priceCentralBreakdown({ rows: [row] })
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

function chartRow(raw: Record<string, unknown>): UsageChartRow | undefined {
  const date = String(raw.date ?? "")
  const value = String(raw.value ?? "")
  if (!date || !value) return
  return {
    date,
    value,
    input: Number(raw.input ?? raw.input_tokens ?? 0),
    output: Number(raw.output ?? raw.output_tokens ?? 0),
    reasoning: Number(raw.reasoning ?? raw.reasoning_tokens ?? 0),
    cacheRead: Number(raw.cacheRead ?? raw.cache_read_tokens ?? 0),
    cacheWrite: Number(raw.cacheWrite ?? raw.cache_write_tokens ?? 0),
  }
}

function mergeChartSeries(dimension: string, ...sources: unknown[]) {
  const rows = new Map<string, UsageChartRow>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      if (!raw || typeof raw !== "object") continue
      const next = chartRow(raw as Record<string, unknown>)
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
  dimension: "provider" | "harness" | "model" | "location" | "session" | "workspace",
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

function chartRowsFromExternal(
  rows: LocalHistorySnapshot["rows"],
  dimension: "app" | "provider" | "model" | "location",
  timeZone: string,
) {
  const formatDate = usageDateFormatter(timeZone)
  return rows.map((row) => ({
    date: formatDate.format(new Date(row.bucketStart)),
    value:
      dimension === "app"
        ? row.app
        : dimension === "provider"
          ? row.provider
          : dimension === "model"
            ? usageModelKey(row.provider, row.model)
            : "local",
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

function canonicalTotals(row: Record<string, unknown>): CanonicalBreakdownTotals {
  return {
    value: String(row.value ?? "unavailable"),
    turnCount: Number(row.turnCount ?? row.turn_count ?? 0),
    input: Number(row.input ?? row.input_tokens ?? 0),
    output: Number(row.output ?? row.output_tokens ?? 0),
    reasoning: Number(row.reasoning ?? row.reasoning_tokens ?? 0),
    cacheRead: Number(row.cacheRead ?? row.cache_read_tokens ?? 0),
    cacheWrite: Number(row.cacheWrite ?? row.cache_write_tokens ?? 0),
    unknownCategories: Number(row.unknownCategories ?? row.unknown_token_count ?? 0),
    partialTurnCount: Number(row.partialTurnCount ?? row.partial_turn_count ?? 0),
    unavailableTurnCount: Number(row.unavailableTurnCount ?? row.unavailable_turn_count ?? 0),
    errorTurnCount: Number(row.errorTurnCount ?? row.error_turn_count ?? 0),
  }
}

function mergeBreakdownRows(...sources: unknown[]) {
  const merged = new Map<string, CanonicalBreakdownTotals>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      if (!raw || typeof raw !== "object") continue
      const row = canonicalTotals(raw as Record<string, unknown>)
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

function modelBreakdownFromFacts(
  facts: readonly TurnUsageRevision[],
  dimension: "provider" | "harness" | "model" | "location" | "session" | "workspace",
) {
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
  modelRows?: Array<Record<string, unknown>>
  metric: "tokens" | "cost"
  after?: string
  limit?: number
}) {
  const limit = input.limit ?? 25
  const modelRowsByGroup = new Map<string, Array<Record<string, unknown>>>()
  for (const modelRow of input.modelRows ?? []) {
    const group = String(modelRow.group ?? "")
    const rows = modelRowsByGroup.get(group) ?? []
    rows.push(modelRow)
    modelRowsByGroup.set(group, rows)
  }
  const priceRow = async (row: CanonicalBreakdownTotals) => {
    const modelRows = modelRowsByGroup.get(row.value) ?? []
    const priced = await priceCentralBreakdown({
      rows: modelRows.length > 0 ? modelRows : input.dimension === "model" ? [{ ...row, value: row.value }] : [],
    })
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

function locationShare(...sources: unknown[]) {
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

function centralUsageFacts(value: unknown): { available: boolean; facts: TurnUsageRevision[] } {
  const rows = (value as { facts?: unknown } | null)?.facts
  if (!Array.isArray(rows)) return { available: false, facts: [] }
  const settlements = new Set<TurnUsageRevision["settlement"]>([
    "provisional",
    "final",
    "partial",
    "unavailable",
    "recovered",
  ])
  const statuses = new Set<TurnUsageRevision["status"]>([
    "running",
    "completed",
    "error",
    "stopped",
    "interrupted_by_steer",
    "process_lost",
  ])
  const locations = new Set<TurnUsageRevision["location"]>(["local", "central", "cloud-workspace", "user-hosted"])
  const facts = rows.flatMap((raw): TurnUsageRevision[] => {
    if (!raw || typeof raw !== "object") return []
    const row = raw as Record<string, unknown>
    const required = [row.session_ref, row.session_id, row.message_id, row.harness, row.provider_id, row.model_id]
    if (required.some((item) => typeof item !== "string" || item.length === 0)) return []
    const revision = Number(row.revision)
    const observedAt = Number(row.observed_at)
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isFinite(observedAt) ||
      !settlements.has(row.settlement as TurnUsageRevision["settlement"]) ||
      !statuses.has(row.status as TurnUsageRevision["status"]) ||
      !locations.has(row.location as TurnUsageRevision["location"])
    )
      return []
    const token = (name: string) => {
      if (row[name] === null || row[name] === undefined) return null
      const value = Number(row[name])
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
        (value) => typeof value === "number" && !Number.isFinite(value),
      )
    )
      return []
    const knownCategories = [
      ...(tokens.input === null ? [] : ["input" as const]),
      ...(tokens.output === null ? [] : ["output" as const]),
      ...(tokens.reasoning === null ? [] : ["reasoning" as const]),
      ...(tokens.cache.read === null ? [] : ["cache_read" as const]),
      ...(tokens.cache.write === null ? [] : ["cache_write" as const]),
    ]
    return [
      {
        hostId: typeof row.host_id === "string" && row.host_id ? row.host_id : "central",
        sessionRef: row.session_ref as string,
        sessionId: row.session_id as string,
        messageId: row.message_id as string,
        revision,
        observedAt,
        ...(typeof row.completed_at === "number" ? { completedAt: row.completed_at } : {}),
        settlement: row.settlement as TurnUsageRevision["settlement"],
        status: row.status as TurnUsageRevision["status"],
        location: row.location as TurnUsageRevision["location"],
        harness: row.harness as string,
        providerId: row.provider_id as string,
        modelId: row.model_id as string,
        ...(typeof row.native_session_id === "string" ? { nativeSessionId: row.native_session_id } : {}),
        ...(typeof row.workspace_id === "string" ? { workspaceId: row.workspace_id } : {}),
        tokens,
        quality: { source: "provider", knownCategories },
      },
    ]
  })
  return { available: true, facts }
}

export function UsageRoutes(input: {
  ledger: UsageLedger
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
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
      const since = Number(c.req.query("since"))
      const until = Number(c.req.query("until"))
      const timeZone = c.req.query("timezone") || "UTC"
      if (!validRange(since, until)) {
        return c.json(
          { error: "invalid_usage_range", message: "since and until must define a range of at most 90 days" },
          400,
        )
      }
      if (!validTimeZone(timeZone)) return c.json({ error: "invalid_timezone" }, 400)
      const group = c.req.query("group")
      if (group && !dimensions.has(group as never)) {
        return c.json({ error: "invalid_usage_group", message: "group is invalid" }, 400)
      }
      const metric = c.req.query("metric") || "tokens"
      if (metric !== "tokens" && metric !== "cost") return c.json({ error: "invalid_usage_metric" }, 400)
      const requestedLimit = c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit"))
      if (
        requestedLimit !== undefined &&
        (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
      ) {
        return c.json({ error: "invalid_usage_limit", message: "limit must be between 1 and 100" }, 400)
      }
      const identity = { org_id: auth.user.orgId, user_id: auth.user.subject }
      const view = c.req.query("view") || "claxedo"
      if (view !== "quota" && view !== "claxedo" && view !== "total")
        return c.json({ error: "invalid_usage_view" }, 400)
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
      const dimension =
        group && group !== "app"
          ? (group as "provider" | "harness" | "model" | "location" | "session" | "workspace")
          : undefined
      const centralFilters = Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "app"))
      const includeClaxedo = !filters.app || filters.app.toLowerCase() === "claxedo"
      const summary = await input.ledger.usageDashboard({
        ...identity,
        since,
        until,
        timeZone,
        ...(dimension ? { dimension } : {}),
        ...(Object.keys(centralFilters).length ? { filters: centralFilters } : {}),
      })
      const claxedo = includeClaxedo
        ? centralProjectionSeries(summary)
        : usageSeriesFromFacts({ facts: [], since, until, timeZone })
      const claxedoCost = includeClaxedo
        ? await priceCentralProjection(input.ledger, identity, { since, until }, summary)
        : emptyCost()
      const summarySource = summary as {
        breakdown?: unknown
        breakdownModels?: Array<Record<string, unknown>>
        models?: Array<Record<string, unknown>>
        dailyBreakdown?: unknown
      }
      const chart = group
        ? mergeChartSeries(
            group,
            group === "app"
              ? includeClaxedo
                ? chartRowsFromSeries("Claxedo", claxedo)
                : []
              : includeClaxedo
                ? summarySource.dailyBreakdown
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
          locationShare: locationShare(includeClaxedo ? (summary as { locations?: unknown } | null)?.locations : []),
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
          claxedo: (summary as { filters?: Record<string, string[]> } | null)?.filters ?? {},
          total: mergeFilterOptions(
            { app: ["Claxedo"] },
            (summary as { filters?: Record<string, string[]> } | null)?.filters,
          ),
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
          : mergeBreakdownRows(includeClaxedo ? summarySource.breakdown : [])
      const modelRows =
        group === "app"
          ? (includeClaxedo ? (summarySource.models ?? []) : []).map((row) => ({ ...row, group: "Claxedo" }))
          : includeClaxedo
            ? summarySource.breakdownModels
            : []
      const breakdown = await canonicalBreakdownPage({
        dimension: group as UsageFilterDimension,
        rows,
        modelRows,
        metric,
        ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      })
      const modelBreakdown = await canonicalBreakdownPage({
        dimension: "model",
        rows: mergeBreakdownRows(includeClaxedo ? summarySource.models : []),
        metric,
        ...(c.req.query("model_after") ? { after: c.req.query("model_after") } : {}),
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      })
      captureRequest()
      return c.json({ ...base, breakdown, modelBreakdown })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status as 400 | 401 | 403)
      }
      throw error
    }
  })
  return app
}

export function LocalUsageRoutes(input: {
  local: SqliteUsageLedger
  central?: UsageLedger
  outbox: Pick<UsageOutboxSync, "flush" | "clearIdentity">
  identity(request: Request): Promise<{ org_id: string; user_id: string } | undefined>
  quota?: (refresh: boolean) => Promise<unknown>
  history?: (range: { since: number; until: number; refresh: boolean }) => Promise<LocalHistorySnapshot>
  telemetry?: UsageTelemetry
}) {
  // Precommitted above the 35s representative cold-scan budget. Warm and
  // changed-file refreshes are expected to stay below 5s; the extra margin is
  // for a first scan competing with desktop startup I/O.
  const LOCAL_HISTORY_DEADLINE_MS = 40_000
  const app = new Hono()
  const centralCache = new Map<string, unknown>()
  const historyCache = new Map<string, LocalHistorySnapshot>()
  const consumedRefreshNonces = new Set<number>()
  let lastQuotaSnapshot: unknown
  const deadline = <T>(promise: Promise<T>, label: string, timeoutMs = 8_000) =>
    withTimeout(promise, timeoutMs, () => new Error(`${label} timed out`))
  const rememberCentral = (key: string, value: unknown) => {
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
    if (!Number.isSafeInteger(nonce) || nonce <= 0) return
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
    const since = Number(c.req.query("since"))
    const until = Number(c.req.query("until"))
    const timeZone = c.req.query("timezone") || "UTC"
    if (!validRange(since, until)) {
      return c.json({ error: "invalid_usage_range" }, 400)
    }
    if (!validTimeZone(timeZone)) return c.json({ error: "invalid_timezone" }, 400)
    const group = c.req.query("group")
    if (group && !dimensions.has(group as never)) return c.json({ error: "invalid_usage_group" }, 400)
    const metric = c.req.query("metric") || "tokens"
    if (metric !== "tokens" && metric !== "cost") return c.json({ error: "invalid_usage_metric" }, 400)
    const requestedLimit = c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit"))
    if (
      requestedLimit !== undefined &&
      (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
    ) {
      return c.json({ error: "invalid_usage_limit" }, 400)
    }
    const view = c.req.query("view") || "claxedo"
    if (view !== "quota" && view !== "claxedo" && view !== "total") return c.json({ error: "invalid_usage_view" }, 400)
    const filters = filtersFromQuery((name) => c.req.query(name))
    const refresh = consumeRefreshNonce(c.req.query("refresh_nonce"))
    if (refresh === undefined) return c.json({ error: "invalid_refresh_nonce" }, 400)
    if (view === "quota") {
      const result = input.quota
        ? await deadline(input.quota(refresh), "quota probe")
            .then((snapshot) => ({ snapshot }))
            .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        : { unavailable: true as const }
      if ("snapshot" in result) lastQuotaSnapshot = result.snapshot
      const quota: UnifiedUsageResponse["quota"] =
        "snapshot" in result
          ? { status: "available", snapshot: result.snapshot }
          : "error" in result
            ? {
                status: "degraded",
                ...(lastQuotaSnapshot === undefined ? {} : { snapshot: lastQuotaSnapshot }),
                error: result.error,
              }
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

    let central: unknown
    let centralError: string | undefined
    if (identity && input.central?.usageDashboard) {
      const dimension =
        group && group !== "app"
          ? (group as "provider" | "harness" | "model" | "location" | "session" | "workspace")
          : undefined
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
        central = await deadline(
          input.central.usageDashboard({
            ...identity,
            since,
            until,
            timeZone,
            ...(dimension ? { dimension } : {}),
            ...(Object.keys(centralFilters).length ? { filters: centralFilters } : {}),
          }),
          "central usage",
        )
        rememberCentral(centralKey, central)
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
    const centralSource = central as
      | {
          breakdown?: unknown
          breakdownModels?: Array<Record<string, unknown>>
          models?: Array<Record<string, unknown>>
          dailyBreakdown?: unknown
        }
      | undefined
    const aggregateCentralSource = centralFactProjection.available ? undefined : centralSource
    let breakdown: Awaited<ReturnType<typeof canonicalBreakdownPage>> | undefined
    let modelBreakdown: Awaited<ReturnType<typeof canonicalBreakdownPage>> | undefined
    if (group && dimensions.has(group as never)) {
      const dimension =
        group === "app" ? undefined : (group as "provider" | "harness" | "model" | "location" | "session" | "workspace")
      const localHistoryBreakdownRows =
        view === "total"
          ? totalRows.map((row) => ({
              value:
                group === "app"
                  ? row.app
                  : group === "provider"
                    ? row.provider
                    : group === "model"
                      ? usageModelKey(row.provider, row.model)
                      : group === "location"
                        ? "local"
                        : "unavailable",
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
              group:
                group === "app"
                  ? row.app
                  : group === "provider"
                    ? row.provider
                    : group === "model"
                      ? usageModelKey(row.provider, row.model)
                      : group === "location"
                        ? "local"
                        : "unavailable",
              value: usageModelKey(row.provider, row.model),
              input_tokens: row.tokens.input ?? 0,
              output_tokens: row.tokens.output ?? 0,
              reasoning_tokens: row.tokens.reasoning ?? 0,
              cache_read_tokens: row.tokens.cacheRead ?? 0,
              cache_write_tokens: row.tokens.cacheWrite ?? 0,
            }))
          : []
      breakdown = await canonicalBreakdownPage({
        dimension: group as UsageFilterDimension,
        rows,
        modelRows: view === "total" ? localHistoryModelRows : [...centralModelRows, ...localModelRows],
        metric,
        ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
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
        ...(c.req.query("model_after") ? { after: c.req.query("model_after") } : {}),
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
            group !== "app" && includeClaxedo
              ? chartRowsFromFacts(
                  localFacts,
                  group as "provider" | "harness" | "model" | "location" | "session" | "workspace",
                  timeZone,
                )
              : [],
          )
      : undefined
    const response: UnifiedUsageResponse = {
      version: 1,
      range: { since, until, timeZone },
      quota: { status: "unavailable" },
      claxedo: {
        ...claxedoSeries,
        cost: claxedoCost,
        locationShare: locationShare(
          includeClaxedo && !centralFactProjection.available
            ? (central as { locations?: unknown } | undefined)?.locations
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
          (central as { filters?: Record<string, string[]> } | undefined)?.filters,
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
