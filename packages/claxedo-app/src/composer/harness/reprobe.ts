export const HARNESS_REPROBE_INTERVAL_MS = 1500

export const HARNESS_REPROBE_MAX_ATTEMPTS = 40

export type ReprobeScheduler = (handler: () => void, ms: number) => () => void

const defaultScheduler: ReprobeScheduler = (handler, ms) => {
  const id = setTimeout(handler, ms)
  return () => clearTimeout(id)
}

export type HarnessReprobeLoop = {
  cancel: () => void
}

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
