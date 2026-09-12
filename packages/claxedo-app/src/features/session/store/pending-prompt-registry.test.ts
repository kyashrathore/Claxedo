import { afterEach, describe, expect, test } from "bun:test"
import {
  clearPendingPrompt,
  clearPendingPromptsForTest,
  hasPendingPrompt,
  markPendingPromptSent,
  pendingPromptCount,
  registerPendingPrompt,
  takePendingPrompt,
} from "./pending-prompt-registry"

afterEach(() => {
  clearPendingPromptsForTest()
})

describe("pending prompt registry", () => {
  test("starts empty", () => {
    expect(pendingPromptCount()).toBe(0)
  })

  test("register/take round-trip preserves identity and removes entry", () => {
    const controller = new AbortController()
    let cleaned = 0
    registerPendingPrompt("ses_1", {
      abort: controller,
      cleanup: () => {
        cleaned++
      },
    })
    expect(hasPendingPrompt("ses_1")).toBe(true)
    const found = takePendingPrompt("ses_1")
    expect(found?.abort).toBe(controller)
    found?.cleanup()
    expect(cleaned).toBe(1)
    expect(pendingPromptCount()).toBe(0)
  })

  test("multiple sessions are independent", () => {
    registerPendingPrompt("ses_a", { abort: new AbortController(), cleanup: () => undefined })
    registerPendingPrompt("ses_b", { abort: new AbortController(), cleanup: () => undefined })
    expect(pendingPromptCount()).toBe(2)
    clearPendingPrompt("ses_a")
    expect(hasPendingPrompt("ses_a")).toBe(false)
    expect(hasPendingPrompt("ses_b")).toBe(true)
  })

  test("a sent prompt stays pending but surrenders its abort handle", () => {
    registerPendingPrompt("ses_1", { abort: new AbortController(), cleanup: () => undefined })
    markPendingPromptSent("ses_1")
    expect(hasPendingPrompt("ses_1")).toBe(true)
    expect(takePendingPrompt("ses_1")).toBeUndefined()
    expect(hasPendingPrompt("ses_1")).toBe(false)
  })
})
