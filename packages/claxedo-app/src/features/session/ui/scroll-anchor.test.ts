import { describe, expect, test } from "bun:test"
import { computeScrollState, pickAnchorMessageId } from "./scroll-anchor"

describe("computeScrollState", () => {
  test("no overflow when content fits the viewport", () => {
    expect(computeScrollState({ scrollHeight: 500, clientHeight: 500, scrollTop: 0 })).toEqual({
      overflow: false,
      bottom: true,
      jump: false,
    })
  })

  test("at bottom when scrolled to (near) the end", () => {
    expect(computeScrollState({ scrollHeight: 2000, clientHeight: 1000, scrollTop: 999 })).toEqual({
      overflow: true,
      bottom: true,
      jump: false,
    })
  })

  test("not at bottom and no jump for a small upward scroll", () => {
    // max = 1000, scrollTop = 900 → 100px from bottom, under the 1000px threshold
    expect(computeScrollState({ scrollHeight: 2000, clientHeight: 1000, scrollTop: 900 })).toEqual({
      overflow: true,
      bottom: false,
      jump: false,
    })
  })

  test("shows the jump affordance once scrolled up past one viewport", () => {
    // max = 3000, scrollTop = 0 → 3000px from bottom, over max(400,1000)
    expect(computeScrollState({ scrollHeight: 4000, clientHeight: 1000, scrollTop: 0 })).toEqual({
      overflow: true,
      bottom: false,
      jump: true,
    })
  })

  test("uses a 400px floor for the jump threshold on short viewports", () => {
    // clientHeight 100 → threshold max(400,100)=400; 300px up → no jump
    expect(computeScrollState({ scrollHeight: 500, clientHeight: 100, scrollTop: 100 }).jump).toBe(false)
    // 401px up → jump
    expect(computeScrollState({ scrollHeight: 900, clientHeight: 100, scrollTop: 399 }).jump).toBe(true)
  })
})

describe("pickAnchorMessageId", () => {
  const box = { top: 0, bottom: 1000 }

  test("returns the message straddling the anchor line", () => {
    const id = pickAnchorMessageId({
      items: [
        { id: "a", top: 0, bottom: 90 },
        { id: "b", top: 90, bottom: 300 },
        { id: "c", top: 300, bottom: 500 },
      ],
      box,
      line: 100,
    })
    expect(id).toBe("b")
  })

  test("returns the nearest visible message when none straddles the line", () => {
    const id = pickAnchorMessageId({
      items: [
        { id: "a", top: 200, bottom: 260 },
        { id: "b", top: 400, bottom: 460 },
      ],
      box,
      line: 100,
    })
    expect(id).toBe("a")
  })

  test("breaks nearest-distance ties toward the higher message", () => {
    const id = pickAnchorMessageId({
      items: [
        { id: "below", top: 150, bottom: 200 },
        { id: "above", top: 50, bottom: 90 },
      ],
      box,
      line: 100,
    })
    // both are 50px from the line; the one with the smaller top wins
    expect(id).toBe("above")
  })

  test("ignores messages fully outside the viewport box", () => {
    const id = pickAnchorMessageId({
      items: [
        { id: "offscreen", top: -500, bottom: -400 },
        { id: "visible", top: 300, bottom: 360 },
      ],
      box,
      line: 100,
    })
    expect(id).toBe("visible")
  })

  test("falls back to the last above-line, then first, then fallback", () => {
    // nothing visible in the box → fall through to above-line/first
    const id = pickAnchorMessageId({
      items: [
        { id: "x", top: -300, bottom: -200 },
        { id: "y", top: -100, bottom: -50 },
      ],
      box,
      line: 100,
      fallback: "fb",
    })
    expect(id).toBe("y")
  })

  test("returns the fallback when there are no items", () => {
    expect(pickAnchorMessageId({ items: [], box, line: 100, fallback: "fb" })).toBe("fb")
  })
})
