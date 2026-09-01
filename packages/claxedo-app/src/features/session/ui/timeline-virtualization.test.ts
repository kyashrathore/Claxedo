import { describe, expect, test } from "bun:test"
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

  function harness(options: { displayed: () => boolean; shouldAnchorBottom?: () => boolean }) {
    const recorded: Recorded = { scrollToEnd: 0 }
    let resized = 0
    const virtualizer = {
      measurementsCache: [] as unknown[],
      itemSizeCache: new Map<unknown, number>(),
      range: undefined,
      shouldAdjustScrollPositionOnItemSizeChange: undefined as unknown,
      resizeItem: () => {
        resized += 1
      },
      scrollToEnd: () => {
        recorded.scrollToEnd += 1
      },
    }
    createTimelineResizeAnchor().install({
      // The harness stands in for the parts of the virtualizer this owner drives.
      virtualizer: virtualizer as never,
      root: () => ({ clientHeight: 800, getBoundingClientRect: () => ({ top: 0, bottom: 800 }), querySelectorAll: () => [] }) as never,
      displayed: options.displayed,
      shouldAnchorBottom: options.shouldAnchorBottom ?? (() => true),
      hasScrollGesture: () => false,
    })
    return { virtualizer, recorded, resizedCount: () => resized }
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

  test("a zero measurement never reaches the virtualizer", () => {
    // Zero means the element was measured while display-locked or detached.
    // Caching it collapses the total size to paddingEnd, which strands the
    // bottom anchor and paints the last turn at the top of the viewport.
    const { virtualizer, resizedCount } = harness({ displayed: () => true })
    virtualizer.resizeItem(0, 0)
    expect(resizedCount()).toBe(0)
  })

  test("a real measurement still reaches the virtualizer", () => {
    const { virtualizer, resizedCount } = harness({ displayed: () => true })
    virtualizer.resizeItem(0, 240)
    expect(resizedCount()).toBe(1)
  })

  test("the resize itself still reaches the virtualizer while stashed", () => {
    const { virtualizer, resizedCount } = harness({ displayed: () => false })
    virtualizer.resizeItem(0, 100)
    // Measurements must keep flowing — only the re-anchor is gated, because the
    // cached sizes are what make the return switch cheap.
    expect(resizedCount()).toBe(1)
  })


})
