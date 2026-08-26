import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import {
  createObservedRectHandler,
  createReconnectAwareOffsetObserver,
  mutationNodesContainElement,
  type ReconnectRepairPresentation,
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

/** A surface that is always on screen: the reconnect repair runs immediately. */
function alwaysPresented(): ReconnectRepairPresentation {
  return { presented: () => true, subscribe: () => () => {} }
}

/** A surface whose presentation can be toggled, like a stashed workbench slot. */
function togglePresentation(initial: boolean) {
  const listeners = new Set<() => void>()
  let presented = initial
  return {
    port: {
      presented: () => presented,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    } satisfies ReconnectRepairPresentation,
    present(next: boolean) {
      presented = next
      for (const listener of [...listeners]) listener()
    },
  }
}

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

test("reports a divergent native offset once and ignores equal offsets and unrelated mutations", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const unrelated = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport })
  instance.scrollOffset = 79_400
  const calls: [number, boolean][] = []
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })
  await frames(1)

  document.body.append(unrelated)
  unrelated.remove()
  await frames(2)
  expect(calls).toEqual([])

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual([[0, false]])

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)
  expect(calls).toEqual([[0, false]])

  cleanup?.()
  route.remove()
})

test("keeps checking until stale reset-delay callbacks can no longer win", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport, isScrollingResetDelay: 20 })
  instance.scrollOffset = 79_400
  const calls: number[] = []
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset) => {
    calls.push(offset)
    instance.scrollOffset = offset
  })

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(1)
  expect(instance.scrollOffset).toBe(0)

  instance.scrollOffset = 79_400
  await new Promise((resolve) => setTimeout(resolve, 25))
  await frames(3)

  expect(instance.scrollOffset).toBe(0)
  expect(calls).toEqual([0, 0])
  cleanup?.()
  route.remove()
})

test.each([
  { name: "LTR", isRtl: false, expected: 240 },
  { name: "RTL", isRtl: true, expected: -240 },
])("reports the TanStack horizontal $name offset after reconnect", async ({ isRtl, expected }) => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  viewport.scrollLeft = 240
  const instance = createInstance({ viewport, horizontal: true, isRtl })
  instance.scrollOffset = 0
  const calls: [number, boolean][] = []
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)

  expect(calls).toEqual([[expected, false]])
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
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset, isScrolling) => {
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
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset, isScrolling) =>
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
  const cleanup = createReconnectAwareOffsetObserver(alwaysPresented())(instance, (offset) => calls.push(offset))

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

test("holds the reconnect repair while the surface is not presented, then runs it once presented", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  let scrollTopReads = 0
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get() {
      scrollTopReads += 1
      return 0
    },
    set() {},
  })
  const instance = createInstance({ viewport })
  instance.scrollOffset = 79_400
  const presentation = togglePresentation(false)
  const calls: [number, boolean][] = []
  const cleanup = createReconnectAwareOffsetObserver(presentation.port)(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)

  // A stashed surface must not read layout or deliver an offset.
  expect(calls).toEqual([])
  expect(scrollTopReads).toBe(0)
  expect(instance.scrollOffset).toBe(79_400)

  presentation.present(true)
  await frames(3)

  expect(calls).toEqual([[0, false]])
  expect(instance.scrollOffset).toBe(0)
  expect(scrollTopReads).toBeGreaterThan(0)

  cleanup?.()
  route.remove()
})

test("does not repair a surface that was never reconnected when it becomes presented", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport })
  instance.scrollOffset = 79_400
  const presentation = togglePresentation(false)
  const calls: number[] = []
  const cleanup = createReconnectAwareOffsetObserver(presentation.port)(instance, (offset) => calls.push(offset))

  presentation.present(true)
  await frames(3)

  expect(calls).toEqual([])
  expect(instance.scrollOffset).toBe(79_400)
  cleanup?.()
  route.remove()
})

test("cleanup drops a repair that is still pending on a stashed surface", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = createInstance({ viewport })
  instance.scrollOffset = 79_400
  const presentation = togglePresentation(false)
  const calls: number[] = []
  const cleanup = createReconnectAwareOffsetObserver(presentation.port)(instance, (offset) => calls.push(offset))

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup?.()
  presentation.present(true)
  await frames(3)

  expect(calls).toEqual([])
  route.remove()
})

async function frames(count: number) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
