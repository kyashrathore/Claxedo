import { describe, expect, test } from "vitest"
import { createChannelRegistry } from "./registry"

describe("createChannelRegistry", () => {
  test("detects enabled chat-sdk channels from environment", () => {
    const registry = createChannelRegistry({
      GITHUB_APP_ID: "1",
      GITHUB_WEBHOOK_SECRET: "github-secret",
      TELEGRAM_BOT_TOKEN: "telegram",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
      SLACK_BOT_TOKEN: "slack",
      SLACK_SIGNING_SECRET: "slack-secret",
      DISCORD_BOT_TOKEN: "discord",
      DISCORD_PUBLIC_KEY: "discord-key",
      WHATSAPP_ACCESS_TOKEN: "whatsapp",
      WHATSAPP_APP_SECRET: "whatsapp-secret",
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
    expect(registry.byPath.get("/telegram")?.adapterConfig).toEqual({
      botToken: "telegram",
      secretToken: undefined,
    })
  })

  test("enables Telegram from the CLAXEDO_CHANNEL aliases alone and carries their secret", () => {
    const registry = createChannelRegistry({
      CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN: "alias-bot",
      CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN: "alias-secret",
    })

    expect(registry.enabled.some((item) => item.channel === "telegram")).toBe(true)
    expect(registry.byPath.get("/telegram")?.adapterConfig).toEqual({
      botToken: "alias-bot",
      secretToken: "alias-secret",
    })
  })

  test("prefers the canonical Telegram keys over their aliases", () => {
    const registry = createChannelRegistry({
      TELEGRAM_BOT_TOKEN: "canonical-bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "canonical-secret",
      CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN: "alias-bot",
      CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN: "alias-secret",
    })

    expect(registry.byPath.get("/telegram")?.adapterConfig).toEqual({
      botToken: "canonical-bot",
      secretToken: "canonical-secret",
    })
  })

  test("does not enable a webhook channel without its verification secret", () => {
    const registry = createChannelRegistry({
      CLAXEDO_CHANNEL_GITHUB_APP_ID: "1",
      SLACK_BOT_TOKEN: "slack",
      CLAXEDO_CHANNEL_DISCORD_BOT_TOKEN: "discord",
      CLAXEDO_CHANNEL_WHATSAPP_ACCESS_TOKEN: "whatsapp",
    })

    expect(registry.enabled).toEqual([])
    expect(registry.byPath.get("/github")?.reason).toContain("GITHUB_WEBHOOK_SECRET")
    expect(registry.byPath.get("/slack")?.reason).toContain("SLACK_SIGNING_SECRET")
    expect(registry.byPath.get("/discord")?.reason).toContain("DISCORD_PUBLIC_KEY")
    expect(registry.byPath.get("/whatsapp")?.reason).toContain("WHATSAPP_APP_SECRET")
  })

  test("carries each webhook channel's credentials, aliases included, to its adapter", () => {
    const registry = createChannelRegistry({
      CLAXEDO_CHANNEL_GITHUB_APP_ID: "1",
      CLAXEDO_CHANNEL_GITHUB_WEBHOOK_SECRET: "github-secret",
      SLACK_BOT_TOKEN: "slack",
      SLACK_SIGNING_SECRET: "slack-secret",
      CLAXEDO_CHANNEL_DISCORD_BOT_TOKEN: "discord",
      CLAXEDO_CHANNEL_DISCORD_PUBLIC_KEY: "discord-key",
      CLAXEDO_CHANNEL_WHATSAPP_ACCESS_TOKEN: "whatsapp",
      CLAXEDO_CHANNEL_WHATSAPP_APP_SECRET: "whatsapp-secret",
    })

    expect(registry.enabled.map((item) => [item.channel, item.adapterConfig])).toEqual([
      ["github", { webhookSecret: "github-secret" }],
      ["slack", { botToken: "slack", signingSecret: "slack-secret" }],
      ["discord", { botToken: "discord", publicKey: "discord-key" }],
      ["whatsapp", { accessToken: "whatsapp", appSecret: "whatsapp-secret" }],
    ])
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
