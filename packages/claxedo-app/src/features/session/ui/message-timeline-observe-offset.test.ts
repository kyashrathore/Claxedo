import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { mutationNodesContainElement, observeElementOffsetReconnectAware } from "./message-timeline-observe-offset"

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
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  document.body.append(unrelated)
  unrelated.remove()
  await frames(2)
  expect(calls).toEqual([])

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)
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
  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
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
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
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
