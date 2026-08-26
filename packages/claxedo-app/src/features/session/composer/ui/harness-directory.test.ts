import { describe, expect, test } from "bun:test"
import { promptHarnessDirectory } from "./harness-directory"

describe("promptHarnessDirectory", () => {
  test("uses the visible SDK directory for new draft sessions", () => {
    expect(
      promptHarnessDirectory({
        sdkDirectory: "workspace:ws_cloud",
        sessionDirectory: "/repo/existing-session",
        sessionId: "new",
      }),
    ).toBe("workspace:ws_cloud")
  })

  test("uses the target session directory once an existing session is locked", () => {
    expect(
      promptHarnessDirectory({
        sdkDirectory: "workspace:ws_cloud",
        sessionDirectory: "/repo/existing-session",
        sessionId: "sess_123",
      }),
    ).toBe("/repo/existing-session")
  })

  test("falls back to SDK directory when an existing session has no directory", () => {
    expect(
      promptHarnessDirectory({
        sdkDirectory: "workspace:ws_cloud",
        sessionId: "sess_123",
      }),
    ).toBe("workspace:ws_cloud")
  })
})
