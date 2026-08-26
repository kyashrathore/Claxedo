import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export const DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS = 100
export const DIRECTORY_RESOURCE_IDLE_TIMEOUT_MS = 1_000

type ScheduleToken = ReturnType<typeof setTimeout> | number

/**
 * Keep directory metadata refreshes out of a session activation's first paint.
 *
 * Consumers still mount their canonical TanStack query observer immediately,
 * with `enabled: false`, so a cache hit remains synchronously readable. Only a
 * stale/missing network refresh waits for the activation-relative delay, one
 * rendering opportunity, and an idle task. Scope changes, deactivation, and
 * owner disposal cancel every pending stage.
 */
export function createDeferredDirectoryResourceGate(input: {
  scope: Accessor<string | undefined>
  active?: Accessor<boolean>
  delayMs?: number | Accessor<number>
  /** Set false when the delay itself is already relative to a completed first-paint quiet window. */
  afterPaint?: boolean
  schedule?: (callback: () => void, delay: number) => ScheduleToken
  cancel?: (token: ScheduleToken) => void
  scheduleFrame?: (callback: () => void) => ScheduleToken
  cancelFrame?: (token: ScheduleToken) => void
  scheduleIdle?: (callback: () => void) => ScheduleToken
  cancelIdle?: (token: ScheduleToken) => void
}) {
  const [enabled, setEnabled] = createSignal(false)
  const schedule = input.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const cancel = input.cancel ?? ((token) => clearTimeout(token))
  const scheduleFrame =
    input.scheduleFrame ??
    ((callback) => {
      if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback)
      return setTimeout(callback, 16)
    })
  const cancelFrame =
    input.cancelFrame ??
    ((token) => {
      if (typeof cancelAnimationFrame === "function" && typeof token === "number") cancelAnimationFrame(token)
      else clearTimeout(token)
    })
  const scheduleIdle =
    input.scheduleIdle ??
    ((callback) => {
      if (typeof requestIdleCallback === "function") {
        return requestIdleCallback(callback, { timeout: DIRECTORY_RESOURCE_IDLE_TIMEOUT_MS })
      }
      return setTimeout(callback, 0)
    })
  const cancelIdle =
    input.cancelIdle ??
    ((token) => {
      if (typeof cancelIdleCallback === "function" && typeof token === "number") cancelIdleCallback(token)
      else clearTimeout(token)
    })

  createEffect(
    // A fresh object on purpose: the Solid 1 body re-ran on every invalidation
    // of these three reads, and the schedule must restart each time.
    () => ({
      scope: input.scope(),
      active: input.active?.() ?? true,
      delay: typeof input.delayMs === "function" ? input.delayMs() : input.delayMs,
    }),
    ({ scope, active, delay }) => {
      setEnabled(false)
      if (!scope || !active) return

      let frame: ScheduleToken | undefined
      let idle: ScheduleToken | undefined
      const timer = schedule(() => {
        if (input.afterPaint === false) {
          setEnabled(true)
          return
        }
        frame = scheduleFrame(() => {
          frame = undefined
          idle = scheduleIdle(() => {
            idle = undefined
            setEnabled(true)
          })
        })
      }, delay ?? DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS)

      return () => {
        cancel(timer)
        if (frame !== undefined) cancelFrame(frame)
        if (idle !== undefined) cancelIdle(idle)
      }
    },
  )

  return enabled
}
