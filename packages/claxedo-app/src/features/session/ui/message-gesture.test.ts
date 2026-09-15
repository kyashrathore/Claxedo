import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createScrollGestureWindow, normalizeWheelDelta, shouldMarkBoundaryGesture } from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("pixel deltas pass through", () => {
    expect(normalizeWheelDelta({ deltaY: 42, deltaMode: 0, rootHeight: 600 })).toBe(42)
  })

  test("line deltas convert to pixels", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 600 })).toBe(120)
  })

  test("page deltas convert by viewport height", () => {
    expect(normalizeWheelDelta({ deltaY: 1, deltaMode: 2, rootHeight: 600 })).toBe(600)
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("a non-scrollable list treats any wheel as a boundary gesture", () => {
    expect(shouldMarkBoundaryGesture({ delta: 10, scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toBe(true)
  })

  test("an upward wheel past the top marks a boundary gesture", () => {
    expect(shouldMarkBoundaryGesture({ delta: -20, scrollTop: 10, scrollHeight: 2000, clientHeight: 600 })).toBe(true)
    expect(shouldMarkBoundaryGesture({ delta: -5, scrollTop: 10, scrollHeight: 2000, clientHeight: 600 })).toBe(false)
  })

  test("a downward wheel past the bottom marks a boundary gesture", () => {
    expect(shouldMarkBoundaryGesture({ delta: 20, scrollTop: 1395, scrollHeight: 2000, clientHeight: 600 })).toBe(true)
    expect(shouldMarkBoundaryGesture({ delta: 5, scrollTop: 1395, scrollHeight: 2000, clientHeight: 600 })).toBe(false)
  })
})

describe("createScrollGestureWindow", () => {
  function harness() {
    const root = document.createElement("div")
    root.setAttribute("data-scrollable", "")
    document.body.appendChild(root)
    const nested = document.createElement("div")
    nested.setAttribute("data-scrollable", "")
    root.appendChild(nested)
    const plain = document.createElement("p")
    root.appendChild(plain)
    const gesture = createRoot((dispose) => ({ dispose, ...createScrollGestureWindow({ scroller: () => root }) }))
    return { root, nested, plain, gesture }
  }

  test("a gesture on plain transcript content marks the window", () => {
    const { plain, gesture } = harness()
    gesture.mark(plain)
    expect(gesture.active()).toBe(true)
    gesture.dispose()
  })

  test("a gesture inside a nested scroller does not mark the transcript", () => {
    const { nested, gesture } = harness()
    gesture.mark(nested)
    expect(gesture.active()).toBe(false)
    gesture.dispose()
  })

  test("a bare mark counts as a transcript gesture", () => {
    const { gesture } = harness()
    gesture.mark()
    expect(gesture.active()).toBe(true)
    gesture.dispose()
  })
})
