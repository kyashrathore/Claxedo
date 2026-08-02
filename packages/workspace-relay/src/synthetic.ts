/**
 * T10: Synthetic end-to-end probe.
 *
 * Liveness depends on metrics; metrics can lie. A synthetic probe periodically
 * exercises the relay's HTTP path and records RTT so we have an independent
 * signal that the data path actually works.
 *
 * Implementation notes
 * --------------------
 * - The probe targets `${relayUrl}/health` rather than minting a Runtime
 *   Access Token and hitting `/workspaces/<id>/...`. `/health` validates HTTP
 *   connectivity end-to-end without pretending the Relay owns Control Plane
 *   token issuance.
 * - All clocks, timers and `fetch` are injectable so tests stay deterministic.
 * - "Loud" logs after 3 consecutive failures use `console.error` by default;
 *   pageability (PagerDuty / equivalent) is wired separately.
 */

export type SyntheticProbeStats = {
  successCount: number
  failureCount: number
  consecutiveFailures: number
  /** RTT (ms) of the most recent probe attempt. Undefined before the first probe completes. */
  lastRttMs?: number
  /** p50 / p99 over the rolling RTT window. Undefined if no successes yet. */
  p50?: number
  p99?: number
  /** Number of RTTs currently in the rolling window. */
  windowSize: number
}

export type SyntheticProbe = {
  stop(): void
  stats(): SyntheticProbeStats
}

export type SyntheticProbeOptions = {
  /** Base URL of the relay, e.g. `http://127.0.0.1:7777`. No trailing slash required. */
  relayUrl: string
  /** Probe cadence. Default 60_000 (60 s). */
  intervalMs?: number
  /** Summary log cadence (p50/p99). Default 300_000 (5 min). */
  summaryIntervalMs?: number
  /** Path to probe. Default `/health`. */
  probePath?: string
  /** Rolling window size for RTT percentile calculation. Default 100. */
  rttWindowSize?: number
  /** Number of consecutive failures that triggers a loud log. Default 3. */
  loudFailureThreshold?: number
  /** Override `fetch`. Defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Override `setInterval` for tests. Defaults to global `setInterval`. */
  setInterval?: typeof setInterval
  /** Override `clearInterval` for tests. Defaults to global `clearInterval`. */
  clearInterval?: typeof clearInterval
  /** Loud-failure logger. Defaults to `console.error`. */
  logError?: (msg: string, fields?: Record<string, unknown>) => void
  /** Periodic summary logger (p50/p99). Defaults to `console.log`. */
  logSummary?: (msg: string, fields?: Record<string, unknown>) => void
}

function percentile(sorted: ReadonlyArray<number>, p: number): number | undefined {
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  // Nearest-rank percentile, simple and good enough for an ops gauge.
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1)
  return sorted[idx]
}

export function startSyntheticProbe(options: SyntheticProbeOptions): SyntheticProbe {
  const intervalMs = options.intervalMs ?? 60_000
  const summaryIntervalMs = options.summaryIntervalMs ?? 300_000
  const probePath = options.probePath ?? "/health"
  const rttWindowSize = options.rttWindowSize ?? 100
  const loudFailureThreshold = options.loudFailureThreshold ?? 3
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const setIntervalImpl = options.setInterval ?? globalThis.setInterval
  const clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval
  const logError = options.logError ?? ((msg, fields) => console.error(msg, fields ?? {}))
  const logSummary = options.logSummary ?? ((msg, fields) => console.log(msg, fields ?? {}))

  const root = options.relayUrl.replace(/\/+$/, "")
  const probeUrl = `${root}${probePath.startsWith("/") ? probePath : `/${probePath}`}`

  let successCount = 0
  let failureCount = 0
  let consecutiveFailures = 0
  let lastRttMs: number | undefined
  const rtts: number[] = []

  function recordRtt(rttMs: number) {
    rtts.push(rttMs)
    if (rtts.length > rttWindowSize) rtts.shift()
  }

  async function tick() {
    const startedAt = now()
    let rttMs = 0
    let ok = false
    let failureReason: string | undefined
    try {
      const res = await fetchImpl(probeUrl)
      rttMs = now() - startedAt
      if (res.status >= 200 && res.status < 300) {
        ok = true
      } else {
        failureReason = `relay responded ${res.status}`
      }
    } catch (err) {
      rttMs = now() - startedAt
      failureReason = err instanceof Error ? err.message : String(err)
    }
    lastRttMs = rttMs
    if (ok) {
      successCount++
      consecutiveFailures = 0
      recordRtt(rttMs)
    } else {
      failureCount++
      consecutiveFailures++
      if (consecutiveFailures >= loudFailureThreshold) {
        logError("[workspace-relay] synthetic probe failing", {
          consecutiveFailures,
          probeUrl,
          reason: failureReason,
          rttMs,
        })
      }
    }
  }

  function summarize() {
    if (rtts.length === 0) {
      logSummary("[workspace-relay] synthetic probe summary", {
        windowSize: 0,
        successCount,
        failureCount,
        consecutiveFailures,
      })
      return
    }
    const sorted = [...rtts].sort((a, b) => a - b)
    const p50 = percentile(sorted, 50)
    const p99 = percentile(sorted, 99)
    logSummary("[workspace-relay] synthetic probe summary", {
      windowSize: rtts.length,
      successCount,
      failureCount,
      consecutiveFailures,
      p50,
      p99,
    })
  }

  // setInterval triggers a fire-and-forget tick. Errors are caught inside
  // tick() itself so this never rejects, but the void/catch keeps lint happy.
  const probeHandle = setIntervalImpl(() => {
    void tick().catch((err) => {
      logError("[workspace-relay] synthetic probe tick threw", {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  const summaryHandle = setIntervalImpl(() => {
    summarize()
  }, summaryIntervalMs)

  return {
    stop() {
      clearIntervalImpl(probeHandle)
      clearIntervalImpl(summaryHandle)
    },
    stats(): SyntheticProbeStats {
      const sorted = [...rtts].sort((a, b) => a - b)
      return {
        successCount,
        failureCount,
        consecutiveFailures,
        lastRttMs,
        p50: percentile(sorted, 50),
        p99: percentile(sorted, 99),
        windowSize: rtts.length,
      }
    },
  }
}
