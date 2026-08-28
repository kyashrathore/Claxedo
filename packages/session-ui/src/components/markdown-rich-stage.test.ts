import { describe, expect, test } from "bun:test"
import {
  clearCompletedMarkdownPaintCache,
  completedMarkdownRichDelayMs,
  hasCompletedMarkdownPaint,
  rememberCompletedMarkdownPaint,
  scheduleCompletedMarkdownRichUpgrade,
  shouldStageCompletedMarkdown,
} from "./markdown-rich-stage"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("completed Markdown rich staging", () => {
  test("cancellation prevents the delayed upgrade", async () => {
    let upgraded = false
    const cancel = scheduleCompletedMarkdownRichUpgrade(() => {
      upgraded = true
    }, 20)

    cancel()
    await wait(30)
    expect(upgraded).toBe(false)
  })

  test("never stages a completed body, including a never-seen cold mount", () => {
    clearCompletedMarkdownPaintCache()
    expect(
      shouldStageCompletedMarkdown({
        delayMs: completedMarkdownRichDelayMs,
        cacheKey: "part-new",
        text: "**hello**",
      }),
    ).toBe(false)
  })

  test("records that a completed body has painted rich for remount reuse", () => {
    clearCompletedMarkdownPaintCache()
    const cacheKey = "part-seen"
    const text = "**hello**\n\n```ts\nconst n = 1\n```"
    rememberCompletedMarkdownPaint(cacheKey, text)
    expect(hasCompletedMarkdownPaint(cacheKey, text)).toBe(true)
  })

  test("does not stage streaming bodies or explicit zero-delay surfaces", () => {
    clearCompletedMarkdownPaintCache()
    expect(shouldStageCompletedMarkdown({ streaming: true, delayMs: 96, text: "x" })).toBe(false)
    expect(shouldStageCompletedMarkdown({ delayMs: 0, text: "x" })).toBe(false)
  })
})
