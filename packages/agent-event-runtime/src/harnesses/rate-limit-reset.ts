export function formatRateLimitReset(resetsAt?: number | null, windowDurationMins?: number | null) {
  if (typeof resetsAt === "number" && resetsAt > 1_000_000_000) {
    const millis = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000
    return ` It will reset at ${new Date(millis).toLocaleString()}.`
  }
  if (typeof windowDurationMins === "number" && windowDurationMins > 0) {
    const hours = Math.round(windowDurationMins / 60)
    if (hours >= 2) return ` It will reset in about ${hours} hours.`
    if (hours === 1) return " It will reset in about 1 hour."
    return ` It will reset in ${windowDurationMins} minutes.`
  }
  return ""
}
