/**
 * Keeps the rail's session-status batch fetch running.
 *
 * The rail renders "working" / "permission" badges from `session.status`, and
 * it used to fetch that batch exactly once per change of the visible row set:
 * a single `setTimeout(run, 250)` inside `createEffect(on(signature, …))`, with
 * `run` never rescheduling itself. Live updates were therefore left entirely to
 * `session.status` SSE events — which the server does not push for harness
 * (ACP/Claude) sessions. Measured against a running v0.0.65 build: the server
 * reported `{"type":"busy"}` over `GET /session/status` while the renderer's
 * cached status for the same session sat at `{"type":"idle"}`, last written
 * 385s earlier — so the row showed no activity at all.
 *
 * Polling is the fix rather than new events on purpose: opencode's own CLI
 * already polls `session.status` for the same reason (see
 * `opencode/src/cli/cmd/run/stream.transport.ts`), and the rail was already
 * written for it — `SIDEBAR_SESSION_STATUS_FRESH_MS` plus the skip-fresh and
 * skip-in-flight guards inside `run` mean a repeated call is a no-op unless the
 * data has actually aged out. This module only supplies the missing clock.
 */
export type SidebarStatusPollTimer = unknown

export type SidebarStatusPollInput = {
  /** The existing batch fetch. Safe to call repeatedly: it self-skips when fresh. */
  run: () => void
  schedule: (fn: () => void, ms: number) => SidebarStatusPollTimer
  clear: (timer: SidebarStatusPollTimer) => void
  /**
   * Gate for "don't fetch right now" — a fast session switch in its quiet
   * window, or a hidden window. Returning false must NOT stop the loop, only
   * skip that tick, otherwise the rail never recovers once the gate reopens.
   */
  shouldRun?: () => boolean
  /** Kept at the original 250ms so the first paint after a row-set change is unchanged. */
  initialDelayMs?: number
  /** Below SIDEBAR_SESSION_STATUS_FRESH_MS (10s) so a row is never rendered from aged-out data. */
  intervalMs?: number
}

export const SIDEBAR_STATUS_POLL_INITIAL_MS = 250
export const SIDEBAR_STATUS_POLL_INTERVAL_MS = 5_000

export function createSidebarStatusPoll(input: SidebarStatusPollInput) {
  const initialDelayMs = input.initialDelayMs ?? SIDEBAR_STATUS_POLL_INITIAL_MS
  const intervalMs = input.intervalMs ?? SIDEBAR_STATUS_POLL_INTERVAL_MS
  let timer: SidebarStatusPollTimer | undefined
  let stopped = false

  const tick = () => {
    timer = undefined
    if (stopped) return
    if (input.shouldRun?.() !== false) input.run()
    // Rescheduled even when the tick was skipped: a gate that is closed now
    // (quiet window, hidden window) reopens later, and a loop that stopped on
    // the closed gate is exactly the "fetched once, then never again" bug.
    arm(intervalMs)
  }

  const arm = (delayMs: number) => {
    if (stopped || timer !== undefined) return
    timer = input.schedule(tick, delayMs)
  }

  return {
    start() {
      stopped = false
      arm(initialDelayMs)
    },
    stop() {
      stopped = true
      if (timer === undefined) return
      input.clear(timer)
      timer = undefined
    },
  }
}
