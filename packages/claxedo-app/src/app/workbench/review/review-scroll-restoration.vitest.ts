import { afterEach, describe, expect, test, vi } from "vitest"

import {
  createReviewScrollRestoration,
  REVIEW_SCROLL_DIAGNOSTIC_PROPERTY,
  type ReviewScrollDiagnostic,
  type ReviewScrollPosition,
} from "./review-scroll-restoration"

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
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
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
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()
    anchor.remove()
    viewport.scrollTop = 0
    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The anchor row is not in the DOM yet (the windowed file list only
    // materializes rows near the scroll position), so restoration parks on the
    // recorded pixel top immediately -- that is the scroll that makes the
    // anchor's neighborhood mount -- and keeps waiting for the anchor.
    expect(viewport.scrollTop).toBe(1_000)

    viewport.scrollTop = 700
    viewport.append(anchor)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Once the anchor exists, the precise anchor-offset correction wins over
    // the approximate pixel top.
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("flushes a pending anchor capture synchronously on dispose", async () => {
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
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    // The scroll handler published the pixel top and scheduled the anchor
    // capture for the next frame. An immediate tab switch disposes before
    // that frame runs; the dispose flush must still record the anchor.
    expect(changes).toEqual([{ top: 1_000 }])
    restoration.dispose()
    expect(changes.at(-1)).toEqual({
      top: 1_000,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 0,
    })

    // The flushed frame is cancelled: nothing fires after cleanup and the
    // anchor is captured exactly once.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(changes).toHaveLength(2)
  })

  test("settles on the clamped pixel top when the anchor left the corpus", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    const { viewport } = fixture()
    Object.defineProperty(viewport, "scrollHeight", { value: 1_500 })
    Object.defineProperty(viewport, "clientHeight", { value: 500 })
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => true,
      canRecord: () => true,
      initial: { top: 2_000, anchorPath: "src/deleted.ts", anchorOffset: 0 },
      anchorExists: (path) => path !== "src/deleted.ts",
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    // The retained anchor was deleted while Review was closed: instead of
    // parking and waiting forever for a row that can never mount, restoration
    // settles on the retained pixel top clamped to the current extent.
    expect(viewport.scrollTop).toBe(1_000)
    const diagnostic = (
      viewport as HTMLDivElement & { [REVIEW_SCROLL_DIAGNOSTIC_PROPERTY]: () => ReviewScrollDiagnostic }
    )[REVIEW_SCROLL_DIAGNOSTIC_PROPERTY]
    expect(diagnostic().restoring).toBe(false)
    expect(diagnostic().action).toBe("anchor-missing-settled")

    // Scroll ownership is back with the user: the next scroll records
    // normally and the capture replaces the dead anchor with a live one.
    viewport.scrollTop = 300
    viewport.dispatchEvent(new Event("scroll"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(changes.at(-1)).toEqual({
      top: 300,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 700,
    })
    restoration.dispose()
  })

  test("re-applies the semantic anchor when the viewport width changes", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    let resize: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
          resize = callback
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()

    // The first observation only records the width; it must not scroll.
    resize?.([{ contentRect: { width: 800 } }])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(viewport.scrollTop).toBe(1_000)

    // A navigator squeezing the panel reflows the rows; the drifted pixel
    // position is corrected back to the recorded semantic anchor.
    viewport.scrollTop = 900
    resize?.([{ contentRect: { width: 500 } }])
    await new Promise((resolve) => setTimeout(resolve, 30))
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
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()

    visible = false
    viewport.scrollTop = 0
    restoration.capture()

    expect(changes).toEqual([
      { top: 1_000 },
      {
        top: 1_000,
        anchorPath: "src/generated/file-350.ts",
        anchorOffset: 0,
      },
    ])

    visible = true
    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("does not capture an unobserved layout clamp while Review is still visible", async () => {
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
    viewport.addEventListener("scroll", restoration.remember)
    await new Promise((resolve) => setTimeout(resolve, 20))
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()
    viewport.scrollTop = 0
    restoration.capture()

    expect(changes.at(-1)).toEqual({
      top: 1_000,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 0,
    })

    restoration.restore()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })
})
