/**
 * Phase timing for the Agent Plugins read routes.
 *
 * The plane's cost on these routes is I/O waiting, not CPU: a Worker at the
 * caller's colo awaiting D1 and R2 in other regions. `wrangler tail` shows
 * wall time per request but nothing about where it went, so the routes emit
 * one structured log line naming each phase's duration. The line is the
 * evidence a latency regression is diagnosed from; keep it one per request.
 */
export type RequestTiming = {
  /** Records the time since the previous mark (or the start) under `phase`. */
  mark(phase: string): void
  /** Emits the one log line for this request and returns the phases. */
  report(route: string, extra?: Record<string, number | string | boolean>): Record<string, number>
}

export function createRequestTiming(now: () => number = () => performance.now()): RequestTiming {
  const started = now()
  let previous = started
  const phases: Record<string, number> = {}
  return {
    mark(phase) {
      const at = now()
      phases[phase] = Math.round((phases[phase] ?? 0) + (at - previous))
      previous = at
    },
    report(route, extra) {
      const total = Math.round(now() - started)
      console.log(JSON.stringify({ event: "agent_plugins.timing", route, total, ...phases, ...extra }))
      return { total, ...phases }
    },
  }
}
