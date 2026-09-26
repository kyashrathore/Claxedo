const UNITS: Array<[Intl.RelativeTimeFormatUnit, number, string]> = [
  ["year", 31_536_000_000, "y"],
  ["month", 2_592_000_000, "mo"],
  ["week", 604_800_000, "w"],
  ["day", 86_400_000, "d"],
  ["hour", 3_600_000, "h"],
  ["minute", 60_000, "m"],
]

export function formatRelativeTime(ms: number, locale?: string, now = Date.now()): string {
  const diff = ms - now
  const magnitude = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" })
  for (const [unit, span] of UNITS) {
    if (magnitude >= span) return formatter.format(Math.trunc(diff / span), unit)
  }
  return formatter.format(Math.trunc(diff / 1000), "second")
}

export function formatCompactAge(ms: number, now = Date.now()): string | undefined {
  const magnitude = Math.abs(ms - now)
  for (const [, span, suffix] of UNITS) {
    if (magnitude >= span) return `${Math.trunc(magnitude / span)}${suffix}`
  }
  return undefined
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export function nextAgeChange(at: number, now: number): number {
  const age = now - at
  const step = age < HOUR ? MINUTE : age < DAY ? HOUR : DAY
  return at + (Math.floor(age / step) + 1) * step
}

export function formatDateTimeMed(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)
}
