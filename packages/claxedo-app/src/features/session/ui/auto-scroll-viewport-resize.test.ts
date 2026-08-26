import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"
import { createAutoScroll } from "@opencode-ai/ui/hooks"

// A scroll container behaves in one way that matters here and that no plain
// object reproduces: `scrollTop` is clamped to `scrollHeight - clientHeight`.
// Growing the viewport therefore silently drags `scrollTop` down, and shrinking
// it back does NOT restore it.
function createFakeScroller(input: { scrollHeight: number; clientHeight: number }) {
  let scrollHeight = input.scrollHeight
  let clientHeight = input.clientHeight
  let scrollTop = 0

  const max = () => Math.max(0, scrollHeight - clientHeight)
  const clamp = () => {
    scrollTop = Math.max(0, Math.min(scrollTop, max()))
  }

  const element = document.createElement("div")
  Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight })
  Object.defineProperty(element, "clientHeight", { get: () => clientHeight })
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next
      clamp()
    },
  })

  return {
    element,
    max,
    distanceFromBottom: () => scrollHeight - clientHeight - scrollTop,
    setViewportHeight(next: number) {
      clientHeight = next
      clamp()
    },
    setContentHeight(next: number) {
      scrollHeight = next
      clamp()
    },
  }
}

interface Registration {
  targets: Set<Element>
  callback: ResizeObserverCallback
  observer: ResizeObserver
}

const registrations: Registration[] = []

class FakeResizeObserver implements ResizeObserver {
  private registration: Registration

  constructor(callback: ResizeObserverCallback) {
    this.registration = { targets: new Set(), callback, observer: this }
    registrations.push(this.registration)
  }

  observe(target: Element) {
    this.registration.targets.add(target)
  }

  unobserve(target: Element) {
    this.registration.targets.delete(target)
  }

  disconnect() {
    this.registration.targets.clear()
  }
}

const isObserved = (target: Element) => registrations.some((entry) => entry.targets.has(target))

/** Deliver a resize the way a real ResizeObserver would: only to observers that asked for this target. */
const deliverResize = (target: Element, height: number) => {
  const entry = { target, contentRect: { width: 800, height } } as ResizeObserverEntry
  for (const registration of registrations) {
    if (!registration.targets.has(target)) continue
    registration.callback([entry], registration.observer)
  }
  // A real resize lands in its own task, so the writes the callback makes are
  // committed before anything reads them back.
  flush()
}

describe("createAutoScroll viewport resizes", () => {
  let original: typeof globalThis.ResizeObserver
  let dispose = () => {}

  beforeEach(() => {
    registrations.length = 0
    original = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeResizeObserver
  })

  afterEach(() => {
    dispose()
    dispose = () => {}
    globalThis.ResizeObserver = original
  })

  const mount = (scroller: ReturnType<typeof createFakeScroller>, content: HTMLElement) =>
    createRoot((disposeRoot) => {
      dispose = disposeRoot
      const autoScroll = createAutoScroll({ working: () => true, overflowAnchor: "none" })
      autoScroll.scrollRef(scroller.element)
      autoScroll.contentRef(content)
      // The refs are store writes, and Solid 2 stages those until the scheduler
      // flushes. In the app they land through JSX `ref` callbacks during render,
      // so every imperative call that follows already sees them committed;
      // settle here so the test's calls do too.
      flush()
      return autoScroll
    })

  test("re-pins to the bottom when the viewport shrinks back after growing", () => {
    // Matches the observed production sequence: the prompt dock momentarily
    // drops a status line as a turn completes, so the timeline viewport grows
    // by ~27px and then returns to its previous height one frame later.
    const scroller = createFakeScroller({ scrollHeight: 1376, clientHeight: 415 })
    const content = document.createElement("div")
    const autoScroll = mount(scroller, content)

    autoScroll.forceScrollToBottom()
    expect(scroller.distanceFromBottom()).toBe(0)

    // Viewport grows: the browser clamps scrollTop down to the new maximum.
    scroller.setViewportHeight(442)
    deliverResize(scroller.element, 442)
    expect(scroller.element.scrollTop).toBe(934)

    // Viewport shrinks back: the clamped scrollTop is now a line short of the
    // bottom, and no content resize will ever fire to correct it.
    scroller.setViewportHeight(415)
    deliverResize(scroller.element, 415)

    expect(scroller.distanceFromBottom()).toBe(0)
    expect(autoScroll.userScrolled()).toBe(false)
    // The mechanism, stated directly: the viewport has to be observed at all.
    expect(isObserved(scroller.element)).toBe(true)
  })

  test("leaves a user who scrolled away alone when the viewport resizes", () => {
    const scroller = createFakeScroller({ scrollHeight: 1376, clientHeight: 415 })
    const autoScroll = mount(scroller, document.createElement("div"))

    autoScroll.forceScrollToBottom()
    autoScroll.pause()
    scroller.element.scrollTop = 300
    // The pause is a store write; in the app it comes from a scroll gesture one
    // task before any resize frame, so settle it before delivering resizes.
    flush()

    scroller.setViewportHeight(442)
    deliverResize(scroller.element, 442)
    scroller.setViewportHeight(415)
    deliverResize(scroller.element, 415)

    expect(scroller.element.scrollTop).toBe(300)
  })

  test("still follows content growth", () => {
    const scroller = createFakeScroller({ scrollHeight: 600, clientHeight: 415 })
    const content = document.createElement("div")
    const autoScroll = mount(scroller, content)

    autoScroll.forceScrollToBottom()
    scroller.setContentHeight(1376)
    deliverResize(content, 1376)

    expect(scroller.distanceFromBottom()).toBe(0)
  })
})
