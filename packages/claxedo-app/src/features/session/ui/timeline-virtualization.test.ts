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

    expect(estimateLongMarkdownHeight(text)).toBe(text.split("\n").length * 24)
  })

  test("caps adversarial transcripts", () => {
    expect(estimateLongMarkdownHeight(Array.from({ length: 1_000 }, () => "- row").join("\n"))).toBe(6_000)
  })

  test("reserves the complete line viewport for a large fenced block", () => {
    const text = ["```ts", ...Array.from({ length: 240 }, (_, index) => `export const value${index} = ${index}`), "```"].join("\n")
    expect(estimateLongMarkdownHeight(text)).toBe(240 * 24 + 36)
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

  test("the resize itself still reaches the virtualizer while stashed", () => {
    const { virtualizer, resizedCount } = harness({ displayed: () => false })
    virtualizer.resizeItem(0, 100)
    // Measurements must keep flowing — only the re-anchor is gated, because the
    // cached sizes are what make the return switch cheap.
    expect(resizedCount()).toBe(1)
  })


})
