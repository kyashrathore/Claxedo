// Ninety inclusive local calendar days can span one DST fall-back hour.
// This still rejects a 91-day UTC request while accepting the advertised
// 90-day control in every IANA timezone.
const MAX_RANGE_MS = 90 * 86_400_000 + 2 * 3_600_000

function validUsageRange(since: number, until: number) {
  return Number.isFinite(since) && Number.isFinite(until) && until >= since && until - since <= MAX_RANGE_MS
}

/** Why a read's `since` and `until` query values are refused, or undefined for a range it may read. */
export function usageRangeRefusal(since: string | undefined, until: string | undefined): string | undefined {
  if (!since || !until) return "since and until are required"
  return validUsageRange(Number(since), Number(until)) ? undefined : "since and until must define a range of at most 90 days"
}

/** The same for a read that runs from `since` to now. */
export function usageSinceRefusal(since: string | undefined, now: number): string | undefined {
  if (!since) return "since is required"
  return validUsageRange(Number(since), now) ? undefined : "since must be at most 90 days ago"
}
