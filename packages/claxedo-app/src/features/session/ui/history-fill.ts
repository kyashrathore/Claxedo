type ScheduleToken = ReturnType<typeof setTimeout> | number

export const HISTORY_FILL_EARLIEST_MS = 100
export const HISTORY_FILL_IDLE_TIMEOUT_MS = 1_000

type Input = {
  eligible: () => boolean
  reveal: () => void
  now?: () => number
  scheduleTimer?: (callback: () => void, delay: number) => ScheduleToken
  cancelTimer?: (token: ScheduleToken) => void
  scheduleFrame?: (callback: () => void) => ScheduleToken
  cancelFrame?: (token: ScheduleToken) => void
  scheduleIdle?: (callback: () => void) => ScheduleToken
  cancelIdle?: (token: ScheduleToken) => void
}

/**
 * Schedules the timeline's automatic "there is not enough content to scroll"
 * reveal.
 *
 * This path is deliberately separate from explicit upward scrolling, which
 * continues to load history immediately. Automatic fill is activation-owned:
 * it cannot read older messages during the first-paint budget, and changing or
 * deactivating the session cancels every outstanding timer/frame/idle callback.
 *
 * Once the activation deadline passes, the height decision is confirmed across
 * two consecutive frames. The measurement it depends on (`scrollHeight`) is
 * only as current as the last virtualizer pass; a check between "the message
 * list grew" and "the virtualizer re-measured" otherwise reads the old, shorter
 * list and can collapse an already-established render window. A final idle
 * opportunity keeps the resulting history read and hydration out of the frame
 * that confirmed the viewport is still short.
 */
export function createHistoryFill(input: Input) {
  const now = input.now ?? Date.now
  const scheduleTimer = input.scheduleTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const cancelTimer = input.cancelTimer ?? ((token) => clearTimeout(token))
  const scheduleFrame = input.scheduleFrame ?? ((callback) => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback)
    return setTimeout(callback, 16)
  })
  const cancelFrame = input.cancelFrame ?? ((token) => {
    if (typeof cancelAnimationFrame === "function" && typeof token === "number") cancelAnimationFrame(token)
    else clearTimeout(token)
  })
  const scheduleIdle = input.scheduleIdle ?? ((callback) => {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(callback, { timeout: HISTORY_FILL_IDLE_TIMEOUT_MS })
    }
    return setTimeout(callback, 0)
  })
  const cancelIdle = input.cancelIdle ?? ((token) => {
    if (typeof cancelIdleCallback === "function" && typeof token === "number") cancelIdleCallback(token)
    else clearTimeout(token)
  })

  let activationKey: string | undefined
  let activationAt = 0
  let generation = 0
  let timer: ScheduleToken | undefined
  let frame: ScheduleToken | undefined
  let idle: ScheduleToken | undefined

  const clearScheduled = () => {
    if (timer !== undefined) cancelTimer(timer)
    if (frame !== undefined) cancelFrame(frame)
    if (idle !== undefined) cancelIdle(idle)
    timer = undefined
    frame = undefined
    idle = undefined
  }

  const owns = (key: string, ownerGeneration: number) =>
    activationKey === key && generation === ownerGeneration

  const activate = (key: string | undefined) => {
    if (key === activationKey) return
    generation += 1
    clearScheduled()
    activationKey = key
    activationAt = now()
  }

  const schedule = () => {
    const key = activationKey
    if (!key || timer !== undefined || frame !== undefined || idle !== undefined) return

    const ownerGeneration = generation
    timer = scheduleTimer(() => {
      timer = undefined
      if (!owns(key, ownerGeneration) || !input.eligible()) return

      frame = scheduleFrame(() => {
        frame = undefined
        if (!owns(key, ownerGeneration) || !input.eligible()) return

        frame = scheduleFrame(() => {
          frame = undefined
          if (!owns(key, ownerGeneration) || !input.eligible()) return

          idle = scheduleIdle(() => {
            idle = undefined
            if (!owns(key, ownerGeneration) || !input.eligible()) return
            input.reveal()
          })
        })
      })
    }, Math.max(0, activationAt + HISTORY_FILL_EARLIEST_MS - now()))
  }

  const cancel = () => {
    generation += 1
    clearScheduled()
    activationKey = undefined
  }

  return { activate, schedule, cancel }
}
