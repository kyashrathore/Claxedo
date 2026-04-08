// ============================================================================
// Reattach recovery scheduler with throttle + retry
// ============================================================================
// Fixes the blank-terminal-on-tab-switch bug: when recovery fires within the
// throttle window, the call was previously dropped silently. Now it schedules
// a retry for the remaining window so the terminal recovers automatically.

interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

interface Raf {
  request(fn: () => void): number
  cancel(id: number): void
}

export interface ReattachRecoveryScheduler {
  schedule(forceResize: boolean): void
  dispose(): void
}

export function createReattachRecoveryScheduler(opts: {
  runRecovery: (forceResize: boolean) => void
  raf: Raf
  clock: Clock
  throttleMs?: number
}): ReattachRecoveryScheduler {
  const { runRecovery, raf, clock, throttleMs = 120 } = opts

  let lastRunAt = -Infinity
  let rafId: number | null = null
  let retryId: number | null = null
  let retryForceResize = false
  let disposed = false

  function tryRun(forceResize: boolean): void {
    if (disposed) return

    const now = clock.now()
    const elapsed = now - lastRunAt

    if (elapsed >= throttleMs) {
      // Within allowed window — run immediately
      lastRunAt = now
      if (retryId !== null) {
        clock.clearTimeout(retryId)
        retryId = null
      }
      runRecovery(forceResize)
    } else {
      // Throttled — schedule a single retry for the remaining window.
      // Multiple throttled calls coalesce: once a retry is pending, later
      // calls only update the forceResize flag but don't add more timeouts.
      retryForceResize = retryForceResize || forceResize

      if (retryId === null) {
        const remaining = throttleMs - elapsed
        retryId = clock.setTimeout(() => {
          retryId = null
          if (disposed) return
          const fr = retryForceResize
          retryForceResize = false
          rafId = raf.request(() => {
            rafId = null
            tryRun(fr)
          })
        }, remaining + 1)
      }
    }
  }

  return {
    schedule(forceResize: boolean): void {
      if (disposed) return
      if (rafId !== null) {
        raf.cancel(rafId)
        rafId = null
      }
      rafId = raf.request(() => {
        rafId = null
        tryRun(forceResize)
      })
    },

    dispose(): void {
      disposed = true
      if (rafId !== null) {
        raf.cancel(rafId)
        rafId = null
      }
      if (retryId !== null) {
        clock.clearTimeout(retryId)
        retryId = null
      }
    },
  }
}
