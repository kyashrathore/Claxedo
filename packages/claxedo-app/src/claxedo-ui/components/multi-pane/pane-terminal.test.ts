import { describe, expect, test } from "bun:test"
import { shouldWaitForQueuedCreate } from "./pane-terminal-logic"

describe("shouldWaitForQueuedCreate", () => {
  test("waits when pending terminal is the tab primary terminal", () => {
    const result = shouldWaitForQueuedCreate({
      tabTerminalId: "pending-main",
      pendingTerminalId: "pending-main",
    })
    expect(result).toBe(true)
  })

  test("does not wait for split-created pending terminals in terminal tabs", () => {
    const result = shouldWaitForQueuedCreate({
      tabTerminalId: "pending-main",
      pendingTerminalId: "pending-split",
    })
    expect(result).toBe(false)
  })

  test("does not wait when tab has no primary terminal id", () => {
    const result = shouldWaitForQueuedCreate({
      tabTerminalId: undefined,
      pendingTerminalId: "pending-main",
    })
    expect(result).toBe(false)
  })
})
