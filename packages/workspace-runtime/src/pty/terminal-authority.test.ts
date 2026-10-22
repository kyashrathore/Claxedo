import { describe, expect, test } from "bun:test"
import { terminalCallerRefusal } from "./terminal-authority"

describe("terminalCallerRefusal", () => {
  const authority = { managed: true as const, workspaceId: "ws_1", orgId: "org_1", role: "editor" as const }

  test("a session-scoped token and a viewer are refused before any authority is asked", () => {
    expect(terminalCallerRefusal({ authority: { ...authority, sessionId: "ses_1" } })?.code).toBe("relay_scope_denied")
    expect(terminalCallerRefusal({ authority: { ...authority, role: "viewer" } })?.code).toBe("terminal_role_denied")
    expect(terminalCallerRefusal({ authority })).toBeUndefined()
    expect(terminalCallerRefusal({})).toBeUndefined()
  })
})
