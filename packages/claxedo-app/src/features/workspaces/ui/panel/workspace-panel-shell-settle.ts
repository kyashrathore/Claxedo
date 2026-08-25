import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

/**
 * How long the gate waits for an idle main thread once the shell has painted.
 * A thread that never goes idle still gets its content; it just gets it last.
 */
const SETTLE_IDLE_TIMEOUT_MS = 400

/**
 * One transitioning property that carries part of the panel's opening motion.
 * Each is declared by whoever OWNS the animating element, because only that
 * owner knows which property its CSS actually animates.
 */
export type ShellSettleMotion = {
  element: HTMLElement | undefined
  /** As `TransitionEvent.propertyName` reports it, e.g. `"margin-right"`. */
  property: string
}

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
 *  1. the opening motion — every transition in `motions` that actually began,
 *     to its end; two animation frames are the whole wait only when none did;
 *  2. one idle slice, bounded by `SETTLE_IDLE_TIMEOUT_MS` — proof that nothing
 *     else still needs the thread;
 *  3. one more animation frame — so whatever was waiting on that free thread
 *     (the destination session's first painted frame) presents BEFORE the
 *     panel body's construction takes the thread back.
 *
 * Step 1 tracks a SET of motions because the open animates two elements and
 * neither one alone is the motion. The shell's transform only transitions when
 * the shell was already mounted at its closed transform (a re-open); a shell
 * mounted BY the opening click renders at its resting transform, so no
 * transform transition runs at all and the gate treated two painted frames —
 * ~32ms — as the whole 120ms open. The workbench column's margin is what moves
 * on every open, fresh or repeat, which is why its owner registers it here.
 */
export function createShellSettle(input: {
  open: () => boolean
  element: () => HTMLElement | undefined
  motionMs: number
  /**
   * Every element/property pair the open animates. Read once per arming, and
   * deliberately not reactive: a ref registering must not re-arm the gate.
   */
  motions: () => ReadonlyArray<ShellSettleMotion | undefined>
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
    const motions = input.motions().filter(
      (motion): motion is ShellSettleMotion & { element: HTMLElement } => !!motion?.element,
    )
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof requestIdleCallback> | undefined
    // Properties whose transition THIS arming saw start. Membership, not a
    // count: re-opening inside the closing motion cancels the close's
    // transitions, and those `transitioncancel`s arrive BEFORE the opening
    // ones start. They are not this motion's, so they must not end it.
    const running = new Set<string>()
    const detachMotion = () => {
      for (const motion of motions) {
        motion.element.removeEventListener("transitionrun", onRun)
        motion.element.removeEventListener("transitionend", onEnd)
        motion.element.removeEventListener("transitioncancel", onEnd)
      }
    }
    const cleanup = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timer) clearTimeout(timer)
      if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle)
      frame = undefined
      timer = undefined
      idle = undefined
      detachMotion()
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
      // The motion is over; a later transition on these elements (a width
      // change, the closing move) is not this arming's business.
      detachMotion()
      if (typeof requestIdleCallback !== "function") {
        openGate()
        return
      }
      idle = requestIdleCallback(() => {
        idle = undefined
        openGate()
      }, { timeout: SETTLE_IDLE_TIMEOUT_MS })
    }
    const tracks = (event: TransitionEvent) =>
      motions.some((motion) => event.target === motion.element && event.propertyName === motion.property)
    const onRun = (event: TransitionEvent) => {
      if (tracks(event)) running.add(event.propertyName)
    }
    // The open animates two elements; the motion is over when the last of the
    // ones that started has finished, not the first.
    const onEnd = (event: TransitionEvent) => {
      if (!tracks(event) || !running.delete(event.propertyName)) return
      if (running.size === 0) settleMotion()
    }
    cancel = cleanup
    for (const motion of motions) {
      motion.element.addEventListener("transitionrun", onRun)
      motion.element.addEventListener("transitionend", onEnd)
      motion.element.addEventListener("transitioncancel", onEnd)
    }
    // Step 1: the opening motion.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (running.size === 0) {
          // Nothing animated: a retarget moves no box, so two painted frames
          // are the whole motion.
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
