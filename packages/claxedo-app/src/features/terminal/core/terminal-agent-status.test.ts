import { describe, expect, test } from "bun:test"
import { terminalAgentStatusFromEventType } from "./terminal-agent-status"

describe("terminalAgentStatusFromEventType", () => {
  test("maps every runtime lifecycle state to the shared terminal status vocabulary", () => {
    expect(terminalAgentStatusFromEventType("Busy")).toBe("working")
    expect(terminalAgentStatusFromEventType("Idle")).toBe("idle")
    expect(terminalAgentStatusFromEventType("UserActionRequired")).toBe("permission")
    expect(terminalAgentStatusFromEventType("Error")).toBe("permission")
    expect(terminalAgentStatusFromEventType("unknown")).toBeUndefined()
  })
})
