import type { Wakes } from "./wakes"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
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
  let recovering = false
  let pending: Promise<void> = Promise.resolve()
  let generation = 0

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
      const current = ++generation
      recovering = true
      pending = wakes
        .recover()
        .then(() => {
          if (current === generation) return tick()
        })
        .catch((e) => opts?.onError?.(e))
        .finally(() => {
          recovering = false
        })
      handle = setInterval(() => {
        if (!running && !recovering) pending = tick()
      }, intervalMs)
    },
    async stop() {
      generation++
      if (handle) {
        clearInterval(handle)
        handle = null
      }
      await pending
    },
  }
}
