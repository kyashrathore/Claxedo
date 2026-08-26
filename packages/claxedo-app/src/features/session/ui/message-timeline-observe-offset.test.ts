import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/virtual-core"
import {
  createObservedRectHandler,
  mutationNodesContainElement,
  observeElementOffsetReconnectAware,
} from "./message-timeline-observe-offset"

// Ported from upstream packages/app/src/pages/session/timeline/observe-element-offset.test.ts (#36643),
// using real Virtualizer instances instead of structural casts.

test("matches only the scroll element or an ancestor containing it", () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const child = document.createElement("div")
  const sibling = document.createElement("div")
  route.append(viewport)
  viewport.append(child)

  expect(mutationNodesContainElement([viewport], viewport)).toBe(true)
  expect(mutationNodesContainElement([route], viewport)).toBe(true)
  expect(mutationNodesContainElement([child, sibling], viewport)).toBe(false)
})

test("adopts only the first canonical element rect and reports later resizes", () => {
  const instance = { scrollRect: { width: 1_280, height: 720 } }
  const calls: Array<{ width: number; height: number }> = []
  const observe = createObservedRectHandler(instance, (rect) => calls.push(rect))

  observe({ width: 1_000, height: 640 })
  observe({ width: 1_000, height: 640 })
  observe({ width: 900, height: 640 })

  expect(instance.scrollRect).toEqual({ width: 1_000, height: 640 })
  expect(calls).toEqual([{ width: 900, height: 640 }])
})

function createInstance(input: {
  viewport: HTMLDivElement
  horizontal?: boolean
  isRtl?: boolean
  isScrollingResetDelay?: number
}) {
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => input.viewport,
    estimateSize: () => 50,
    horizontal: input.horizontal ?? false,
    isRtl: input.isRtl ?? false,
    isScrollingResetDelay: input.isScrollingResetDelay ?? 0,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })
  // Direct construction leaves mount-time fields (targetWindow, observers)
  // unset — createVirtualizer would call this for us.
  instance._willUpdate()
  return instance
}

// happy-dom 20.10.6 delivers only the first MutationObserver batch. Use one
// observer per mutation phase so the shim cannot hide a later reconnect. Real
// browsers keep delivering batches to one observer; the production callback's
// repeated-record behavior is covered independently from this DOM integration.
test("restores the stored offset after reconnect and ignores equal offsets and unrelated mutations", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const unrelated = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport })
  instance.scrollOffset = 79_400
  viewport.scrollTop = 79_400
  const calls: [number, boolean][] = []
  const record = (offset: number, isScrolling: boolean) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  }

  const unrelatedPhase = observeElementOffsetReconnectAware(instance, record)
  await frames(1)
  document.body.append(unrelated)
  unrelated.remove()
  await frames(2)
  expect(calls).toEqual([])
  unrelatedPhase?.()

  // Reinsertion resets the browser scroll position; the wrapper writes the
  // virtualizer's stored offset back instead of re-deriving the range from
  // the reset value (which would rebuild the row set twice).
  const firstReconnect = observeElementOffsetReconnectAware(instance, record)
  route.remove()
  viewport.scrollTop = 0
  document.body.append(route)
  await until(() => viewport.scrollTop === 79_400)
  expect(calls).toEqual([])
  expect(viewport.scrollTop).toBe(79_400)
  firstReconnect?.()

  const secondReconnect = observeElementOffsetReconnectAware(instance, record)
  route.remove()
  viewport.scrollTop = 0
  document.body.append(route)
  await until(() => viewport.scrollTop === 79_400)
  expect(calls).toEqual([])
  expect(viewport.scrollTop).toBe(79_400)

  secondReconnect?.()
  route.remove()
})

test("keeps enforcing the stored offset until stale reset-delay callbacks can no longer win", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport, isScrollingResetDelay: 20 })
  instance.scrollOffset = 79_400
  viewport.scrollTop = 79_400
  const calls: number[] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
    calls.push(offset)
    instance.scrollOffset = offset
  })

  route.remove()
  viewport.scrollTop = 0
  document.body.append(route)
  await until(() => viewport.scrollTop === 79_400)
  expect(viewport.scrollTop).toBe(79_400)

  // A stale reset-delay callback moves the virtualizer mid-window; the check
  // loop keeps the element and the virtualizer consistent for the whole
  // window instead of leaving them disagreeing.
  instance.scrollOffset = 400
  await until(() => viewport.scrollTop === 400)

  expect(viewport.scrollTop).toBe(400)
  expect(calls).toEqual([])
  cleanup?.()
  route.remove()
})

test.each([
  { name: "LTR", isRtl: false, expectedNative: 120 },
  { name: "RTL", isRtl: true, expectedNative: -120 },
])("restores the stored TanStack horizontal $name offset after reconnect", async ({ isRtl, expectedNative }) => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport, horizontal: true, isRtl })
  instance.scrollOffset = 120
  viewport.scrollLeft = expectedNative
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  route.remove()
  viewport.scrollLeft = 0
  document.body.append(route)
  await until(() => viewport.scrollLeft === expectedNative)

  expect(calls).toEqual([])
  expect(viewport.scrollLeft).toBe(expectedNative)
  cleanup?.()
  route.remove()
})

test("keeps a user scroll offset while virtual content is added and remeasured", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const content = document.createElement("div")
  route.append(viewport)
  viewport.append(content)
  document.body.append(route)
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 2_400 },
    scrollTop: { configurable: true, value: 900, writable: true },
  })
  const instance = createInstance({ viewport, isScrollingResetDelay: 10 })
  instance.scrollOffset = 900
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  viewport.scrollTop = 1_100
  viewport.dispatchEvent(new Event("scroll"))
  content.append(document.createElement("div"))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await frames(2)

  expect(viewport.scrollTop).toBe(1_100)
  expect(instance.scrollOffset).toBe(1_100)
  expect(calls.some(([offset, isScrolling]) => offset === 1_100 && isScrolling)).toBe(true)
  cleanup?.()
  route.remove()
})

test("cleanup suppresses an already queued delegated offset callback", async () => {
  const viewport = document.createElement("div")
  document.body.append(viewport)
  viewport.scrollTop = 100
  const instance = createInstance({ viewport, isScrollingResetDelay: 10 })
  instance.scrollOffset = 0
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) =>
    calls.push([offset, isScrolling]),
  )
  await frames(1)

  viewport.dispatchEvent(new Event("scroll"))
  cleanup?.()
  await new Promise((resolve) => setTimeout(resolve, 25))

  expect(calls).toEqual([[100, true]])
  viewport.remove()
})

test("cleanup cancels reconnect checks and delegated offset observation", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport, isScrollingResetDelay: 50 })
  instance.scrollOffset = 0
  const calls: number[] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => calls.push(offset))

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup?.()
  instance.scrollOffset = 100
  viewport.dispatchEvent(new Event("scroll"))
  await frames(4)

  expect(calls).toEqual([])
  route.remove()
})

async function frames(count: number) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

// Frame-count waits race the MutationObserver/rAF interleaving under shared
// happy-dom globals; wait for the observable outcome with a bounded deadline.
async function until(predicate: () => boolean, timeoutMs = 5_000) {
  const start = Date.now()
  while (!predicate() && Date.now() - start < timeoutMs) {
    await frames(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
