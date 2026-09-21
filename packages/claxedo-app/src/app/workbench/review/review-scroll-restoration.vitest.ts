import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  createReviewScrollRestoration as createRestoration,
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

const frames = new Map<number, FrameRequestCallback>()
const restorations: ReturnType<typeof createRestoration>[] = []
let frameId = 0
function createReviewScrollRestoration(input: Parameters<typeof createRestoration>[0]) {
  const restoration = createRestoration(input)
  restorations.push(restoration)
  return restoration
}
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
})
afterEach(() => {
  for (const restoration of restorations.splice(0)) restoration.dispose()
  frames.clear()
  vi.unstubAllGlobals()
})
async function flushFrames(count = 2) {
  // Deliver pending MutationObserver records before the next rendered frame.
  await Promise.resolve()
  for (let index = 0; index < count; index++) {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(index * 16)
    await Promise.resolve()
  }
}

describe("review scroll restoration", () => {
  test("restores a semantic file anchor after the hidden viewport clamps to zero", async () => {
    const { viewport } = fixture()
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => true,
      canRecord: () => true,
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
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
    await flushFrames()

    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("waits for a progressively rendered anchor before restoring", async () => {
    const { anchor, viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()
    anchor.remove()
    viewport.scrollTop = 0
    restoration.restore()
    await flushFrames(1)
    // The anchor row is not in the DOM yet (CodeView only materializes rows
    // near the scroll position), so restoration parks on the
    // recorded pixel top immediately -- that is the scroll that makes the
    // anchor's neighborhood mount -- and keeps waiting for the anchor.
    expect(viewport.scrollTop).toBe(1_000)

    viewport.scrollTop = 700
    viewport.append(anchor)
    await flushFrames()
    // Once the anchor exists, the precise anchor-offset correction wins over
    // the approximate pixel top.
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("targets the anchor where the surface's document puts it now, not where it was captured", async () => {
    const { anchor, viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()

    // Remount: rows above the anchor arrived as summaries reserving one header
    // row each, so the same file now sits much higher in a much shorter
    // document. The retained pixel top would land past the anchor, and against
    // a shorter document it would clamp.
    anchor.remove()
    restoration.bindAnchorTop((path) => (path === "src/generated/file-350.ts" ? 240 : undefined))
    viewport.scrollTop = 0
    restoration.restore()
    await flushFrames(1)
    expect(viewport.scrollTop).toBe(240)

    // The row is now in range. A remount renders it as a new node, at the
    // position the surface reported, and the precise offset correction takes
    // over from there.
    const remounted = document.createElement("div")
    remounted.dataset.reviewFile = "src/generated/file-350.ts"
    Object.defineProperty(remounted, "getBoundingClientRect", { value: () => rect(240 - viewport.scrollTop) })
    viewport.append(remounted)
    await flushFrames()
    expect(viewport.scrollTop).toBe(240)
    restoration.dispose()
  })

  test("falls back to the retained pixel top for a surface that reports no geometry", async () => {
    const { anchor, viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
    viewport.scrollTop = 1_000
    viewport.dispatchEvent(new Event("scroll"))
    restoration.capture()

    anchor.remove()
    restoration.bindAnchorTop((path) => (path === "somewhere/else.ts" ? 240 : undefined))
    viewport.scrollTop = 0
    restoration.restore()
    await flushFrames(1)
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("drops the surface geometry reader on dispose", async () => {
    const { viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })
    const resolve = vi.fn(() => 240)

    restoration.bind(viewport)
    restoration.bindAnchorTop(resolve)
    await flushFrames()
    restoration.dispose()
    // The reader holds the surface's whole engine; a disposed restoration must
    // not keep calling into it.
    restoration.restore()
    await flushFrames()
    expect(resolve).not.toHaveBeenCalled()
  })

  test("flushes a pending anchor capture synchronously on dispose", async () => {
    const { viewport } = fixture()
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => true,
      canRecord: () => true,
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
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
    await flushFrames()
    expect(changes).toHaveLength(2)
  })

  test("settles on the clamped pixel top when the anchor left the corpus", async () => {
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
    await flushFrames()
    expect(changes.at(-1)).toEqual({
      top: 300,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 700,
    })
    restoration.dispose()
  })

  test("observes nothing while the surface is alive: reflow is CodeView's", () => {
    const observed: Element[] = []
    vi.stubGlobal("ResizeObserver", class {
      observe(target: Element) { observed.push(target) }
      unobserve() {}
      disconnect() {}
    })
    const { viewport } = fixture()
    const restoration = createReviewScrollRestoration({ visible: () => true, canRecord: () => true })

    // A row that reflows at a new width grows CodeView's sticky container, and
    // the engine re-measures and re-anchors off that entry. A second observer
    // here would be a second owner of the same correction.
    restoration.bind(viewport)
    expect(observed).toEqual([])
    restoration.dispose()
  })

  test("does not replace the visible snapshot after the Review body is hidden", async () => {
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
    await flushFrames()
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
    await flushFrames()

    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })

  test("does not capture an unobserved layout clamp while Review is still visible", async () => {
    const { viewport } = fixture()
    const changes: ReviewScrollPosition[] = []
    const restoration = createReviewScrollRestoration({
      visible: () => true,
      canRecord: () => true,
      onChange: (position) => changes.push(position),
    })

    restoration.bind(viewport)
    viewport.addEventListener("scroll", restoration.remember)
    await flushFrames()
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
    await flushFrames()
    expect(viewport.scrollTop).toBe(1_000)
    restoration.dispose()
  })
})
