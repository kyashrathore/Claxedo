import { totalTokens, type UsageTotals } from "./model"
import type { PricedUsage } from "./cost-estimate"

export type DailyPoint = { readonly date: string; readonly value: number | null }

export type UsageRange = { readonly since: number; readonly until: number; readonly timeZone: string }

const DAY_MS = 86_400_000
const HALF_DAY_MS = DAY_MS / 2
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const
const WEEK = 7
const SPREAD_LABELS = 5

export function rangeDates(range: UsageRange): readonly string[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: range.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const dates: string[] = []
  const add = (time: number) => {
    const date = format.format(new Date(time))
    if (!dates.includes(date)) dates.push(date)
  }
  for (let time = range.since + HALF_DAY_MS; time <= range.until; time += DAY_MS) add(time)
  if (range.until >= range.since) add(range.until)
  return dates
}

export function dailyTokens(dates: readonly string[], daily: readonly (UsageTotals & { readonly date: string })[]): readonly DailyPoint[] {
  const tokens = new Map(daily.map((day) => [day.date, totalTokens(day)]))
  return dates.map((date) => ({ date, value: tokens.get(date) ?? 0 }))
}

export function dailyCost(dates: readonly string[], daily: readonly (PricedUsage & { readonly date: string })[] | undefined): readonly DailyPoint[] | undefined {
  if (!daily) return undefined
  const cost = new Map(daily.map((day) => [day.date, day.pricedTokens === 0 && day.unpricedTokens > 0 ? null : day.estimatedUsd]))
  return dates.map((date) => ({ date, value: cost.has(date) ? (cost.get(date) ?? null) : 0 }))
}

export function niceCeiling(peak: number): number {
  if (peak <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const step = NICE_STEPS.find((candidate) => candidate >= peak / magnitude - 1e-9) ?? 10
  return step * magnitude
}

export function axisLabelIndexes(count: number): readonly number[] {
  if (count <= WEEK) return Array.from({ length: count }, (_, index) => index)
  return Array.from({ length: SPREAD_LABELS }, (_, slot) => Math.round((slot * (count - 1)) / (SPREAD_LABELS - 1)))
}
