import { takeEventLoopActivity } from "@claxedo/helpers/event-loop-activity"

export type EventLoopStallMonitorOptions = {
  warn: (message: string, extra: Record<string, unknown>) => void
  thresholdMs?: number
  sampleMs?: number
  settleMs?: number
  cooldownMs?: number
}

type Stalls = { maxBlockedMs: number; count: number; during: Set<string>; lastAt: number }

/**
 * Reports a blocked event loop from how late a repeating timer runs.
 * `perf_hooks.monitorEventLoopDelay` missed a 620 ms block while Node loaded
 * the OpenCode SDK's 1,430-module graph after a histogram reset, which this
 * timer measured. One engine boot holds the loop several times within a few
 * seconds, so stalls are gathered until the loop has kept up for `settleMs`
 * and reported as one line, at most once per `cooldownMs`.
 */
export function startEventLoopStallMonitor(options: EventLoopStallMonitorOptions): () => void {
  const thresholdMs = options.thresholdMs ?? 1_000
  const sampleMs = options.sampleMs ?? 100
  const settleMs = options.settleMs ?? 2_000
  const cooldownMs = options.cooldownMs ?? 60_000
  let expected = performance.now() + sampleMs
  let lastWarning = Number.NEGATIVE_INFINITY
  let stalls: Stalls | undefined
  const timer = setInterval(() => {
    const now = performance.now()
    const blockedMs = now - expected
    expected = now + sampleMs
    const during = takeEventLoopActivity()
    if (blockedMs >= thresholdMs) {
      stalls ??= { maxBlockedMs: 0, count: 0, during: new Set(), lastAt: now }
      stalls.maxBlockedMs = Math.max(stalls.maxBlockedMs, blockedMs)
      stalls.count += 1
      stalls.lastAt = now
      for (const name of during) stalls.during.add(name)
      return
    }
    if (!stalls || now - stalls.lastAt < settleMs || now - lastWarning < cooldownMs) return
    options.warn("Event loop blocked", {
      maxBlockedMs: Math.round(stalls.maxBlockedMs),
      stalls: stalls.count,
      during: [...stalls.during].sort().join(",") || "unknown",
    })
    lastWarning = now
    stalls = undefined
  }, sampleMs)
  timer.unref()
  return () => clearInterval(timer)
}
