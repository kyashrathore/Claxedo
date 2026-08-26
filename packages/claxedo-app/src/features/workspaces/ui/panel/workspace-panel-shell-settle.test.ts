import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createShellSettle, type ShellSettleMotion } from "./workspace-panel-shell-settle"

/**
 * Drives the gate's clocks by hand, so each test states exactly which frames,
 * idle slices and timers have happened. The gate's whole job is ordering, and
 * real timers would only make that ordering a race.
 */
function createClocks() {
  const frames: Array<FrameRequestCallback | undefined> = []
  const idles: Array<IdleRequestCallback | undefined> = []
  const timers: Array<{ run: () => void; delayMs: number } | undefined> = []
  const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    requestIdleCallback: globalThis.requestIdleCallback,
    cancelIdleCallback: globalThis.cancelIdleCallback,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  globalThis.requestAnimationFrame = (callback) => frames.push(callback)
  globalThis.cancelAnimationFrame = (handle) => {
    frames[handle - 1] = undefined
  }
  globalThis.requestIdleCallback = (callback) => idles.push(callback)
  globalThis.cancelIdleCallback = (handle) => {
    idles[handle - 1] = undefined
  }
  globalThis.setTimeout = (handler, timeout) =>
    timers.push({ run: () => { if (typeof handler === "function") handler() }, delayMs: timeout ?? 0 })
  globalThis.clearTimeout = (handle) => {
    if (typeof handle === "number") timers[handle - 1] = undefined
  }
  return {
    frame: () => {
      for (const callback of frames.splice(0, frames.length)) callback?.(0)
    },
    idle: () => {
      for (const callback of idles.splice(0, idles.length)) callback?.({ didTimeout: true, timeRemaining: () => 0 })
    },
    /** Delays the pending bounded fallbacks were armed with. */
    timerDelays: () => timers.flatMap((timer) => (timer ? [timer.delayMs] : [])),
    timer: () => {
      for (const timer of timers.splice(0, timers.length)) timer?.run()
    },
    restore: () => Object.assign(globalThis, original),
  }
}

/**
 * One animating element. A real element rather than a stub, so the gate's
 * listener registration and the `event.target` matching it depends on are
 * exercised for real.
 */
function motionElement(property: string) {
  const element = document.createElement("div")
  const emit = (kind: string, emitted = property) => {
    const event = new Event(kind)
    Object.defineProperty(event, "propertyName", { value: emitted })
    element.dispatchEvent(event)
  }
  const motion: ShellSettleMotion = { element, property }
  return { element, emit, motion }
}

/**
 * A gate on a shell that is already open. `kind` picks which arming the test
 * drives: the panel's own opening flip, or the retarget that follows it when
 * the content identity moves while the panel stays open. The two share every
 * bit of motion tracking and differ only in when the construction door opens,
 * so the motion tests below run against the retarget arming — the one whose
 * door the motion still gates.
 */
function mountGate(
  motions: () => ReadonlyArray<ShellSettleMotion | undefined>,
  kind: "open" | "retarget" = "retarget",
) {
  let dispose: VoidFunction = () => {}
  const [open] = createSignal(true)
  const [contentKey, setContentKey] = createSignal("a")
  const shell = document.createElement("aside")
  const gate = createRoot((disposer) => {
    dispose = disposer
    return createShellSettle({
      open,
      element: () => shell,
      motionMs: 120,
      motions,
      contentKey,
    })
  })
  if (kind === "retarget") setContentKey("b")
  return { ...gate, dispose }
}

let active: { dispose: VoidFunction } | undefined
let clocks: ReturnType<typeof createClocks> | undefined
afterEach(() => {
  active?.dispose()
  active = undefined
  clocks?.restore()
  clocks = undefined
})

describe("createShellSettle motion tracking", () => {
  test("holds the gate for a registered motion until that motion ends, not for two frames", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    // The open flip arms the gate, and the motion starts before the second
    // arming frame — same frame, transition events before frame callbacks.
    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()

    // Two painted frames are NOT the motion: the gate is still shut, and it
    // armed the bounded fallback rather than settling.
    expect(gate.settled()).toBe(false)
    expect(clocks.timerDelays()).toEqual([240])

    // Idle and the tail frame cannot open it either while the motion runs.
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(false)

    column.emit("transitionend")
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("opens on two frames when nothing animates, so a retarget is not delayed", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    clocks.frame()
    clocks.frame()
    // No motion began, so no bounded fallback was armed and the gate goes
    // straight to its idle slice.
    expect(clocks.timerDelays()).toEqual([])
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("waits for the LAST of several motions, not the first", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const shell = motionElement("transform")
    const gate = mountGate(() => [column.motion, shell.motion])
    active = gate

    clocks.frame()
    column.emit("transitionrun")
    shell.emit("transitionrun")
    clocks.frame()

    shell.emit("transitionend")
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(false)

    column.emit("transitionend")
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("ignores a transition on a property it is not tracking", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    clocks.frame()
    column.emit("transitionrun", "opacity")
    clocks.frame()

    // An untracked property is not the opening motion, so the gate takes the
    // no-motion path rather than waiting for it.
    expect(clocks.timerDelays()).toEqual([])
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("ignores the cancel of a transition it never saw start", () => {
    // Re-opening inside the closing motion cancels the close's transitions,
    // and those cancels arrive BEFORE the opening ones start. Reading them as
    // the open finishing is what let content construct inside the motion.
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    column.emit("transitioncancel")
    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()

    expect(gate.settled()).toBe(false)
    expect(clocks.timerDelays()).toEqual([240])

    column.emit("transitionend")
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("opens on the bounded fallback when the motion's end never arrives", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()
    expect(gate.settled()).toBe(false)

    // A display flip or a detach can swallow `transitionend`; the fallback is
    // the only thing that opens the gate then.
    clocks.timer()
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("a motion element that has not registered yet is simply not tracked", () => {
    clocks = createClocks()
    const gate = mountGate(() => [undefined, { element: undefined, property: "margin-right" }])
    active = gate

    clocks.frame()
    clocks.frame()
    clocks.idle()
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })

  test("an open constructs on the shell's two painted frames, not at the end of the motion", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion], "open")
    active = gate

    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()

    // The content door is open: the shell is on screen and the rest of the
    // move is a composited transform.
    expect(gate.settled()).toBe(true)
    // The shell itself has NOT settled — it is still moving.
    expect(gate.motionSettled()).toBe(false)

    column.emit("transitionend")
    expect(gate.motionSettled()).toBe(true)
  })

  test("an open reports its motion through the bounded fallback when transitionend is lost", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion], "open")
    active = gate

    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()
    expect(gate.motionSettled()).toBe(false)

    clocks.timer()
    expect(gate.motionSettled()).toBe(true)
    expect(gate.settled()).toBe(true)
  })

  test("a retarget keeps its door shut until the motion, an idle slice and one frame", () => {
    clocks = createClocks()
    const column = motionElement("margin-right")
    const gate = mountGate(() => [column.motion])
    active = gate

    clocks.frame()
    column.emit("transitionrun")
    clocks.frame()
    expect(gate.settled()).toBe(false)

    column.emit("transitionend")
    // The shell has settled the moment the motion ends; the door has not.
    expect(gate.motionSettled()).toBe(true)
    expect(gate.settled()).toBe(false)
    clocks.idle()
    expect(gate.settled()).toBe(false)
    clocks.frame()
    expect(gate.settled()).toBe(true)
  })
})
