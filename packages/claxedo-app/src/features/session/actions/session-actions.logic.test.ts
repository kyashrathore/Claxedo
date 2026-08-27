import { describe, expect, test } from "bun:test"

import { pathnameTargetsSession, sessionSelectionRoute, shouldBlockRemoteSessionHistoryAction } from "./session-actions.logic"

describe("session action source guard", () => {
  test("keeps local loopback session actions writable", () => {
    expect(shouldBlockRemoteSessionHistoryAction({
      serverUrl: "http://localhost:4444",
    })).toBe(false)
    expect(shouldBlockRemoteSessionHistoryAction({
      serverUrl: "http://127.0.0.1:4444",
    })).toBe(false)
  })

  test("blocks hosted remote history actions", () => {
    expect(shouldBlockRemoteSessionHistoryAction({
      serverUrl: "https://app.claxedo.test",
    })).toBe(true)
  })
})

describe("session action routes", () => {
  test("uses canonical session routes for existing session selection", () => {
    expect(sessionSelectionRoute({
      sessionId: "ses_1",
      canonicalRoute: (sessionId) => `/s/${sessionId}`,
    })).toBe("/s/ses_1")
  })

  test("recognizes active sessions from every supported browser route family", () => {
    expect(pathnameTargetsSession("/s/ses_1", "ses_1")).toBe(true)
    expect(pathnameTargetsSession("/w/ws_1/session/ses_1", "ses_1")).toBe(true)
    expect(pathnameTargetsSession("/L3JlcG8/session/ses_1", "ses_1")).toBe(true)
    expect(pathnameTargetsSession("/w/ws_1", "ses_1")).toBe(false)
    expect(pathnameTargetsSession("/s/ses_other", "ses_1")).toBe(false)
  })
})
