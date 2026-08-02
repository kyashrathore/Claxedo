import { describe, expect, test } from "vitest"
import { telegramUpdateEnvelope } from "./telegram"

describe("telegramUpdateEnvelope", () => {
  test("normalizes Telegram message updates into namespaced envelopes", () => {
    expect(telegramUpdateEnvelope({
      update_id: 123,
      message: {
        message_id: 9,
        date: 1_700_000_000,
        message_thread_id: 44,
        from: { id: 11 },
        chat: { id: -1001 },
        text: "hello @claxedo",
      },
    }, { botName: "claxedo" })).toMatchObject({
      channel: "telegram",
      externalUserId: "11",
      threadKey: "telegram:bot:-1001:44",
      idempotencyKey: "telegram:123",
      receivedAt: 1_700_000_000_000,
      text: "hello @claxedo",
      mentions: ["@claxedo"],
    })
  })

  test("parses commands at the transport boundary but never approvals", () => {
    expect(telegramUpdateEnvelope({
      update_id: 124,
      message: { chat: { id: 1 }, from: { id: 2 }, text: "/stop" },
    })).toMatchObject({ intent: { kind: "cancel" } })
    // Approval decisions are made by button press or judge, never by parsing.
    expect(telegramUpdateEnvelope({
      update_id: 125,
      message: { chat: { id: 1 }, from: { id: 2 }, text: "approve a7f3" },
    })).toMatchObject({ intent: { kind: "message" } })
  })

  test("strips a leading bot mention before matching commands", () => {
    expect(telegramUpdateEnvelope({
      update_id: 130,
      message: { chat: { id: 1 }, from: { id: 2 }, text: "@claxedo /status" },
    }, { botName: "claxedo" })).toMatchObject({ intent: { kind: "status" } })
  })

  test("parses repo targets from Telegram text", () => {
    expect(telegramUpdateEnvelope({
      update_id: 126,
      message: {
        chat: { id: 1 },
        from: { id: 2 },
        text: "repo:acme/tools fix the failing test",
      },
    })).toMatchObject({
      repo: { owner: "acme", name: "tools" },
    })
  })

  test("classifies chat.type: only private is a DM", () => {
    // Telegram's own vocabulary. Everything that is not "private" is a room
    // with other people in it and must land on the group surface, where the
    // deny-by-default group policy and mention-gating apply.
    const classify = (type: unknown) => telegramUpdateEnvelope({
      update_id: 200,
      message: { chat: { id: 1, type }, from: { id: 2 }, text: "hi" },
    })?.chatType
    expect(classify("private")).toBe("dm")
    expect(classify("group")).toBe("group")
    expect(classify("supergroup")).toBe("group")
    expect(classify("channel")).toBe("group")
  })

  test("an absent or unrecognized chat.type falls to the group surface", () => {
    // Fail-closed: reading a room as a DM would run it under DM policy (which
    // may be "open") and skip mention-gating, so the unknown case takes the
    // stricter side rather than the convenient one.
    const classify = (type: unknown) => telegramUpdateEnvelope({
      update_id: 201,
      message: { chat: { id: 1, ...(type === undefined ? {} : { type }) }, from: { id: 2 }, text: "hi" },
    })?.chatType
    expect(classify(undefined)).toBe("group")
    expect(classify("some_future_type")).toBe("group")
    expect(classify(42)).toBe("group")
  })
})
