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
