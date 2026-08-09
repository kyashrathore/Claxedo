/** Browser-safe contract for the single unified Usage endpoint. */
export type UsageTotals = {
  turnCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknownCategories: number
  partialTurnCount?: number
  unavailableTurnCount?: number
  errorTurnCount?: number
}

export type UsageSeries = { totals: UsageTotals; daily: Array<UsageTotals & { date: string }> }

export type UsageCost = {
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  catalog: { adapter: string; version: string; source: string }
  daily?: Array<{ date: string; estimatedUsd: number; pricedTokens: number; unpricedTokens: number }>
}

export type UsageFilterDimension = "app" | "provider" | "harness" | "model" | "location" | "session" | "workspace"
export type UsageFilters = Partial<Record<UsageFilterDimension, string>>
export type UsageFilterOptions = Partial<Record<UsageFilterDimension, string[]>>

export type UsageBreakdownRow = UsageTotals & {
  value: string
  label: string
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  status: "final" | "partial" | "unavailable" | "unpriced"
  href?: string
}

export type UsageBreakdownPage = {
  dimension: UsageFilterDimension
  rows: UsageBreakdownRow[]
  next?: string
}

export type UsageChartSeries = {
  dimension: string
  series: Array<{
    value: string
    label: string
    daily: Array<{
      date: string
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
    }>
  }>
}

export type UnifiedUsageResponse = {
  version: 1
  range: { since: number; until: number; timeZone: string }
  quota: { status: "available" | "unavailable" | "degraded"; snapshot?: unknown; error?: string }
  claxedo: UsageSeries & {
    cost: UsageCost
    locationShare: { localTokens: number; cloudTokens: number }
    status: "available" | "unavailable" | "stale" | "degraded"
    scope: "local" | "cross-machine"
    error?: string
  }
  externalLocal: UsageSeries & {
    cost: UsageCost
    status: "available" | "unavailable" | "degraded"
    coverage: Array<{
      source: string
      status: "available" | "degraded" | "unavailable" | "unsupported"
      error?: string
    }>
    unclassified: number
    error?: string
  }
  total: UsageSeries
  totalCost: UsageCost
  filterOptions: { claxedo: UsageFilterOptions; total: UsageFilterOptions }
  sync: { attempted: number; delivered: number; conflicts: number; pending: number }
  breakdown?: UsageBreakdownPage
  modelBreakdown?: UsageBreakdownPage
  chart?: UsageChartSeries
}
