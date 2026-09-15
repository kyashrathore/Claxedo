import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTimelineScrollMemory, type TimelineScrollPosition } from "./timeline-scroll-memory"

function harness(initial?: TimelineScrollPosition) {
  const root = document.createElement("div")
  let height = 600
  Object.defineProperty(root, "clientHeight", { get: () => height })
  const [active, setActive] = createSignal(true)
  let following = false, target = false, restoring = false
  const offsets: number[] = []
  const anchors: unknown[] = []
  let ends = 0
  let dispose = () => {}
  const memory = createRoot((end) => {
    dispose = end
    return createTimelineScrollMemory({
      initial, active, root: () => root, following: () => following,
      hasTarget: () => target, restoring: () => restoring,
      restoreFollowing: (value) => { following = value },
      scrollToOffset: (offset) => { offsets.push(offset); root.scrollTop = offset },
      scrollToEnd: () => { ends++ }, restoreAnchor: (anchor) => anchors.push(anchor),
    })
  })
  return { root, memory, setActive, offsets, anchors, ends: () => ends, dispose,
    setHeight: (value: number) => { height = value },
    setFollowing: (value: boolean) => { following = value },
    setTarget: (value: boolean) => { target = value },
    setRestoring: (value: boolean) => { restoring = value },
  }
}

describe("timeline reading position", () => {
  test("restores the last displayed offset after the hidden scroller is clamped", () => {
    const h = harness()
    h.root.scrollTop = 640
    h.memory.capture()
    h.setActive(false)
    h.root.scrollTop = 0
    h.setHeight(0)
    h.memory.capture()
    h.setHeight(600)
    h.setActive(true)
    expect(h.offsets).toEqual([640])
    expect(h.root.scrollTop).toBe(640)
    expect(h.ends()).toBe(0)
    h.dispose()
  })

  test("a remount restores a row anchor as well as its offset", () => {
    const position = { offset: 640, following: false, anchor: { key: "assistant-part:p1", offset: -32 } }
    const h = harness(position)
    expect(h.offsets).toEqual([640])
    expect(h.anchors).toEqual([position.anchor])
    h.dispose()
  })

  test("a following reader returns to the current end, even if work finished while hidden", () => {
    const h = harness()
    h.setFollowing(true)
    h.root.scrollTop = 1200
    h.memory.capture()
    h.setActive(false)
    h.setActive(true)
    expect(h.ends()).toBe(1)
    expect(h.offsets).toEqual([])
    h.dispose()
  })

  test("an explicit message target owns the return", () => {
    const h = harness()
    h.memory.capture()
    h.setActive(false)
    h.setTarget(true)
    h.setActive(true)
    expect(h.offsets).toEqual([])
    expect(h.ends()).toBe(0)
    h.dispose()
  })

  test("intermediate restoration geometry does not overwrite the saved position", () => {
    const h = harness()
    h.root.scrollTop = 640
    h.memory.capture()
    h.setRestoring(true)
    h.root.scrollTop = 120
    h.memory.capture()
    expect(h.memory.snapshot()?.offset).toBe(640)
    h.dispose()
  })
})
