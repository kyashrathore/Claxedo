type TimerToken = ReturnType<typeof setTimeout>

export const FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS = 100
export const ACCEPTED_PROMPT_RECONCILIATION_EARLIEST_MS = 100
export const TURN_SETTLEMENT_CATCH_UP_EARLIEST_MS = 100

export function activationRelativeDelay(input: {
  activationAt: number
  earliestMs: number
  requestedDelay?: number
  now?: number
}) {
  const now = input.now ?? Date.now()
  const earliestRemaining = Math.max(0, input.activationAt + input.earliestMs - now)
  return Math.max(earliestRemaining, input.requestedDelay ?? 0)
}

/**
 * Schedule activation-owned work once. The deadline is anchored to activation,
 * and both cancellation and a final ownership check prevent a retained pane
 * from publishing work after another session becomes active.
 */
export function scheduleActivationWork(input: {
  activationAt: number
  earliestMs: number
  requestedDelay?: number
  active: () => boolean
  run: () => void
  now?: () => number
  schedule?: (callback: () => void, delay: number) => TimerToken
  cancel?: (token: TimerToken) => void
}) {
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? clearTimeout
  let cancelled = false
  let completed = false
  const timer = schedule(() => {
    if (cancelled || completed || !input.active()) return
    completed = true
    input.run()
  }, activationRelativeDelay({
    activationAt: input.activationAt,
    earliestMs: input.earliestMs,
    requestedDelay: input.requestedDelay,
    now: (input.now ?? Date.now)(),
  }))
  return () => {
    cancelled = true
    cancel(timer)
  }
}
