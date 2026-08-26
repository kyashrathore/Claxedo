import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal, flush } from "solid-js"
import { createPanelBodyHydration } from "./workspace-panel-body-hydration"

/**
 * Drives the frame clock by hand, so each test states exactly which frames
 * have been painted. The door's whole job is ordering, and a real frame clock
 * would only make that ordering a race.
 */
function createFrames() {
  const callbacks: Array<FrameRequestCallback | undefined> = []
  const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback)
  globalThis.cancelAnimationFrame = (handle) => {
    callbacks[handle - 1] = undefined
  }
  return {
    paint: () => {
      for (const callback of callbacks.splice(0, callbacks.length)) callback?.(0)
      // A painted frame writes the door signal; the effect that reacts to it is
      // queued, not run inline, so the frame is not really over until the queue
      // has drained. See the `flush` note on `mountDoor`.
      flush()
    },
    /** Callbacks still armed — an orphaned schedule shows up here. */
    pending: () => callbacks.filter((callback) => callback !== undefined).length,
    restore: () => Object.assign(globalThis, original),
  }
}

/**
 * Mounts the door and drains the effect queue, so every assertion below reads a
 * settled door rather than a half-scheduled one.
 *
 * Solid 2 runs a user effect's apply phase on a queue rather than inline with
 * the write that dirtied it, so a `setReady` and the arming it causes are two
 * separate turns. Every test here is about ORDERING — which frame the second
 * chunk is allowed to run in — so each mutation flushes before it is measured;
 * otherwise the tests would be timing the effect queue instead of the frames.
 */
function mountDoor(initial = true) {
  let dispose: VoidFunction = () => {}
  const [ready, setReadySignal] = createSignal(initial)
  const hydrated = createRoot((disposer) => {
    dispose = disposer
    return createPanelBodyHydration(ready)
  })
  flush()
  const setReady = (next: boolean) => {
    setReadySignal(next)
    flush()
  }
  return { hydrated, setReady, dispose }
}

let active: { dispose: VoidFunction } | undefined
let frames: ReturnType<typeof createFrames> | undefined
afterEach(() => {
  active?.dispose()
  active = undefined
  frames?.restore()
  frames = undefined
})

describe("createPanelBodyHydration", () => {
  test("holds the second chunk for the frame AFTER the one that paints the first", () => {
    frames = createFrames()
    const door = mountDoor()
    active = door

    // A callback on the next frame runs BEFORE that frame paints, so the first
    // chunk has not been presented yet and the door must stay shut.
    frames.paint()
    expect(door.hydrated()).toBe(false)

    frames.paint()
    expect(door.hydrated()).toBe(true)
  })

  test("a close between the chunks cancels the second chunk and leaves no schedule behind", () => {
    frames = createFrames()
    const door = mountDoor()
    active = door

    frames.paint()
    door.setReady(false)
    expect(frames.pending()).toBe(0)

    // Frames keep coming while the panel closes; none of them may build the
    // body the user has just dismissed.
    frames.paint()
    frames.paint()
    expect(door.hydrated()).toBe(false)
  })

  test("reopening resumes the cancelled chunk instead of leaving the body a shell", () => {
    frames = createFrames()
    const door = mountDoor()
    active = door

    frames.paint()
    door.setReady(false)
    frames.paint()
    expect(door.hydrated()).toBe(false)

    door.setReady(true)
    frames.paint()
    expect(door.hydrated()).toBe(false)
    frames.paint()
    expect(door.hydrated()).toBe(true)
  })

  test("a rapid toggle arms one schedule, not one per flip", () => {
    frames = createFrames()
    const door = mountDoor()
    active = door

    door.setReady(false)
    door.setReady(true)
    door.setReady(false)
    door.setReady(true)
    expect(frames.pending()).toBe(1)

    frames.paint()
    frames.paint()
    expect(door.hydrated()).toBe(true)
    expect(frames.pending()).toBe(0)
  })

  test("a body that stops being displayed after it is built stays built", () => {
    frames = createFrames()
    const door = mountDoor()
    active = door

    frames.paint()
    frames.paint()
    expect(door.hydrated()).toBe(true)

    // Retention holds this body precisely so coming back to it is a flip.
    door.setReady(false)
    expect(door.hydrated()).toBe(true)
  })

  test("disposing the body between the chunks cancels the pending frame", () => {
    frames = createFrames()
    const door = mountDoor()

    frames.paint()
    expect(frames.pending()).toBe(1)
    door.dispose()
    expect(frames.pending()).toBe(0)

    frames.paint()
    expect(door.hydrated()).toBe(false)
  })

  test("a body that never becomes the user's surface is never built", () => {
    frames = createFrames()
    const door = mountDoor(false)
    active = door

    frames.paint()
    frames.paint()
    expect(door.hydrated()).toBe(false)
    expect(frames.pending()).toBe(0)
  })

  test("without a frame scheduler the body is built in one chunk", () => {
    const original = globalThis.requestAnimationFrame
    // @ts-expect-error deliberately removing the scheduler this door yields to
    globalThis.requestAnimationFrame = undefined
    try {
      const door = mountDoor()
      active = door
      expect(door.hydrated()).toBe(true)
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })
})
