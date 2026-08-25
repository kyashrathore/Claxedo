import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

/**
 * How long the gate waits for an idle main thread once the shell has painted.
 * A thread that never goes idle still gets its content; it just gets it last.
 */
const SETTLE_IDLE_TIMEOUT_MS = 400

/**
 * The panel's door for constructing content: it opens once the interaction that
 * asked for that content has finished owning the main thread.
 *
 * Two things arm it, because both are interactions whose frames belong to
 * something other than the panel body:
 *  - `open` flipping — the toggle's opening motion, so every open defers
 *    content again;
 *  - `contentKey` changing while the panel stays open — a retarget, where the
 *    frames belong to the surface the user actually clicked (typically a
 *    session in another workspace). Without this the gate stayed stale-true and
 *    the entire destination subtree was constructed inside the click task.
 *
 * Once armed it waits, in order:
 *  1. two animation frames, plus any transform transition that began — the
 *     shell's own motion;
 *  2. one idle slice, bounded by `SETTLE_IDLE_TIMEOUT_MS` — proof that nothing
 *     else still needs the thread;
 *  3. one more animation frame — so whatever was waiting on that free thread
 *     (the destination session's first painted frame) presents BEFORE the
 *     panel body's construction takes the thread back.
 */
export function createShellSettle(input: {
  open: () => boolean
  element: () => HTMLElement | undefined
  motionMs: number
  /** Identity of the content the shell holds; a change re-arms the gate. */
  contentKey?: () => string
}) {
  // The generation is a pure derivation of the gate's inputs — every open flip
  // and every identity change is a new one — so `settled` falls to false in the
  // same update phase the change lands in, before any effect reads it. Only the
  // FINISHED generation is signal state, and it is written from frame, idle and
  // transition callbacks.
  const generation = createMemo<number>((previous = 0) => {
    input.open()
    input.contentKey?.()
    return previous + 1
  })
  const [finishedGeneration, setFinishedGeneration] = createSignal(-1)
  let cancel: VoidFunction | undefined

  const arm = (armedGeneration: number) => {
    const element = input.element()
    if (!element || typeof requestAnimationFrame !== "function") {
      // No shell box or no frame scheduler: deferral is a paint concern and
      // there is nothing to paint against.
      setFinishedGeneration(armedGeneration)
      return
    }
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof requestIdleCallback> | undefined
    let sawTransition = false
    const cleanup = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timer) clearTimeout(timer)
      if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
      frame = undefined
      timer = undefined
      idle = undefined
      element.removeEventListener("transitionrun", onRun)
      element.removeEventListener("transitionend", onEnd)
      element.removeEventListener("transitioncancel", onEnd)
      cancel = undefined
    }
    // Step 3: the free thread's first frame belongs to whatever was waiting for
    // it, not to the panel body.
    const openGate = () => {
      frame = requestAnimationFrame(() => {
        cleanup()
        setFinishedGeneration(armedGeneration)
      })
    }
    // Step 2: a painted frame is not the same as a free thread. On a retarget
    // the frames right after the click belong to the destination SESSION — its
    // first-fold reveal and timeline layout — so opening on the next animation
    // frame alone would just move the body's construction one frame later.
    const settleMotion = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (timer) clearTimeout(timer)
      timer = undefined
      if (typeof requestIdleCallback !== "function") {
        openGate()
        return
      }
      idle = requestIdleCallback(() => {
        idle = undefined
        openGate()
      }, { timeout: SETTLE_IDLE_TIMEOUT_MS })
    }
    const onRun = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") sawTransition = true
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") settleMotion()
    }
    cancel = cleanup
    element.addEventListener("transitionrun", onRun)
    element.addEventListener("transitionend", onEnd)
    element.addEventListener("transitioncancel", onEnd)
    // Step 1: the shell's own motion.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!sawTransition) {
          // A fresh mount opens at its resting transform, so no transition
          // runs: two painted frames are the whole motion.
          settleMotion()
          return
        }
        // transitionend can be lost to a display flip or detach: bound the wait.
        timer = setTimeout(settleMotion, input.motionMs + 120)
      })
    })
  }

  createEffect(on([generation, input.open], ([armedGeneration, open]) => {
    cancel?.()
    if (!open) return
    arm(armedGeneration)
  }))
  onCleanup(() => cancel?.())

  const settled = createMemo(() => input.open() && finishedGeneration() === generation())
  return { settled }
}
