import { useI18n, useTranslator } from "@/i18n"
import { usageDictionary } from "../i18n"
import type { CostEstimate } from "../cost-estimate"

const TINY_SHARE = 0.001
const WEEK_DAYS = 7

export type UsageFormats = {
  readonly count: (value: number) => string
  readonly whole: (value: number) => string
  readonly usd: (value: number) => string
  readonly cost: (estimate: CostEstimate) => string
  readonly share: (share: number) => string
  readonly day: (date: string, rangeDays: number) => string
  readonly longDay: (date: string) => string
}

function calendarDay(date: string): Date {
  return new Date(`${date}T12:00:00Z`)
}

export function useUsageFormats(): UsageFormats {
  const i18n = useI18n()
  const t = useTranslator(usageDictionary)
  const usd = (value: number) => new Intl.NumberFormat(i18n.intlTag(), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)
  const percent = (value: number) => new Intl.NumberFormat(i18n.intlTag(), { style: "percent", maximumFractionDigits: value < 0.01 ? 1 : 0 }).format(value)
  return {
    count: (value) => new Intl.NumberFormat(i18n.intlTag(), { notation: "compact", maximumFractionDigits: 1 }).format(value),
    whole: (value) => new Intl.NumberFormat(i18n.intlTag()).format(value),
    usd,
    cost: (estimate) => {
      if (estimate.kind === "unknown") return t("usage.unknown")
      if (estimate.kind === "none") return usd(0)
      return estimate.kind === "partial" ? t("usage.cost.atLeast", { amount: usd(estimate.usd) }) : usd(estimate.usd)
    },
    share: (share) => (share > 0 && share < TINY_SHARE ? `<${percent(TINY_SHARE)}` : percent(share)),
    day: (date, rangeDays) =>
      new Intl.DateTimeFormat(i18n.intlTag(), rangeDays <= WEEK_DAYS ? { weekday: "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }).format(calendarDay(date)),
    longDay: (date) => new Intl.DateTimeFormat(i18n.intlTag(), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(calendarDay(date)),
  }
}
