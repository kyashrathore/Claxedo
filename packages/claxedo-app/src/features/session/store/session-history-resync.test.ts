import { afterEach, describe, expect, test } from "bun:test"
import {
  requestSessionHistoryResync,
  resetSessionHistoryResyncForTest,
  sessionHistoryResyncMatches,
  sessionHistoryResyncRequest,
} from "./session-history-resync"

afterEach(() => {
  resetSessionHistoryResyncForTest()
})

describe("session history resync", () => {
  test("a workspace's request matches every session mounted for that workspace and no other's", () => {
    requestSessionHistoryResync({ directory: "/repo", reason: "sse-gap" })
    const request = sessionHistoryResyncRequest()
    expect(request).toMatchObject({ directory: "/repo", reason: "sse-gap" })
    expect(sessionHistoryResyncMatches({ request, sessionID: "ses_1", directory: "/repo" })).toBe(true)
    expect(sessionHistoryResyncMatches({ request, sessionID: "ses_2", directory: "/repo" })).toBe(true)
    expect(sessionHistoryResyncMatches({ request, sessionID: "ses_1", directory: "/other" })).toBe(false)
  })

  test("a workspace-wide request matches every mounted session", () => {
    requestSessionHistoryResync({ reason: "sse-gap" })
    const request = sessionHistoryResyncRequest()
    expect(sessionHistoryResyncMatches({ request, sessionID: "ses_1", directory: "/repo" })).toBe(true)
    expect(sessionHistoryResyncMatches({ request, sessionID: "ses_2", directory: "/other" })).toBe(true)
    expect(sessionHistoryResyncMatches({ request, sessionID: undefined, directory: "/repo" })).toBe(false)
  })

  test("each request carries a higher sequence so a controller answers each one once", () => {
    requestSessionHistoryResync({ reason: "sse-gap" })
    const first = sessionHistoryResyncRequest()!.sequence
    requestSessionHistoryResync({ reason: "sse-gap" })
    expect(sessionHistoryResyncRequest()!.sequence).toBeGreaterThan(first)
  })
})
