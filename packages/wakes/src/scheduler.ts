import type { Wakes } from "./wakes"

export interface Scheduler {
  start(): void
  stop(): void
}

/**
 * A long-lived-process driver for the `at` trigger: recover on start, then call
 * `runDue()` on an interval. Serverless deployments skip this and drive `runDue`
 * from a platform cron hitting an endpoint instead.
 */
export function createScheduler(
  wakes: Wakes,
  opts?: { intervalMs?: number; onError?: (e: unknown) => void },
): Scheduler {
  const intervalMs = opts?.intervalMs ?? 1000
  let handle: ReturnType<typeof setInterval> | null = null
  let running = false

  async function tick(): Promise<void> {
    if (running) return // never overlap ticks
    running = true
    try {
      await wakes.runDue()
    } catch (e) {
      opts?.onError?.(e)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (handle) return
      void wakes
        .recover()
        .then(tick)
        .catch((e) => opts?.onError?.(e))
      handle = setInterval(() => void tick(), intervalMs)
    },
    stop() {
      if (handle) {
        clearInterval(handle)
        handle = null
      }
    },
  }
}
