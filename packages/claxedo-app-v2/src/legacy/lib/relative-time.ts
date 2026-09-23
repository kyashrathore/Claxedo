/**
 * Locale-aware date formatting on the platform's own Intl, matching the two
 * luxon spellings the app used (`toRelative()` and `DATETIME_MED`) so luxon
 * (~70 kB min) stays out of the eager bundle. The compact spelling reads the
 * same bucket table as the sentence, so a row and its tooltip never disagree
 * about which unit the age falls in.
 */

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number, string]> = [
  ["year", 31_536_000_000, "y"],
  ["month", 2_592_000_000, "mo"],
  ["week", 604_800_000, "w"],
  ["day", 86_400_000, "d"],
  ["hour", 3_600_000, "h"],
  ["minute", 60_000, "m"],
]

/** luxon `DateTime.fromMillis(ms).toRelative()`: "2 days ago", "in 3 hours". */
export function formatRelativeTime(ms: number, locale?: string, now = Date.now()): string {
  const diff = ms - now
  const magnitude = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" })
  for (const [unit, span] of UNITS) {
    if (magnitude >= span) return formatter.format(Math.trunc(diff / span), unit)
  }
  return formatter.format(Math.trunc(diff / 1000), "second")
}

/**
 * The same buckets in one unit and no space — "5m", "5h", "3d" — for a column
 * with no room for a sentence. Below the smallest bucket there is no figure
 * worth showing, so the caller supplies the word that belongs there; the digits
 * are language-independent but that word is not.
 */
export function formatCompactAge(ms: number, now = Date.now()): string | undefined {
  const magnitude = Math.abs(ms - now)
  for (const [, span, suffix] of UNITS) {
    if (magnitude >= span) return `${Math.trunc(magnitude / span)}${suffix}`
  }
  return undefined
}

/** luxon `toLocaleString(DateTime.DATETIME_MED)`: "Oct 14, 1983, 1:30 PM". */
export function formatDateTimeMed(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)
}
