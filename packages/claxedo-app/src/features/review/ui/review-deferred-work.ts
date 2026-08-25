import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"

/**
 * Run `callback` once the surface has finished the work the user can see.
 *
 * The review surface starts two kinds of load. One paints: an expanded row's
 * diff, the corpus itself. The other does not — a large-diff guard pane's
 * content, VCS metadata — and starting it inside the interaction that revealed
 * it charges that interaction for a fetch nothing on screen is waiting for.
 *
 * The sequence is deliberate: a frame so the revealing render paints first,
 * then idle time (bounded, so a permanently busy page still gets there), then
 * whatever network-quiet window a fast session switch has reserved. Returns a
 * disposer for `onCleanup`; cancelling before any stage fires runs nothing.
 */
export function afterVisibleWork(callback: () => void) {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined
  let idle: ReturnType<typeof requestIdleCallback> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    const schedule = () => {
      if (cancelled) return
      callback()
    }
    if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(() => {
        timer = setTimeout(schedule, fastSessionSwitchAnyQuietDelay())
      }, { timeout: 1_200 })
      return
    }
    timer = setTimeout(schedule, fastSessionSwitchAnyQuietDelay({ baseDelay: 120 }))
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
    if (timer) clearTimeout(timer)
  }
}
