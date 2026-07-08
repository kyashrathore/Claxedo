import type { ChannelId } from "./envelope"

export type ChannelTransportKind = "fake" | "chat-sdk" | "baileys"

export type ChannelRegistration = {
  channel: ChannelId | "fake"
  enabled: boolean
  transport: ChannelTransportKind
  reason: string
  webhookPath: string
}

type Env = Record<string, string | undefined>

function truthy(input: string | undefined) {
  return input === "1" || input === "true" || input === "yes"
}

function any(env: Env, keys: string[]) {
  return keys.some((key) => !!env[key]?.trim())
}

export function createChannelRegistry(env: Env, options: { includeFake?: boolean } = {}) {
  const whatsappMode = env.CLAXEDO_CHANNEL_WHATSAPP_MODE === "personal" ? "personal" : "official"
  const registrations: ChannelRegistration[] = [
    {
      channel: "fake",
      enabled: options.includeFake === true,
      transport: "fake",
      reason: options.includeFake === true ? "local fake transport enabled" : "fake transport disabled",
      webhookPath: "/fake",
    },
    {
      channel: "github",
      enabled: truthy(env.CLAXEDO_CHANNEL_GITHUB_ENABLED) || any(env, [
        "GITHUB_APP_ID",
        "CLAXEDO_CHANNEL_GITHUB_APP_ID",
      ]),
      transport: "chat-sdk",
      reason: "GitHub Chat SDK adapter",
      webhookPath: "/github",
    },
    {
      channel: "telegram",
      enabled: (truthy(env.CLAXEDO_CHANNEL_TELEGRAM_ENABLED) || any(env, [
        "TELEGRAM_BOT_TOKEN",
        "CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN",
      ])) && any(env, ["TELEGRAM_WEBHOOK_SECRET_TOKEN", "CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN"]),
      transport: "chat-sdk",
      reason: any(env, ["TELEGRAM_WEBHOOK_SECRET_TOKEN", "CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN"])
        ? "Telegram Chat SDK adapter"
        : "Telegram Chat SDK adapter disabled until TELEGRAM_WEBHOOK_SECRET_TOKEN is set",
      webhookPath: "/telegram",
    },
    {
      channel: "slack",
      enabled: truthy(env.CLAXEDO_CHANNEL_SLACK_ENABLED) || any(env, [
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
      ]),
      transport: "chat-sdk",
      reason: "Slack Chat SDK adapter",
      webhookPath: "/slack",
    },
    {
      channel: "discord",
      enabled: truthy(env.CLAXEDO_CHANNEL_DISCORD_ENABLED) || any(env, [
        "DISCORD_BOT_TOKEN",
        "CLAXEDO_CHANNEL_DISCORD_BOT_TOKEN",
      ]),
      transport: "chat-sdk",
      reason: "Discord Chat SDK adapter",
      webhookPath: "/discord",
    },
    {
      channel: "whatsapp",
      enabled: truthy(env.CLAXEDO_CHANNEL_WHATSAPP_ENABLED) || any(env, [
        "WHATSAPP_ACCESS_TOKEN",
        "CLAXEDO_CHANNEL_WHATSAPP_ACCESS_TOKEN",
        "CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_SECRET_ID",
      ]),
      transport: whatsappMode === "personal" ? "baileys" : "chat-sdk",
      reason: whatsappMode === "personal" ? "WhatsApp personal Baileys adapter" : "WhatsApp official Chat SDK adapter",
      webhookPath: "/whatsapp",
    },
  ]
  return {
    registrations,
    enabled: registrations.filter((item) => item.enabled),
    byPath: new Map(registrations.map((item) => [item.webhookPath, item])),
  }
}
