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
 * Two observables of one opening, kept apart because they answer different
 * questions and only one of them is a schedule.
 *
 * `motionSettled` is a FACT about the shell: every transition in `motions` that
 * this arming saw start has ended, so the opening motion is over. It is what
 * the shell reports to anything asking whether it has finished moving, and it
 * says nothing about content.
 *
 * `settled` is the door for CONSTRUCTING content. Two things arm both, because
 * both are interactions whose frames belong to something other than the panel
 * body:
 *  - `open` flipping — the toggle opening the panel;
 *  - `contentKey` changing while the panel stays open — a retarget, where the
 *    frames belong to the surface the user actually clicked (typically a
 *    session in another workspace). Without this the gate stayed stale-true and
 *    the entire destination subtree was constructed inside the click task.
 *
 * The door opens on a different schedule for each, because the frames after the
 * click belong to different things:
 *  - a RETARGET waits, in order, for (1) the motion, (2) one idle slice bounded
 *    by `SETTLE_IDLE_TIMEOUT_MS` — proof that nothing else still needs the
 *    thread, and (3) one more animation frame, so whatever was waiting on that
 *    free thread (the destination session's first painted frame) presents
 *    BEFORE the panel body's construction takes the thread back;
 *  - an OPEN waits for the shell's own two painted frames and no longer. There
 *    is no destination session competing for those frames: the shell the click
 *    just revealed is empty, the content is the entire point of the press, and
 *    the rest of the motion is a composited transform that a bounded
 *    construction does not stutter. Holding an open for the whole motion buys
 *    the user 120ms of skeleton in a panel that is already on screen.
 *
 * Motion tracking follows a SET of motions because the open animates two
 * elements and neither one alone is the motion. The shell's transform only
 * transitions when the shell was already mounted at its closed transform (a
 * re-open); a shell mounted BY the opening click renders at its resting
 * transform, so no transform transition runs at all. The workbench column's
 * margin is what moves on every open, fresh or repeat, which is why its owner
 * registers it here.
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
  const [motionGeneration, setMotionGeneration] = createSignal(-1)
  let cancel: VoidFunction | undefined

  const arm = (armedGeneration: number, kind: "open" | "retarget") => {
    const element = input.element()
    if (!element || typeof requestAnimationFrame !== "function") {
      // No shell box or no frame scheduler: deferral is a paint concern and
      // there is nothing to paint against.
      setMotionGeneration(armedGeneration)
      setFinishedGeneration(armedGeneration)
      return
    }
    const motions = input.motions().filter(
      (motion): motion is ShellSettleMotion & { element: HTMLElement } => !!motion?.element,
    )
    let frame: number | undefined
    let openFrame: number | undefined
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
      if (openFrame !== undefined) cancelAnimationFrame(openFrame)
      openFrame = undefined
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
      setMotionGeneration(armedGeneration)
      if (kind === "open") {
        // An open's door is already open; the motion ending only settles the
        // shell, and there is nothing left for this arming to wait for.
        cleanup()
        return
      }
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
    if (kind === "open") {
      // Two painted frames are the shell's own reveal. The construction door
      // opens on them; the motion listeners below keep running so
      // `motionSettled` still reports the real end of the movement.
      openFrame = requestAnimationFrame(() => {
        openFrame = requestAnimationFrame(() => {
          openFrame = undefined
          setFinishedGeneration(armedGeneration)
        })
      })
    }
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

  // An arming is an OPEN when this flip is what opened the panel, and a
  // RETARGET when the panel was already open and its content identity moved.
  let wasOpen = false
  createEffect(on([generation, input.open], ([armedGeneration, open]) => {
    cancel?.()
    const kind = open && wasOpen ? "retarget" : "open"
    wasOpen = open
    if (!open) return
    arm(armedGeneration, kind)
  }))
  onCleanup(() => cancel?.())

  const settled = createMemo(() => input.open() && finishedGeneration() === generation())
  const motionSettled = createMemo(() => input.open() && motionGeneration() === generation())
  return { settled, motionSettled }
}
