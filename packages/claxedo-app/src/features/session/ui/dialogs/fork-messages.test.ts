import { describe, expect, test } from "bun:test"
import { forkableMessages, resolveForkSessionId, type ForkConversationSnapshot } from "./fork-messages"

// The fork dialog forks a specific session and lists its user turns. These
// specs pin the two regressions that made it show an empty list on the
// canonical route and the projection contract behind the rendered rows.

describe("resolveForkSessionId", () => {
  test("legacy `id` param resolves the session when no `sessionId` is present", () => {
    expect(resolveForkSessionId({ id: "ses_legacy" })).toBe("ses_legacy")
  })

  test("canonical `sessionId` param resolves the session", () => {
    expect(resolveForkSessionId({ sessionId: "ses_canonical" })).toBe("ses_canonical")
  })

  test("canonical `sessionId` wins when both params are present", () => {
    expect(resolveForkSessionId({ sessionId: "ses_canonical", id: "ses_legacy" })).toBe("ses_canonical")
  })

  test("returns undefined when neither param is present", () => {
    expect(resolveForkSessionId({})).toBeUndefined()
  })
})

describe("forkableMessages", () => {
  const formatTime = (date: Date) => `t:${date.getTime()}`

  test("projects one row per user message with its first eligible text part, newest first", () => {
    const snapshot: ForkConversationSnapshot = {
      messages: [
        { id: "m1", role: "user", time: { created: 1000 } },
        { id: "m2", role: "assistant", time: { created: 2000 } },
        { id: "m3", role: "user", time: { created: 3000 } },
      ],
      parts: {
        m1: [{ type: "text", text: "first" }],
        m2: [{ type: "text", text: "reply" }],
        m3: [{ type: "text", text: "second" }],
      },
    }

    expect(forkableMessages(snapshot, { formatTime })).toEqual([
      { id: "m3", text: "second", time: "t:3000" },
      { id: "m1", text: "first", time: "t:1000" },
    ])
  })

  test("collapses newlines and truncates each row to 200 characters", () => {
    const long = "a".repeat(150) + "\n" + "b".repeat(150)
    const snapshot: ForkConversationSnapshot = {
      messages: [{ id: "m1", role: "user", time: { created: 1 } }],
      parts: { m1: [{ type: "text", text: long }] },
    }

    const [row] = forkableMessages(snapshot, { formatTime })
    expect(row.text.length).toBe(200)
    expect(row.text).toBe("a".repeat(150) + " " + "b".repeat(49))
  })

  test("skips synthetic and ignored text parts, and messages with no eligible part", () => {
    const snapshot: ForkConversationSnapshot = {
      messages: [
        { id: "m1", role: "user", time: { created: 1 } },
        { id: "m2", role: "user", time: { created: 2 } },
        { id: "m3", role: "user", time: { created: 3 } },
      ],
      parts: {
        m1: [{ type: "text", text: "synthetic", synthetic: true }],
        m2: [{ type: "file" }, { type: "text", text: "ignored", ignored: true }],
        m3: [{ type: "file" }, { type: "text", text: "kept" }],
      },
    }

    expect(forkableMessages(snapshot, { formatTime })).toEqual([{ id: "m3", text: "kept", time: "t:3" }])
  })

  test("returns an empty list for a conversation with no user messages", () => {
    const snapshot: ForkConversationSnapshot = {
      messages: [{ id: "m1", role: "assistant", time: { created: 1 } }],
      parts: { m1: [{ type: "text", text: "hi" }] },
    }
    expect(forkableMessages(snapshot, { formatTime })).toEqual([])
  })
})
