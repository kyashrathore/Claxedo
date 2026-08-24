import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

/**
 * Tracks when the panel shell's opening motion has settled. The toggle
 * interaction owns its frames: content construction waits until the shell has
 * painted (two frames) and any transform transition that began has ended.
 * Closing advances the generation, so every open defers content again.
 */
export function createShellSettle(input: {
  open: () => boolean
  element: () => HTMLElement | undefined
  motionMs: number
}) {
  // The settle signal is written only from frame/transition callbacks; the
  // open/close effect just arms and cancels. `settled` derives from both.
  let generation = 0
  const [finishedGeneration, setFinishedGeneration] = createSignal(-1)
  let cancel: VoidFunction | undefined

  const arm = () => {
    cancel?.()
    const armedGeneration = generation
    const element = input.element()
    if (!element || typeof requestAnimationFrame !== "function") {
      // No shell box or no frame scheduler: deferral is a paint concern and
      // there is nothing to paint against.
      setFinishedGeneration(armedGeneration)
      return
    }
    let frameOne: number | undefined
    let frameTwo: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let sawTransition = false
    const cleanup = () => {
      if (frameOne !== undefined) cancelAnimationFrame(frameOne)
      if (frameTwo !== undefined) cancelAnimationFrame(frameTwo)
      if (timer) clearTimeout(timer)
      element.removeEventListener("transitionrun", onRun)
      element.removeEventListener("transitionend", onEnd)
      element.removeEventListener("transitioncancel", onEnd)
      cancel = undefined
    }
    const finish = () => {
      cleanup()
      setFinishedGeneration(armedGeneration)
    }
    const onRun = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") sawTransition = true
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") finish()
    }
    cancel = cleanup
    element.addEventListener("transitionrun", onRun)
    element.addEventListener("transitionend", onEnd)
    element.addEventListener("transitioncancel", onEnd)
    frameOne = requestAnimationFrame(() => {
      frameOne = undefined
      frameTwo = requestAnimationFrame(() => {
        frameTwo = undefined
        if (!sawTransition) {
          // A fresh mount opens at its resting transform, so no transition
          // runs: two painted frames are the whole motion.
          finish()
          return
        }
        // transitionend can be lost to a display flip or detach: bound the wait.
        timer = setTimeout(finish, input.motionMs + 120)
      })
    })
  }

  createEffect(on(input.open, (open) => {
    if (!open) {
      generation += 1
      cancel?.()
      return
    }
    arm()
  }))
  onCleanup(() => cancel?.())

  const settled = createMemo(() => input.open() && finishedGeneration() === generation)
  return { settled }
}
