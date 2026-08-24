import {
  FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  fastSessionSwitchQuietDelay,
} from "@/platform/runtime/session-switch"

type TimerToken = ReturnType<typeof setTimeout>
type FrameToken = number

export function scheduleTimelineProgressiveRelease(input: {
  sessionID?: string
  activationKey: string
  currentActivationKey: () => string
  release: () => void
  now?: number
  scheduleTimer?: (callback: () => void, delay: number) => TimerToken
  cancelTimer?: (token: TimerToken) => void
  scheduleFrame?: (callback: () => void) => FrameToken
  cancelFrame?: (token: FrameToken) => void
}) {
  const scheduleTimer = input.scheduleTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const cancelTimer = input.cancelTimer ?? clearTimeout
  const scheduleFrame = input.scheduleFrame ?? requestAnimationFrame
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame
  let timer: TimerToken | undefined
  let frame: FrameToken | undefined

  timer = scheduleTimer(() => {
    timer = undefined
    frame = scheduleFrame(() => {
      frame = undefined
      if (input.currentActivationKey() !== input.activationKey) return
      input.release()
    })
  }, fastSessionSwitchQuietDelay({
    sessionId: input.sessionID,
    now: input.now,
    baseDelay: FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  }))

  return () => {
    if (timer !== undefined) cancelTimer(timer)
    if (frame !== undefined) cancelFrame(frame)
    timer = undefined
    frame = undefined
  }
}
