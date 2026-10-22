/**
 * The wait before a reconnect's next attempt: doubling from `baseMs` per
 * failed attempt up to `ceilingMs`, drawn from the upper half of that window
 * so a fleet dropped by one deploy does not come back in step.
 *
 * `attempt` counts the failures so far; the first retry after one failure
 * waits between `baseMs` and `2 × baseMs`.
 */
export function reconnectDelayMs(
  input: { attempt: number; baseMs: number; ceilingMs: number },
  random: () => number = Math.random,
) {
  const ceiling = Math.min(input.ceilingMs, input.baseMs * 2 ** Math.max(1, input.attempt))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}
