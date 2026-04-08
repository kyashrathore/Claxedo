import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2"
import { stableSessionInfo, stableSessionMessages } from "./view-state"

function message(id: string): Message {
  return {
    id,
    sessionID: "s-1",
    role: "user",
    time: { created: 1 },
  } as Message
}

function session(id: string, title: string): Session {
  return {
    id,
    directory: "/ws",
    title,
    time: { created: 1, updated: 1 },
  } as Session
}

describe("stableSessionMessages", () => {
  test("keeps prior messages for the same session while sync data is temporarily missing", () => {
    const prev = stableSessionMessages(undefined, "s-1", [message("m-1"), message("m-2")])

    const next = stableSessionMessages(prev, "s-1", undefined)

    expect(next).toEqual(prev)
  })

  test("does not leak prior messages across session switches", () => {
    const prev = stableSessionMessages(undefined, "s-1", [message("m-1")])

    const next = stableSessionMessages(prev, "s-2", undefined)

    expect(next).toEqual({
      sessionId: "s-2",
      value: undefined,
    })
  })

  test("uses fresh loaded messages when they arrive again", () => {
    const prev = stableSessionMessages(undefined, "s-1", [message("m-1")])

    const next = stableSessionMessages(prev, "s-1", [message("m-3")])

    expect(next).toEqual({
      sessionId: "s-1",
      value: [message("m-3")],
    })
  })

  test("keeps an empty snapshot stable during same-session handoff gaps", () => {
    const prev = stableSessionMessages(undefined, "s-1", [])

    const next = stableSessionMessages(prev, "s-1", undefined)

    expect(next).toEqual({
      sessionId: "s-1",
      value: [],
    })
  })
})

describe("stableSessionInfo", () => {
  test("keeps prior session info for the same session while metadata is temporarily missing", () => {
    const prev = stableSessionInfo(undefined, "s-1", session("s-1", "Stable title"))

    const next = stableSessionInfo(prev, "s-1", undefined)

    expect(next).toEqual(prev)
  })

  test("does not leak prior info across session switches", () => {
    const prev = stableSessionInfo(undefined, "s-1", session("s-1", "Stable title"))

    const next = stableSessionInfo(prev, "s-2", undefined)

    expect(next).toBeUndefined()
  })
})
