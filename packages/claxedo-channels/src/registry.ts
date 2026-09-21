import type { ChannelId } from "./envelope"

export type ChannelTransportKind = "fake" | "chat-sdk" | "baileys"

/**
 * The credentials a `@chat-adapter/*` factory is constructed with.
 *
 * Every adapter also reads these from `process.env` on its own, under one fixed
 * key each. This registry accepts a `CLAXEDO_CHANNEL_*` alias per credential, so
 * an alias-configured channel would be enabled here and unconfigured there —
 * for Telegram's `secretToken` that means enabled ingress with verification off.
 * Resolving them here and constructing the adapter with them keeps one answer.
 */
export type ChannelAdapterConfig = {
  botToken?: string
  /** `@chat-adapter/telegram` compares this against `x-telegram-bot-api-secret-token`. */
  secretToken?: string
}

export type ChannelRegistration = {
  channel: ChannelId | "fake"
  enabled: boolean
  transport: ChannelTransportKind
  reason: string
  webhookPath: string
  adapterConfig?: ChannelAdapterConfig
}

type Env = Record<string, string | undefined>

function truthy(input: string | undefined) {
  return input === "1" || input === "true" || input === "yes"
}

/** First non-blank value; the canonical key precedes its aliases. */
function firstConfigured(env: Env, keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function any(env: Env, keys: string[]) {
  return firstConfigured(env, keys) !== undefined
}

export function createChannelRegistry(env: Env, options: { includeFake?: boolean } = {}) {
  const whatsappMode = env.CLAXEDO_CHANNEL_WHATSAPP_MODE === "personal" ? "personal" : "official"
  const telegram: ChannelAdapterConfig = {
    botToken: firstConfigured(env, ["TELEGRAM_BOT_TOKEN", "CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN"]),
    secretToken: firstConfigured(env, ["TELEGRAM_WEBHOOK_SECRET_TOKEN", "CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN"]),
  }
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
      enabled: (truthy(env.CLAXEDO_CHANNEL_TELEGRAM_ENABLED) || !!telegram.botToken) && !!telegram.secretToken,
      transport: "chat-sdk",
      reason: telegram.secretToken
        ? "Telegram Chat SDK adapter"
        : "Telegram Chat SDK adapter disabled until TELEGRAM_WEBHOOK_SECRET_TOKEN is set",
      webhookPath: "/telegram",
      adapterConfig: telegram,
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
