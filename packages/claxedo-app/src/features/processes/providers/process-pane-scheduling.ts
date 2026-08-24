// Scheduling helpers for the process pane, split out of process-pane.tsx.
//
//  - afterVisibleWork: defer non-critical work off the first-paint hot path.
//  - createWakeDetector: detect system sleep (setInterval time-gap) plus a
//    visibilitychange fast-path, and re-reconcile on wake.
//
// Both return a disposer the caller wires into onCleanup.

export function afterVisibleWork(callback: () => void): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined
  let idle: ReturnType<typeof requestIdleCallback> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    // Process reconciliation is useful sidebar data, not session-paint data.
    // A bare idle callback commonly fires in the first gap after a surface
    // mounts and competes with its transcript request. Keep a small explicit
    // grace period before asking for idle time so immediate user navigation
    // owns the local runtime first.
    timer = setTimeout(() => {
      timer = undefined
      const schedule = () => {
        if (cancelled) return
        callback()
      }
      if (typeof requestIdleCallback === "function") {
        idle = requestIdleCallback(schedule, { timeout: 1_200 })
        return
      }
      schedule()
    }, 250)
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
    if (timer) clearTimeout(timer)
  }
}

const TICK_INTERVAL = 10_000 // check every 10s
const SLEEP_THRESHOLD = 30_000 // >30s gap = sleep detected

/**
 * Detect a system sleep/resume (interval time-gap) or a tab becoming visible
 * again, and fire `onWake` when `shouldReconcile()` allows. Returns a disposer
 * that clears the interval and removes the visibilitychange listener.
 */
export function createWakeDetector(input: { onWake: () => void; shouldReconcile: () => boolean }): () => void {
  let lastTick = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined

  // The interval exists only to catch a sleep that happens while the tab is
  // visible; a hidden tab gets the visibilitychange fast-path on return, so
  // ticking while hidden is pure idle CPU. Pause it and restart on reveal.
  const startTicking = () => {
    if (timer !== undefined) return
    lastTick = Date.now()
    timer = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (gap > SLEEP_THRESHOLD && input.shouldReconcile()) {
        input.onWake()
      }
    }, TICK_INTERVAL)
  }
  const stopTicking = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      startTicking()
      if (input.shouldReconcile()) input.onWake()
      return
    }
    stopTicking()
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
  if (document.visibilityState === "visible") startTicking()

  return () => {
    stopTicking()
    document.removeEventListener("visibilitychange", onVisibilityChange)
  }
}
