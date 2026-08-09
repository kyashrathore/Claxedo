import type { TurnUsageRevision } from "./contracts"

export type ExternalUsageBucket = {
  app: string
  provider: string
  model: string
  bucketStart: number
  nativeSessionId: string
  turnCount: number
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null }
}

export type UsageFilterDimension = "app" | "provider" | "harness" | "model" | "location" | "session" | "workspace"
export type UsageFilters = Partial<Record<UsageFilterDimension, string>>

export function usageLocation(value: TurnUsageRevision["location"]) {
  return value === "local" || value === "user-hosted" ? "local" : "cloud"
}

export function usageModelKey(provider: string, model: string) {
  return model.includes("/") ? model : `${provider}/${model}`
}

export function usageFactDimension(fact: TurnUsageRevision, dimension: Exclude<UsageFilterDimension, "app">) {
  if (dimension === "provider") return fact.providerId
  if (dimension === "harness") return fact.harness
  if (dimension === "model") return usageModelKey(fact.providerId, fact.modelId)
  if (dimension === "location") return usageLocation(fact.location)
  if (dimension === "session") return fact.sessionRef
  return fact.workspaceId ?? "unavailable"
}

export function usageFactMatches(fact: TurnUsageRevision, filters: UsageFilters) {
  if (filters.app && filters.app.toLowerCase() !== "claxedo") return false
  return (["provider", "harness", "model", "location", "session", "workspace"] as const)
    .every((dimension) => !filters[dimension] || usageFactDimension(fact, dimension) === filters[dimension])
}

export function usageFactFilterOptions(facts: readonly TurnUsageRevision[]) {
  return Object.fromEntries((["provider", "harness", "model", "location", "session", "workspace"] as const).map((dimension) => [
    dimension,
    [...new Set(facts.map((fact) => usageFactDimension(fact, dimension)))].toSorted(),
  ])) as Record<Exclude<UsageFilterDimension, "app">, string[]>
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

export function centralProjectionSeries(value: unknown): UsageSeries {
  const source = value as { totals?: Record<string, unknown>; daily?: Array<Record<string, unknown>> } | null
  const map = (row: Record<string, unknown> = {}): UsageMetricTotals => ({
    turnCount: Number(row.turn_count ?? 0),
    input: Number(row.input_tokens ?? 0),
    output: Number(row.output_tokens ?? 0),
    reasoning: Number(row.reasoning_tokens ?? 0),
    cacheRead: Number(row.cache_read_tokens ?? 0),
    cacheWrite: Number(row.cache_write_tokens ?? 0),
    unknownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"]
      .reduce((sum, name) => sum + Number(row.turn_count ?? 0) - Number(row[`${name}_known_count`] ?? 0), 0),
    partialTurnCount: Number(row.partial_turn_count ?? 0),
    unavailableTurnCount: Number(row.unavailable_turn_count ?? 0),
    errorTurnCount: Number(row.error_turn_count ?? 0),
  })
  return {
    totals: map(source?.totals),
    daily: (source?.daily ?? []).map((row) => ({ date: String(row.date), ...map(row) })),
  }
}

export function groupUsageFacts(
  facts: readonly TurnUsageRevision[],
  dimension: "provider" | "harness" | "model" | "location" | "session" | "workspace",
) {
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
