import { describe, expect, test } from "bun:test"
import { legacyTerminalPersistScopeKey, sessionViewKey, terminalScopeKey } from "./session-view-key"

describe("sessionViewKey", () => {
  test("keys real sessions by workspace-scoped identity", () => {
    expect(sessionViewKey({ directory: "/repo/a", sessionId: "ses_1" })).toBe("workspace:%2Frepo%2Fa:session:ses_1")
    expect(sessionViewKey({ directory: "/repo/b", sessionId: "ses_1" })).toBe("workspace:%2Frepo%2Fb:session:ses_1")
    expect(sessionViewKey({ workspaceId: "ws_cloud_1", sessionId: "ses_1" })).toBe("workspace:ws_cloud_1:session:ses_1")
    expect(sessionViewKey({ sessionId: "ses_1" })).toBe("session:ses_1")
  })

  test("keys drafts by explicit draft id before workspace scope", () => {
    expect(sessionViewKey({
      directory: "/repo/main",
      sessionId: "new",
      draftId: "surface_1",
    })).toBe("draft:surface_1")
  })

  test("keys workspace draft sessions without base64 directory identity", () => {
    expect(sessionViewKey({ directory: "/repo/main", sessionId: "new" })).toBe("workspace:%2Frepo%2Fmain:draft")
    expect(sessionViewKey({ workspaceId: "ws_cloud_1" })).toBe("workspace:ws_cloud_1:draft")
  })
})

describe("terminalScopeKey", () => {
  test("uses raw trimmed directory or workspace scope", () => {
    expect(terminalScopeKey("  /repo/main  ")).toBe("/repo/main")
    expect(terminalScopeKey("  ws_cloud_1  ")).toBe("ws_cloud_1")
  })

  test("keeps old persisted bucket scope separate for terminal.v2 migration", () => {
    expect(legacyTerminalPersistScopeKey("/workspace")).toBe("L3dvcmtzcGFjZQ")
  })
})
