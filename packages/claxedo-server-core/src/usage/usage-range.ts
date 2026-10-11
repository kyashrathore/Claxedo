// Ninety inclusive local calendar days can span one DST fall-back hour.
// This still rejects a 91-day UTC request while accepting the advertised
// 90-day control in every IANA timezone.
const MAX_RANGE_MS = 90 * 86_400_000 + 2 * 3_600_000

export function validUsageRange(since: number, until: number) {
  return Number.isFinite(since) && Number.isFinite(until) && until >= since && until - since <= MAX_RANGE_MS
}
