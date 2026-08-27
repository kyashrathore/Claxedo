import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"

// Guards the patched @tanstack/virtual-core (patches/@tanstack%2Fvirtual-core@3.17.3.patch)
// behavior that message-timeline.tsx depends on: an IDLE timeline schedules NO
// frames.
//
// `message-timeline.tsx` builds its virtualizer with
// `initialOffset: () => props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0`
// — the sentinel that means "open at the bottom". `getScrollOffset()` MATERIALISES
// that sentinel into the virtualizer's cached `scrollOffset` on the first read,
// and only a scroll EVENT ever replaces it. A `scrollToEnd()` whose write is a
// no-op (the element is already at its scroll limit) fires no scroll event, so
// the cache keeps the sentinel — and `reconcileScroll` then compares its target
// against `Number.MAX_SAFE_INTEGER` every frame, never converges, and reschedules
// itself at 60fps until its multi-second safety valve.
//
// The virtualizer must instead read the element's REAL scroll position when
// deciding whether a scroll intent has landed.

function scrollElement(input: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const element = document.createElement("div")
  const state = { ...input }
  Object.defineProperties(element, {
    scrollHeight: { get: () => state.scrollHeight, configurable: true },
    clientHeight: { get: () => state.clientHeight, configurable: true },
    scrollTop: {
      get: () => state.scrollTop,
      // A real element clamps a write to its scrollable range, and fires a
      // scroll event only when the position actually MOVES.
      set: (value: number) => {
        state.scrollTop = Math.max(0, Math.min(value, state.scrollHeight - state.clientHeight))
      },
      configurable: true,
    },
  })
  document.body.append(element)
  return element
}

/** Runs queued animation frames, newly queued ones included, up to a budget. */
function drainFrames(budget: number) {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  let queue: (FrameRequestCallback | undefined)[] = []
  let scheduled = 0
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    scheduled += 1
    return queue.push(callback)
  }
  globalThis.cancelAnimationFrame = (handle: number) => {
    queue[handle - 1] = undefined
  }
  return {
    run() {
      for (let frame = 0; frame < budget; frame += 1) {
        const pending = queue
        queue = []
        if (pending.length === 0) return { scheduled, quiesced: true }
        for (const callback of pending) callback?.(frame * 16)
      }
      return { scheduled, quiesced: queue.length === 0 }
    },
    restore() {
      globalThis.requestAnimationFrame = originalRequest
      globalThis.cancelAnimationFrame = originalCancel
    },
  }
}

function timelineVirtualizer(
  element: HTMLDivElement,
  count: number,
  observeOffset?: (deliver: (offset: number, isScrolling: boolean) => void) => void,
) {
  // The option shape message-timeline.tsx actually builds, reduced to the parts
  // the scroll reconcile reads.
  return new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    estimateSize: () => 50,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    initialRect: { width: 800, height: element.clientHeight },
    anchorTo: "end",
    paddingEnd: 64,
    overscan: 1,
    getScrollElement: () => element,
    scrollToFn: (offset) => {
      element.scrollTop = offset
    },
    observeElementRect: () => {},
    // The real observer only calls back on a scroll EVENT. A write that does not
    // move the element produces none, which is the whole point of this test.
    observeElementOffset: (_instance, deliver) => observeOffset?.(deliver),
  })
}

test("an idle bottom-anchored timeline schedules no frames when its scroll target is already reached", () => {
  // A transcript that fits its viewport: the scroll root cannot move, so
  // `scrollToEnd()`'s write is a no-op and no scroll event will ever arrive.
  const element = scrollElement({ scrollHeight: 600, clientHeight: 600, scrollTop: 0 })
  const frames = drainFrames(600)
  try {
    const virtualizer = timelineVirtualizer(element, 4)
    virtualizer._didMount()
    virtualizer._willUpdate()
    virtualizer.getTotalSize()

    virtualizer.scrollToEnd()
    const result = frames.run()

    expect(element.scrollTop).toBe(0)
    expect(result.quiesced).toBe(true)
    // One reconcile frame confirms the landing; anything more is a spin.
    expect(result.scheduled).toBeLessThanOrEqual(2)
  } finally {
    frames.restore()
    element.remove()
  }
})

test("an idle bottom-anchored timeline quiesces when the scroll root is already at its end", () => {
  // A scrollable transcript already parked at the bottom — the warm return the
  // session-switch scenario ends on. The write lands on the current position, so
  // again no scroll event follows it.
  const element = scrollElement({ scrollHeight: 2_000, clientHeight: 600, scrollTop: 1_400 })
  const frames = drainFrames(600)
  try {
    const virtualizer = timelineVirtualizer(element, 40)
    virtualizer._didMount()
    virtualizer._willUpdate()
    virtualizer.getTotalSize()

    virtualizer.scrollToEnd()
    const result = frames.run()

    expect(element.scrollTop).toBe(1_400)
    expect(result.quiesced).toBe(true)
    expect(result.scheduled).toBeLessThanOrEqual(2)
  } finally {
    frames.restore()
    element.remove()
  }
})

test("a scroll intent that has NOT landed keeps reconciling", () => {
  // The negative flow: the loop must still run while the element has not reached
  // the requested offset, or a programmatic scroll would stop converging.
  const element = scrollElement({ scrollHeight: 2_000, clientHeight: 600, scrollTop: 0 })
  const frames = drainFrames(10)
  try {
    const virtualizer = timelineVirtualizer(element, 40)
    virtualizer._didMount()
    virtualizer._willUpdate()
    virtualizer.getTotalSize()

    // A scroll root that refuses to move: the reconcile must keep polling rather
    // than declaring a target it never reached as reached.
    Object.defineProperty(element, "scrollTop", { get: () => 0, set: () => {}, configurable: true })
    virtualizer.scrollToOffset(900)
    const result = frames.run()

    expect(result.scheduled).toBeGreaterThan(5)
  } finally {
    frames.restore()
    element.remove()
  }
})

test("real scrolling still re-windows the timeline after the sentinel offset is quiesced", () => {
  // Quiescing must not cost the virtualized list its scroll response: a real
  // gesture has to move the rendered window, both after a settled scrollToEnd
  // and from a cold sentinel offset.
  const element = scrollElement({ scrollHeight: 2_000, clientHeight: 600, scrollTop: 1_400 })
  const frames = drainFrames(600)
  let deliver: ((offset: number, isScrolling: boolean) => void) | undefined
  try {
    const virtualizer = timelineVirtualizer(element, 40, (callback) => {
      deliver = callback
    })
    virtualizer._didMount()
    virtualizer._willUpdate()
    virtualizer.getTotalSize()

    virtualizer.scrollToEnd()
    expect(frames.run().quiesced).toBe(true)
    const atEnd = virtualizer.getVirtualItems().map((item) => item.index)
    expect(atEnd.at(-1)).toBe(39)

    // The user drags to the top. The scroll event is the authoritative offset.
    element.scrollTop = 0
    deliver?.(0, true)
    virtualizer._willUpdate()
    const atTop = virtualizer.getVirtualItems().map((item) => item.index)
    expect(atTop[0]).toBe(0)
    expect(atTop).not.toEqual(atEnd)

    // And back down to a mid position.
    element.scrollTop = 700
    deliver?.(700, true)
    virtualizer._willUpdate()
    const atMiddle = virtualizer.getVirtualItems().map((item) => item.index)
    expect(atMiddle[0]).toBeGreaterThan(0)
    expect(atMiddle.at(-1)).toBeLessThan(39)
  } finally {
    frames.restore()
    element.remove()
  }
})
