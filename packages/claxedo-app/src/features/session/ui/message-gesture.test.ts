import { describe, expect, test } from "bun:test"
import { normalizeWheelDelta, shouldMarkBoundaryGesture, shouldMarkPointerScrollGesture } from "./message-gesture"

describe("timeline scroll gesture classification", () => {
  test("marks only pointerdowns on the scroll root itself", () => {
    const root = new EventTarget()
    const child = new EventTarget()

    expect(shouldMarkPointerScrollGesture({ target: root, currentTarget: root })).toBe(true)
    expect(shouldMarkPointerScrollGesture({ target: child, currentTarget: root })).toBe(false)
    expect(shouldMarkPointerScrollGesture({ target: null, currentTarget: root })).toBe(false)
  })

  test("keeps wheel normalization and boundary detection unchanged", () => {
    expect(normalizeWheelDelta({ deltaY: 2, deltaMode: 1, rootHeight: 500 })).toBe(80)
    expect(shouldMarkBoundaryGesture({ delta: -20, scrollTop: 10, scrollHeight: 1000, clientHeight: 500 })).toBe(true)
    expect(shouldMarkBoundaryGesture({ delta: 20, scrollTop: 10, scrollHeight: 1000, clientHeight: 500 })).toBe(false)
  })
})
