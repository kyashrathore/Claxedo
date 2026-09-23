//
// Bounded re-probe loop for a harness stuck in the "polling" (Connecting)
// readiness. Harness hydration (`harness-hydrator.ts`) is one-shot: it stamps a
// per-scope "seen" key and early-returns forever after, so a genuinely slow
// harness that first answers `ready:false` (backend `status:"applying"`) never
// gets re-probed and the composer stays gated on the "Connecting" pill
// indefinitely. This loop drives a periodic re-probe while polling and, if the
// harness never settles, gives up after a hard cap and hands control back to the
// caller to surface the "Unavailable" affordance — never infinite, never silent.
//
// Framework-agnostic on purpose (no solid-js) so it is exhaustively unit-testable
// with injected timers. The reactive wiring (start only while polling, cancel on
// scope/route change) lives in the UI layer's `watchHarnessReprobe`.

/** Interval between re-probe attempts while a harness stays in polling. */
export const HARNESS_REPROBE_INTERVAL_MS = 1500

/**
 * Maximum re-probe attempts before giving up. 40 attempts × 1.5s ≈ 60s: a slow
 * harness gets a full minute to settle, then the loop transitions to "error"
 * rather than polling forever.
 */
export const HARNESS_REPROBE_MAX_ATTEMPTS = 40

/**
 * Injectable scheduler: run `handler` after `ms`, returning a canceller that
 * un-schedules it. Defaults to `setTimeout`/`clearTimeout`; tests hand-crank it.
 * Returning a closure (rather than a raw timer handle) keeps the platform's
 * `setTimeout` return type contained here — no `number` vs `Timeout` casts leak
 * into callers or tests.
 */
export type ReprobeScheduler = (handler: () => void, ms: number) => () => void

const defaultScheduler: ReprobeScheduler = (handler, ms) => {
  const id = setTimeout(handler, ms)
  return () => clearTimeout(id)
}

export type HarnessReprobeLoop = {
  /** Idempotently stop the loop; safe to call after exhaustion. */
  cancel: () => void
}

/**
 * Start a bounded, self-cancelling re-probe loop. Each tick (spaced `intervalMs`
 * apart, the first tick one interval AFTER start — never synchronously) invokes
 * `onReprobe(attempt)` until `maxAttempts` re-probes have fired, after which one
 * final tick invokes `onExhausted()` and the loop stops. `cancel()` halts it at
 * any point with no further callbacks.
 */
export function startHarnessReprobeLoop(input: {
  onReprobe: (attempt: number) => void
  onExhausted: () => void
  intervalMs?: number
  maxAttempts?: number
  schedule?: ReprobeScheduler
}): HarnessReprobeLoop {
  const intervalMs = input.intervalMs ?? HARNESS_REPROBE_INTERVAL_MS
  const maxAttempts = input.maxAttempts ?? HARNESS_REPROBE_MAX_ATTEMPTS
  const schedule = input.schedule ?? defaultScheduler

  let attempts = 0
  let cancelled = false
  let cancelTimer: (() => void) | undefined

  const arm = () => {
    cancelTimer = schedule(tick, intervalMs)
  }

  function tick() {
    if (cancelled) return
    if (attempts >= maxAttempts) {
      input.onExhausted()
      return
    }
    attempts += 1
    input.onReprobe(attempts)
    arm()
  }

  arm()

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      cancelTimer?.()
    },
  }
}
