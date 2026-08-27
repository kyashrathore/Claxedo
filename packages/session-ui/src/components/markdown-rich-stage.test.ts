import { describe, expect, test } from "bun:test"
import {
  completedMarkdownRichDelayMs,
  scheduleCompletedMarkdownRichUpgrade,
} from "./markdown-rich-stage"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("completed Markdown rich staging", () => {
  test("keeps rich work outside the first-paint budget", () => {
    expect(completedMarkdownRichDelayMs).toBeGreaterThanOrEqual(80)
  })

  test("cancellation prevents the delayed upgrade", async () => {
    let upgraded = false
    const cancel = scheduleCompletedMarkdownRichUpgrade(() => {
      upgraded = true
    }, 20)

    cancel()
    await wait(30)
    expect(upgraded).toBe(false)
  })
})
