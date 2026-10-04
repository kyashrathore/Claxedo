import { describe, expect, test } from "vitest"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { ThreadImpl } from "chat"
import { chatSdkEnvelope } from "./chat-sdk-bridge"
import { createMemoryStateAdapter } from "./chat-sdk-memory-state"
import { telegramUpdateEnvelope } from "./telegram"

describe("Telegram identity through the installed adapter", () => {
  const adapter = createTelegramAdapter({ botToken: "fixture-token", secretToken: "fixture-secret", userName: "fixture_bot", mode: "webhook" })
  const base = { message_id: 1, date: 1_700_000_000, chat: { id: -1001, type: "supergroup" as const }, text: "hello" }

  function envelope(raw: Parameters<typeof adapter.parseMessage>[0]) {
    const message = adapter.parseMessage(raw)
    const thread = new ThreadImpl({ adapter, stateAdapter: createMemoryStateAdapter(), id: message.threadId, channelId: "telegram:-1001", isDM: false })
    return chatSdkEnvelope(thread, message)
  }

  test("uses the same account id after a rename on both ingress paths", () => {
    for (const username of ["before", "after"]) {
      const raw = { ...base, from: { id: 123, is_bot: false, first_name: "Person", username } }
      expect(envelope(raw)).toMatchObject({ channel: "telegram", externalUserId: "123" })
      expect(telegramUpdateEnvelope({ update_id: 1, message: raw })).toMatchObject({ externalUserId: "123" })
    }
  })

  test("does not turn the SDK's missing-sender chat fallback into a principal", () => {
    expect(adapter.parseMessage(base).author.userId).toBe("-1001")
    expect(telegramUpdateEnvelope({ update_id: 1, message: base })).toBeUndefined()
    expect(envelope(base)).toBeUndefined()
  })

  test("keeps an explicit on-behalf chat principal separate from an account", () => {
    const raw = { ...base, sender_chat: { id: -2002, type: "channel" as const, title: "Channel" } }
    expect(envelope(raw)).toMatchObject({ channel: "telegram", externalUserId: "chat:-2002" })
    expect(telegramUpdateEnvelope({ update_id: 1, message: raw })).toMatchObject({ externalUserId: "chat:-2002" })
  })
})
