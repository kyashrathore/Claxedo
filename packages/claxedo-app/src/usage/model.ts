import type { AppError, UsageRequest, UsageSummary } from "@/server"

export type UsageTotals = UsageSummary["claxedo"]["totals"]

export type QuotaAccount = NonNullable<UsageSummary["quota"]["snapshot"]>["accounts"][number]

export type QuotaWindow = QuotaAccount["windows"][number]

export type BreakdownRow = NonNullable<UsageSummary["breakdown"]>["rows"][number]

export type UsageView = "quota" | "claxedo"

export type UsageTab = UsageView | "cloud"

export type UsageMetric = "tokens" | "cost"

export type UsageGroup = "provider" | "model"

export type UsageDays = 7 | 30 | 90

export type UsageOptions = {
  readonly view: UsageView
  readonly days: UsageDays
  readonly metric: UsageMetric
  readonly group: UsageGroup
  readonly after?: string
  readonly refreshNonce?: number
}

export type UsageLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly summary: UsageSummary }
  | { readonly kind: "failed"; readonly error: AppError }

export const BREAKDOWN_PAGE_SIZE = 25

export function inclusiveLocalRange(days: number, now: number): { readonly since: number; readonly until: number } {
  const since = new Date(now)
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const until = new Date(now)
  until.setHours(23, 59, 59, 999)
  return { since: since.getTime(), until: until.getTime() }
}

export function usageRequest(options: UsageOptions, now: number, timeZone: string): UsageRequest {
  const range = inclusiveLocalRange(options.days, now)
  const refresh = options.refreshNonce ? { refreshNonce: options.refreshNonce } : {}
  if (options.view === "quota") return { ...range, timeZone, view: "quota", ...refresh }
  return {
    ...range,
    timeZone,
    view: options.view,
    ...refresh,
    group: options.group,
    metric: options.metric,
    limit: BREAKDOWN_PAGE_SIZE,
    ...(options.after ? { after: options.after } : {}),
  }
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
}

export function usedPercent(window: QuotaWindow): number {
  return Math.min(100, Math.max(0, Math.round(window.usedPercent)))
}
