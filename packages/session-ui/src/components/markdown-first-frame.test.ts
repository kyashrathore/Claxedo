import { describe, expect, test } from "bun:test"
import { FIRST_FRAME_RICH_MAX_CHARS, escapedMarkdown, firstFrameHtml } from "./markdown-first-frame"

describe("firstFrameHtml", () => {
  // This runner has no DOM, so DOMPurify fails closed and the rich path yields
  // "" here; the markup itself is covered by the app's markdown-progressive
  // vitest under happy-dom. What this pins is which path a block takes.
  test("a block within the budget takes the parse path, not the escaped one", () => {
    const src = "some *emphasis* and a [link](https://example.com/x)"
    expect(firstFrameHtml(src)).not.toBe(escapedMarkdown(src))
  })

  test("a block over the budget paints as escaped text and leaves markup to the async parse", () => {
    const sentence = "some *emphasis* <b>not html</b> here.\n"
    const src = sentence.repeat(Math.ceil((FIRST_FRAME_RICH_MAX_CHARS + 1) / sentence.length))
    expect(src.length).toBeGreaterThan(FIRST_FRAME_RICH_MAX_CHARS)
    const html = firstFrameHtml(src)
    expect(html).toBe(escapedMarkdown(src))
    expect(html).not.toContain("<em>")
    expect(html).toContain("&lt;b&gt;not html&lt;/b&gt;")
    expect(html).toContain("<br>")
  })

  test("the budget is one the first frame can afford", () => {
    const src = "the quick brown fox *jumps* over the `lazy` dog. ".repeat(FIRST_FRAME_RICH_MAX_CHARS / 50)
    const started = performance.now()
    for (let i = 0; i < 5; i++) firstFrameHtml(src.slice(0, FIRST_FRAME_RICH_MAX_CHARS))
    expect((performance.now() - started) / 5).toBeLessThan(100)
  })
})
