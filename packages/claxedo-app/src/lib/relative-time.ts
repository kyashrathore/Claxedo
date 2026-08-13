/**
 * Locale-aware date formatting on the platform's own Intl, matching the two
 * luxon spellings the app used (`toRelative()` and `DATETIME_MED`) so luxon
 * (~70 kB min) stays out of the eager bundle. The rail's compact "2d" labels
 * are a different display convention and keep their own formatter.
 */

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

/** luxon `DateTime.fromMillis(ms).toRelative()`: "2 days ago", "in 3 hours". */
export function formatRelativeTime(ms: number, locale?: string): string {
  const diff = ms - Date.now()
  const magnitude = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" })
  for (const [unit, span] of UNITS) {
    if (magnitude >= span) return formatter.format(Math.trunc(diff / span), unit)
  }
  return formatter.format(Math.trunc(diff / 1000), "second")
}

/** luxon `toLocaleString(DateTime.DATETIME_MED)`: "Oct 14, 1983, 1:30 PM". */
export function formatDateTimeMed(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)
}
