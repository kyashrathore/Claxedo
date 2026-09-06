import { afterEach, describe, expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { createTimelineResizeAnchor, estimateLongMarkdownHeight } from "./timeline-virtualization"

describe("timeline Markdown height estimate", () => {
  test("keeps ordinary prose on the virtualizer default", () => {
    expect(estimateLongMarkdownHeight("A short response with **Markdown**.")).toBeUndefined()
  })

  test("reserves space for long structural Markdown before rich rendering", () => {
    const text = [
      "# Results",
      "",
      ...Array.from({ length: 40 }, (_, index) => `- Result ${index}`),
      "",
      "| Name | State |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_, index) => `| row-${index} | ready |`),
    ].join("\n")

    expect(estimateLongMarkdownHeight(text)).toBe(text.split("\n").length * 26)
  })

  test("tracks giant single-part transcripts at rendered scale instead of a low cap", () => {
    // A 1,849-line part renders at ~53,000px; capping the estimate far below
    // that made the bottom anchor chase a 9x size correction on first
    // measure — a visibly blank viewport after switching to the session.
    const estimate = estimateLongMarkdownHeight(Array.from({ length: 1_849 }, (_, i) => `line ${i}`).join("\n"))
    expect(estimate).toBe(1_849 * 26)
  })

  test("caps truly adversarial payloads", () => {
    expect(estimateLongMarkdownHeight(Array.from({ length: 10_000 }, () => "- row").join("\n"))).toBe(60_000)
  })

  test("reserves the complete line viewport for a large fenced block", () => {
    const text = ["```ts", ...Array.from({ length: 240 }, (_, index) => `export const value${index} = ${index}`), "```"].join("\n")
    expect(estimateLongMarkdownHeight(text)).toBe(242 * 26)
  })
})

describe("timeline resize anchor — display gating", () => {
  type Recorded = { scrollToEnd: number }

  const paddingEnd = 64
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  function harness(options: {
    displayed: () => boolean
    shouldAnchorBottom?: () => boolean
    /** Per-row estimates the virtualizer starts from, as `estimateSize` supplies them. */
    estimates?: number[]
  }) {
    const recorded: Recorded = { scrollToEnd: 0 }
    let resized = 0
    const estimates = options.estimates ?? [180]
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: estimates.length,
      estimateSize: (index) => estimates[index],
      initialRect: { width: 800, height: 800 },
      paddingEnd,
      getScrollElement: () => null,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    })
    virtualizer.getTotalSize()
    const resizeItem = virtualizer.resizeItem.bind(virtualizer)
    virtualizer.resizeItem = (index, size) => {
      resized += 1
      resizeItem(index, size)
    }
    // Only observe the outgoing anchor command. The dependency owns its actual
    // measurement cache and total-size calculation.
    virtualizer.scrollToEnd = () => { recorded.scrollToEnd += 1 }
    const root = document.createElement("div")
    Object.defineProperty(root, "clientHeight", { value: 800 })
    const anchor = createTimelineResizeAnchor()
    cleanups.push(() => anchor.dispose())
    anchor.install({
      virtualizer,
      root: () => root,
      displayed: options.displayed,
      shouldAnchorBottom: options.shouldAnchorBottom ?? (() => true),
      hasScrollGesture: () => false,
    })
    return {
      virtualizer,
      recorded,
      dispose: () => anchor.dispose(),
      resizedCount: () => resized,
      sizeOf: (index: number) => {
        // Recompute through the dependency before observing its public cache.
        virtualizer.getTotalSize()
        return virtualizer.measurementsCache[index]?.size
      },
      totalSize: () => virtualizer.getTotalSize(),
    }
  }

  test("a displayed surface still re-anchors to the bottom on a row resize", async () => {
    const { virtualizer, recorded } = harness({ displayed: () => true })
    virtualizer.resizeItem(0, 100)
    await Promise.resolve()
    expect(recorded.scrollToEnd).toBe(1)
  })

  test("a stashed surface does not arm the virtualizer's scroll from a resize", async () => {
    const { virtualizer, recorded } = harness({ displayed: () => false })
    virtualizer.resizeItem(0, 100)
    await Promise.resolve()
    expect(recorded.scrollToEnd).toBe(0)
  })

  test("a zero measurement leaves the row on its estimate", () => {
    // Zero means the element was measured while its surface was display-locked
    // (`content-visibility: hidden`) or detached — never a real rendered row.
    const h = harness({ displayed: () => true, estimates: [180, 180, 180] })
    h.virtualizer.resizeItem(1, 0)
    expect(h.sizeOf(1)).toBe(180)
  })

  test("zero measurements cannot collapse the total size to paddingEnd", () => {
    // The collapse is the defect that matters: with every row at 0 the
    // scroller has nothing to scroll, so the bottom anchor cannot land and the
    // last turn paints at the top of the viewport with a gap above the composer.
    const h = harness({ displayed: () => true, estimates: [180, 180, 180] })
    for (const index of [0, 1, 2]) h.virtualizer.resizeItem(index, 0)
    expect(h.totalSize()).toBe(3 * 180 + paddingEnd)
  })

  test("a real measurement still replaces the estimate", () => {
    const h = harness({ displayed: () => true, estimates: [180, 180, 180] })
    h.virtualizer.resizeItem(1, 240)
    expect(h.sizeOf(1)).toBe(240)
    expect(h.totalSize()).toBe(180 + 240 + 180 + paddingEnd)
  })

  test("a row that later measures zero keeps its last real size", () => {
    const h = harness({ displayed: () => true, estimates: [180] })
    h.virtualizer.resizeItem(0, 512)
    h.virtualizer.resizeItem(0, 0)
    expect(h.sizeOf(0)).toBe(512)
  })

  test("the resize itself still reaches the virtualizer while stashed", () => {
    const { virtualizer, resizedCount } = harness({ displayed: () => false })
    virtualizer.resizeItem(0, 100)
    // Measurements must keep flowing — only the re-anchor is gated, because the
    // cached sizes are what make the return switch cheap.
    expect(resizedCount()).toBe(1)
  })


  test("stashing after a resize cancels the queued anchor, then a visible resize can anchor again", async () => {
    let displayed = true
    const h = harness({ displayed: () => displayed })
    h.virtualizer.resizeItem(0, 240)
    displayed = false
    await Promise.resolve()
    expect(h.recorded.scrollToEnd).toBe(0)
    expect(h.totalSize()).toBe(240 + paddingEnd)

    displayed = true
    h.virtualizer.resizeItem(0, 300)
    await Promise.resolve()
    expect(h.recorded.scrollToEnd).toBe(1)
  })

  test("disposal cancels a queued anchor and further resize work", async () => {
    const h = harness({ displayed: () => true })
    h.virtualizer.resizeItem(0, 240)
    h.dispose()
    h.virtualizer.resizeItem(0, 300)
    await Promise.resolve()
    expect(h.recorded.scrollToEnd).toBe(0)
    expect(h.totalSize()).toBe(240 + paddingEnd)
  })

})
