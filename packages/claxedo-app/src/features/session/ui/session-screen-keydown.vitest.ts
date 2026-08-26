import { describe, expect, test, vi } from "vitest"
import { createSessionScreenKeydownHandler } from "./session-screen-keydown"

describe("session screen keydown ownership", () => {
  test("a retained hidden session does not inspect or handle document keydown", () => {
    const dialogActive = vi.fn(() => false)
    const inputEl = vi.fn(() => undefined)
    const composerBlocked = vi.fn(() => false)
    const cursor = vi.fn(() => 0)
    const current = vi.fn(() => [])
    const markScrollGesture = vi.fn()
    const handler = createSessionScreenKeydownHandler({
      active: () => false,
      dialogActive,
      inputEl,
      composerBlocked,
      prompt: { cursor, current } as never,
      markScrollGesture,
    })

    handler(new KeyboardEvent("keydown", { key: "a" }))

    expect(dialogActive).not.toHaveBeenCalled()
    expect(inputEl).not.toHaveBeenCalled()
    expect(composerBlocked).not.toHaveBeenCalled()
    expect(cursor).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    expect(markScrollGesture).not.toHaveBeenCalled()
  })
})
