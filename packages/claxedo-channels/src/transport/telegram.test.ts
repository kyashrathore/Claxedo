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

  test("keys the sender by account id, so a rename stays the same principal", () => {
    // Telegram lets an account change its @username and lets the next account
    // claim the freed one, so the handle names a different human over time.
    const send = (from: Record<string, unknown>) => telegramUpdateEnvelope({
      update_id: 300,
      message: { chat: { id: 1, type: "private" }, from, text: "hello" },
    })?.externalUserId

    expect(send({ id: 11, username: "owner" })).toBe("11")
    expect(send({ id: 11, username: "owner_renamed" })).toBe("11")
    expect(send({ id: 22, username: "owner" })).toBe("22")
  })

  test("refuses an update that names no account", () => {
    // A @username alone, or the chat the message landed in, would both stand in
    // for a principal the update never identified.
    expect(telegramUpdateEnvelope({
      update_id: 301,
      message: { chat: { id: 1, type: "private" }, from: { username: "owner" }, text: "hello" },
    })).toBeUndefined()
    expect(telegramUpdateEnvelope({
      update_id: 302,
      message: { chat: { id: -1001, type: "supergroup" }, text: "hello" },
    })).toBeUndefined()
  })

  test("keys a post made on behalf of a chat under the adapter's chat key", () => {
    // Anonymous admins and channel posts carry `sender_chat` instead of `from`;
    // `@chat-adapter/telegram` names those `chat:<id>`, so both ingress paths
    // hand the access gate the same principal — and the prefix keeps chat ids
    // out of the user-id namespace.
    expect(telegramUpdateEnvelope({
      update_id: 303,
      message: {
        chat: { id: -1001, type: "supergroup" },
        sender_chat: { id: -1001, title: "Acme Ops", type: "supergroup" },
        text: "hello",
      },
    })).toMatchObject({ externalUserId: "chat:-1001" })
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
