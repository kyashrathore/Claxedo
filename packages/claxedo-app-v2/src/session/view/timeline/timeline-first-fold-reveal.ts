/**
 * Finish a cold timeline's synchronous first-fold mount before the browser's
 * next paint. Solid has committed the rows when this microtask runs, so the
 * virtual measurements and bottom anchor can settle without deliberately
 * hiding an otherwise ready surface for another animation frame.
 *
 * The activation key and cancellation flag prevent a retained surface's queued
 * task from revealing or scrolling a different session.
 */
export function scheduleTimelineFirstFoldReveal(input: {
  activationKey: string
  currentActivationKey: () => string
  prepare: () => void
  reveal: () => void
  scheduleTask?: (callback: () => void) => void
}) {
  const scheduleTask = input.scheduleTask ?? queueMicrotask
  let cancelled = false
  scheduleTask(() => {
    if (cancelled) return
    if (input.currentActivationKey() !== input.activationKey) return
    input.prepare()
    if (cancelled) return
    if (input.currentActivationKey() !== input.activationKey) return
    input.reveal()
  })
  return () => {
    cancelled = true
  }
}
