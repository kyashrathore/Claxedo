export const RECONNECT_DELAY_MS = 250
export const MAX_RECONNECT_DELAY_MS = 15_000

/**
 * Delay before re-opening a failed SSE stream. The first retry uses the base
 * delay; subsequent consecutive failures grow exponentially up to a ceiling,
 * then jitter within the top half of that window so many tabs don't reconnect
 * in lockstep. `failures` is the count of PRIOR consecutive failures (0 on the
 * first retry). `random` is injectable so the jitter is deterministic in tests.
 */
export function reconnectBackoffMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return RECONNECT_DELAY_MS
  const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** failures)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}
