// Heartbeat watchdog extracted from context/global-sdk.tsx. Each delivered SSE
// event calls `reset()`, which restarts a single timeout; if no event arrives
// within `timeoutMs` the timeout fires `onTimeout` (which aborts the stream so
// the reconnect loop re-opens it). `sinceLastEvent()` backs the
// visibility-change quick-check. Timer/clock injectable for fake-timer tests.

type TimerHandle = ReturnType<typeof setTimeout>

export function createHeartbeatWatchdog(options: {
  timeoutMs: number
  onTimeout: () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))

  let lastEventAt = now()
  let handle: TimerHandle | undefined

  const reset = () => {
    lastEventAt = now()
    if (handle) clearTimer(handle)
    handle = setTimer(options.onTimeout, options.timeoutMs)
  }

  const clear = () => {
    if (!handle) return
    clearTimer(handle)
    handle = undefined
  }

  /** Record activity without (re)arming the timer — mirrors `lastEventAt = now()`. */
  const touch = () => {
    lastEventAt = now()
  }

  const sinceLastEvent = () => now() - lastEventAt

  return { reset, clear, touch, sinceLastEvent }
}
