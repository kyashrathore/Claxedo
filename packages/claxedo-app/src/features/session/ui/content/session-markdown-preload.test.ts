import { describe, expect, test } from "bun:test"
import {
  assistantMessageIsLive,
  firstFoldMarkdownBodies,
  firstFoldMarkdownIdentityIsLive,
  firstFoldMarkdownPreloadIdentity,
  sessionMarkdownTimelineGate,
} from "./session-markdown-preload"
import type { Part } from "@opencode-ai/sdk/v2/client"

function textPart(id: string, text: string): Part {
  return { id, type: "text", text } as Part
}

describe("firstFoldMarkdownBodies", () => {
  test("takes settled latest-turn text parts so session switches can preload distinct loads", () => {
    const bodies = firstFoldMarkdownBodies({
      messages: [
        { id: "msg_old", role: "assistant", time: { completed: 1 } },
        { id: "msg_user", role: "user" },
        { id: "msg_assistant", role: "assistant", time: { completed: 2 } },
      ],
      parts: {
        msg_old: [textPart("prt_old", "# Old markdown")],
        msg_user: [textPart("prt_user", "please show a table")],
        msg_assistant: [
          textPart(
            "prt_table",
            "| Feature | Before | After |\n|---------|--------|-------|\n| Speed | 120ms | 45ms |",
          ),
        ],
      },
    })
    expect(bodies.map((body) => body.cacheKey)).toEqual(["prt_user", "prt_table"])
    expect(bodies[1]?.text).toContain("| Feature | Before | After |")
  })

  test("does not preload an in-progress assistant body", () => {
    const bodies = firstFoldMarkdownBodies({
      messages: [
        { id: "msg_user", role: "user" },
        { id: "msg_assistant", role: "assistant", time: {} },
      ],
      parts: {
        msg_user: [textPart("prt_user", "write a heading")],
        msg_assistant: [textPart("prt_live", "# Still streaming")],
      },
    })
    expect(bodies.map((body) => body.cacheKey)).toEqual(["prt_user"])
  })
})

describe("sessionMarkdownTimelineGate", () => {
  test("opens immediately for a live first-fold assistant", () => {
    const identity = firstFoldMarkdownPreloadIdentity([
      { id: "msg_user", role: "user" },
      { id: "msg_assistant", role: "assistant", time: {} },
    ])
    expect(firstFoldMarkdownIdentityIsLive(identity)).toBe(true)
    expect(
      sessionMarkdownTimelineGate({
        messagesReady: true,
        sessionKey: "ses_1",
        firstFoldIdentity: identity,
      }),
    ).toBe("live")
  })

  test("identity stays stable when only the live body text grows", () => {
    const messages = [
      { id: "msg_user", role: "user" },
      { id: "msg_assistant", role: "assistant", time: {} },
    ]
    expect(firstFoldMarkdownPreloadIdentity(messages)).toBe("msg_user:settled|msg_assistant:live")
    expect(firstFoldMarkdownPreloadIdentity(messages)).toBe("msg_user:settled|msg_assistant:live")
  })

  test("preloads only after a settled first fold is ready", () => {
    expect(assistantMessageIsLive({ id: "msg_assistant", role: "assistant", time: { completed: 1 } })).toBe(false)
    expect(
      sessionMarkdownTimelineGate({
        messagesReady: true,
        sessionKey: "ses_1",
        firstFoldIdentity: firstFoldMarkdownPreloadIdentity([
          { id: "msg_user", role: "user" },
          { id: "msg_assistant", role: "assistant", time: { completed: 1 } },
        ]),
      }),
    ).toBe("preload")
  })

  test("stays blocked until messages for this session are ready", () => {
    expect(
      sessionMarkdownTimelineGate({
        messagesReady: false,
        sessionKey: "ses_1",
        firstFoldIdentity: "msg_assistant:settled",
      }),
    ).toBe("blocked")
  })
})
