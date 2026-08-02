/**
 * Shared duration formatter for the timeline (D§3.6):
 *   <60s   → "5s"
 *   <1h    → "2m 14s"
 *   else   → "1h 22m 5s"
 * Used by the turn-fold row, running tool rows, and live elapsed tickers so the
 * same voice appears everywhere.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (totalMinutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
