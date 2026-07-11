/**
 * Pure reconnect / backoff / heartbeat / escalation decisions for the Claxedo
 * event stream (`ClaxedoEventsProvider`). Extracted so the timing math and the
 * failure-escalation rule can be spec-tested deterministically without a live
 * SSE connection — the provider's `connectTarget` closure consumes these and
 * keeps only the actual timer arming and fetch loop.
 *
 * Mirrors the sibling `context/global-sdk/reconnect-backoff.ts` shape.
 */
export const RECONNECT_DELAY_MS = 2000
export const MAX_RECONNECT_DELAY_MS = 30000
export const HEARTBEAT_TIMEOUT_MS = 45000

// Only once failures are SUSTAINED (this many consecutive) do we escalate a
// stream outage from a quiet `console.debug` to a greppable `console.error`.
export const SUSTAINED_FAILURE_THRESHOLD = 3

/**
 * Delay before re-opening a failed event stream. The first retry uses the base
 * delay; subsequent consecutive failures grow exponentially up to a 30s
 * ceiling, then jitter within the top half so panes don't reconnect in
 * lockstep. `failures` is the count of PRIOR consecutive failures (0 on the
 * first retry). `random` is injectable so jitter is deterministic in tests.
 */
export function reconnectBackoffMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return RECONNECT_DELAY_MS
  const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** failures)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/**
 * The actual reconnect delay: the backoff, floored by any fast-session-switch
 * "network quiet" window (during a rapid session switch we deliberately hold
 * reconnects until the quiet window elapses).
 */
export function reconnectDelayMs(failures: number, quietDelay: number, random: () => number = Math.random): number {
  return Math.max(reconnectBackoffMs(failures, random), quietDelay)
}

export type FailureEscalation = "escalate" | "quiet" | "silent"

/**
 * How loudly to report the current failure.
 * - `quiet` (failures < threshold): early tunnel-settling failures — `console.debug`.
 * - `escalate` (failures === threshold): the run just became sustained — log a
 *   single `console.error` and nudge the connection authority to reconnecting.
 * - `silent` (failures > threshold): already escalated once; stay quiet so the
 *   backoff ticks don't re-spam. `failures` resets to 0 on a successful open,
 *   so a later failure run escalates again.
 */
export function failureEscalation(failures: number): FailureEscalation {
  if (failures === SUSTAINED_FAILURE_THRESHOLD) return "escalate"
  if (failures < SUSTAINED_FAILURE_THRESHOLD) return "quiet"
  return "silent"
}
