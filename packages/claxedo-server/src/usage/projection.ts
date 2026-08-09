import type { TurnUsageRevision } from "./contracts"
import type { ExternalUsageBucket } from "./adapters/token-tracker-local-history"

export type UsageMetricTotals = {
  turnCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknownCategories: number
}

export type UsageDailyPoint = UsageMetricTotals & { date: string }

export type UsageSeries = {
  totals: UsageMetricTotals
  daily: UsageDailyPoint[]
}

export const emptyUsageTotals = (): UsageMetricTotals => ({
  turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0,
})

function dateFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
}

function add(target: UsageMetricTotals, value: UsageMetricTotals) {
  for (const field of ["turnCount", "input", "output", "reasoning", "cacheRead", "cacheWrite", "unknownCategories"] as const) {
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
  const latest = new Map<string, TurnUsageRevision>()
  const formatDate = dateFormatter(input.timeZone)
  for (const fact of input.facts) {
    const key = `${fact.hostId}\u0000${fact.sessionRef}\u0000${fact.messageId}`
    const existing = latest.get(key)
    if (!existing || fact.revision > existing.revision) latest.set(key, fact)
  }
  for (const fact of latest.values()) {
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
    }
    add(totals, contribution)
    const key = formatDate.format(new Date(fact.observedAt))
    const point = daily.get(key) ?? emptyUsageTotals()
    add(point, contribution)
    daily.set(key, point)
  }
  return { totals, daily: [...daily].map(([key, value]) => ({ date: key, ...value })).toSorted((a, b) => a.date.localeCompare(b.date)) }
}

export function usageSeriesFromExternal(input: {
  rows: readonly ExternalUsageBucket[]
  since: number
  until: number
  timeZone: string
}): UsageSeries {
  const facts = input.rows.map((row): TurnUsageRevision => ({
    hostId: "external-local",
    sessionRef: `external:${row.app}:${row.nativeSessionId}`,
    sessionId: row.nativeSessionId,
    messageId: `${row.bucketStart}`,
    revision: 1,
    observedAt: row.bucketStart,
    settlement: "final",
    status: "completed",
    location: "local",
    harness: row.app,
    providerId: row.app,
    modelId: row.model,
    tokens: {
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cache: { read: row.tokens.cacheRead, write: row.tokens.cacheWrite },
    },
    quality: { source: "provider", knownCategories: ["input", "output", "reasoning", "cache_read", "cache_write"] },
  }))
  return usageSeriesFromFacts({ ...input, facts })
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
  })
  return {
    totals: map(source?.totals),
    daily: (source?.daily ?? []).map((row) => ({ date: String(row.date), ...map(row) })),
  }
}

export function groupUsageFacts(
  facts: readonly TurnUsageRevision[],
  dimension: "harness" | "model" | "location" | "session" | "workspace",
) {
  const grouped = new Map<string, UsageMetricTotals>()
  for (const fact of facts) {
    const value = dimension === "harness" ? fact.harness
      : dimension === "model" ? `${fact.providerId}/${fact.modelId}`
      : dimension === "location" ? fact.location
      : dimension === "session" ? fact.sessionRef
      : fact.workspaceId ?? "unavailable"
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
    })
    grouped.set(value, row)
  }
  return [...grouped].map(([value, totals]) => ({ value, ...totals })).toSorted((a, b) => a.value.localeCompare(b.value))
}
