import { describe, expect, test } from "bun:test"
import { shouldFanOutGlobalEventToWorkspaceStores } from "./global-event-refresh-policy"

describe("global event refresh policy", () => {
  test("does not fan out global reconnects because workspace hosts refresh independently", () => {
    expect(shouldFanOutGlobalEventToWorkspaceStores("server.connected")).toBe(false)
  })

  test("fans out only when global state was actually disposed", () => {
    expect(shouldFanOutGlobalEventToWorkspaceStores("global.disposed")).toBe(true)
  })
})
