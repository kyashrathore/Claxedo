import { describe, expect, test } from "bun:test"

import { sessionSelectionRoute, shouldBlockRemoteSessionHistoryAction } from "./session-actions.logic"

describe("session action source guard", () => {
  test("keeps local loopback session actions writable", () => {
    expect(
      shouldBlockRemoteSessionHistoryAction({
        serverUrl: "http://localhost:4444",
      }),
    ).toBe(false)
    expect(
      shouldBlockRemoteSessionHistoryAction({
        serverUrl: "http://127.0.0.1:4444",
      }),
    ).toBe(false)
  })

  test("blocks hosted remote history actions", () => {
    expect(
      shouldBlockRemoteSessionHistoryAction({
        serverUrl: "https://app.claxedo.test",
      }),
    ).toBe(true)
  })
})

describe("session action routes", () => {
  test("uses canonical session routes for existing session selection", () => {
    expect(
      sessionSelectionRoute({
        sessionId: "ses_1",
        canonicalRoute: (sessionId) => `/s/${sessionId}`,
      }),
    ).toBe("/s/ses_1")
  })
})
