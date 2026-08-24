import { afterEach, describe, expect, test, vi } from "vitest"

import { createReviewScrollRestoration, type ReviewScrollPosition } from "./review-scroll-restoration"

function rect(top: number, height = 24): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 300, bottom: top + height, width: 300, height, toJSON: () => ({}) }
}

function fixture() {
  const viewport = document.createElement("div")
  const anchor = document.createElement("div")
  anchor.dataset.reviewFile = "src/generated/file-350.ts"
  viewport.append(anchor)
  Object.defineProperty(viewport, "getBoundingClientRect", { value: () => rect(0, 500) })
  Object.defineProperty(anchor, "getBoundingClientRect", {
    value: () => rect(1_000 - viewport.scrollTop),
  })
  return { anchor, viewport }
}

afterEach(() => vi.unstubAllGlobals())

describe("review scroll restoration", () => {
  test("restores a semantic file anchor after the hidden viewport clamps to zero", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    const { viewport } = fixture()
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => true,
      canRecord: () => true,
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.scrollTop = 1_000
    restoration.capture()
    expect(changes.at(-1)).toEqual({
      top: 1_000,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 0,
    })

    viewport.scrollTop = 0
    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("waits for a progressively rendered anchor before restoring", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    const { anchor, viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    restoration.bind(viewport)
    viewport.scrollTop = 1_000
    restoration.capture()
    anchor.remove()
    viewport.scrollTop = 0
    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(viewport.scrollTop).toBe(0)

    viewport.append(anchor)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("does not replace the visible snapshot after the Review body is hidden", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    const { viewport } = fixture()
    let visible = true
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => visible,
      canRecord: () => visible,
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.scrollTop = 1_000
    restoration.capture()

    visible = false
    viewport.scrollTop = 0
    restoration.capture()

    expect(changes).toEqual([{
      top: 1_000,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 0,
    }])

    visible = true
    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })
})
