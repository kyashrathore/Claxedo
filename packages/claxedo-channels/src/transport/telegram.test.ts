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

  test("parses stop and approval replies at the transport boundary", () => {
    expect(telegramUpdateEnvelope({
      update_id: 124,
      message: { chat: { id: 1 }, from: { id: 2 }, text: "/stop" },
    })).toMatchObject({ intent: { kind: "cancel" } })
    expect(telegramUpdateEnvelope({
      update_id: 125,
      message: { chat: { id: 1 }, from: { id: 2 }, text: "approve a7f3" },
    })).toMatchObject({ intent: { kind: "approval_reply", approved: true, token: "a7f3" } })
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
})
