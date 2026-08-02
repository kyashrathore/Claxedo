import { describe, expect, test } from "vitest"
import { createChannelRegistry } from "./registry"

describe("createChannelRegistry", () => {
  test("detects enabled chat-sdk channels from environment", () => {
    const registry = createChannelRegistry({
      GITHUB_APP_ID: "1",
      TELEGRAM_BOT_TOKEN: "telegram",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
      SLACK_BOT_TOKEN: "slack",
      DISCORD_BOT_TOKEN: "discord",
      WHATSAPP_ACCESS_TOKEN: "whatsapp",
    })

    expect(registry.enabled.map((item) => [item.channel, item.transport])).toEqual([
      ["github", "chat-sdk"],
      ["telegram", "chat-sdk"],
      ["slack", "chat-sdk"],
      ["discord", "chat-sdk"],
      ["whatsapp", "chat-sdk"],
    ])
  })

  test("does not enable Telegram without a webhook secret token", () => {
    const registry = createChannelRegistry({
      TELEGRAM_BOT_TOKEN: "telegram",
    })

    expect(registry.enabled.some((item) => item.channel === "telegram")).toBe(false)
  })

  test("selects Baileys only through WhatsApp personal mode", () => {
    const registry = createChannelRegistry({
      CLAXEDO_CHANNEL_WHATSAPP_MODE: "personal",
      CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_SECRET_ID: "secret",
    })

    expect(registry.enabled).toEqual([
      expect.objectContaining({ channel: "whatsapp", transport: "baileys" }),
    ])
  })
})
