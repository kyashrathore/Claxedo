import type { Translate } from "./dictionary"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 52 * WEEK

export function shortAgeText(t: Translate, timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return t("claxedo-tasks.age.now")
  if (elapsed < HOUR) return t("claxedo-tasks.age.minutes", { count: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t("claxedo-tasks.age.hours", { count: Math.floor(elapsed / HOUR) })
  if (elapsed < WEEK) return t("claxedo-tasks.age.days", { count: Math.floor(elapsed / DAY) })
  if (elapsed < YEAR) return t("claxedo-tasks.age.weeks", { count: Math.floor(elapsed / WEEK) })
  return t("claxedo-tasks.age.year", { count: new Date(timestamp).getFullYear() })
}
