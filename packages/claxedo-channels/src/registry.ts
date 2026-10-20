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
  /** `@chat-adapter/github` HMACs each delivery with this for `x-hub-signature-256`. */
  webhookSecret?: string
  /** `@chat-adapter/slack` verifies `x-slack-signature` with this. */
  signingSecret?: string
  /** `@chat-adapter/discord` verifies each interaction's Ed25519 signature against this. */
  publicKey?: string
  accessToken?: string
  /** `@chat-adapter/whatsapp` HMACs each delivery with this for `x-hub-signature-256`. */
  appSecret?: string
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
  const github: ChannelAdapterConfig = {
    webhookSecret: firstConfigured(env, ["GITHUB_WEBHOOK_SECRET", "CLAXEDO_CHANNEL_GITHUB_WEBHOOK_SECRET"]),
  }
  const slack: ChannelAdapterConfig = {
    botToken: firstConfigured(env, ["SLACK_BOT_TOKEN"]),
    signingSecret: firstConfigured(env, ["SLACK_SIGNING_SECRET"]),
  }
  const discord: ChannelAdapterConfig = {
    botToken: firstConfigured(env, ["DISCORD_BOT_TOKEN", "CLAXEDO_CHANNEL_DISCORD_BOT_TOKEN"]),
    publicKey: firstConfigured(env, ["DISCORD_PUBLIC_KEY", "CLAXEDO_CHANNEL_DISCORD_PUBLIC_KEY"]),
  }
  const whatsapp: ChannelAdapterConfig = {
    accessToken: firstConfigured(env, ["WHATSAPP_ACCESS_TOKEN", "CLAXEDO_CHANNEL_WHATSAPP_ACCESS_TOKEN"]),
    appSecret: firstConfigured(env, ["WHATSAPP_APP_SECRET", "CLAXEDO_CHANNEL_WHATSAPP_APP_SECRET"]),
  }
  const whatsappOfficialVerified = whatsappMode === "personal" || !!whatsapp.appSecret
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
      enabled: (truthy(env.CLAXEDO_CHANNEL_GITHUB_ENABLED) || any(env, [
        "GITHUB_APP_ID",
        "CLAXEDO_CHANNEL_GITHUB_APP_ID",
      ])) && !!github.webhookSecret,
      transport: "chat-sdk",
      reason: github.webhookSecret
        ? "GitHub Chat SDK adapter"
        : "GitHub Chat SDK adapter disabled until GITHUB_WEBHOOK_SECRET is set",
      webhookPath: "/github",
      adapterConfig: github,
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
      enabled: (truthy(env.CLAXEDO_CHANNEL_SLACK_ENABLED) || any(env, [
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
      ])) && !!slack.signingSecret,
      transport: "chat-sdk",
      reason: slack.signingSecret
        ? "Slack Chat SDK adapter"
        : "Slack Chat SDK adapter disabled until SLACK_SIGNING_SECRET is set",
      webhookPath: "/slack",
      adapterConfig: slack,
    },
    {
      channel: "discord",
      enabled: (truthy(env.CLAXEDO_CHANNEL_DISCORD_ENABLED) || !!discord.botToken) && !!discord.publicKey,
      transport: "chat-sdk",
      reason: discord.publicKey
        ? "Discord Chat SDK adapter"
        : "Discord Chat SDK adapter disabled until DISCORD_PUBLIC_KEY is set",
      webhookPath: "/discord",
      adapterConfig: discord,
    },
    {
      channel: "whatsapp",
      enabled: (truthy(env.CLAXEDO_CHANNEL_WHATSAPP_ENABLED) || any(env, [
        "WHATSAPP_ACCESS_TOKEN",
        "CLAXEDO_CHANNEL_WHATSAPP_ACCESS_TOKEN",
        "CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_SECRET_ID",
      ])) && whatsappOfficialVerified,
      transport: whatsappMode === "personal" ? "baileys" : "chat-sdk",
      reason: whatsappMode === "personal"
        ? "WhatsApp personal Baileys adapter"
        : whatsappOfficialVerified
          ? "WhatsApp official Chat SDK adapter"
          : "WhatsApp official Chat SDK adapter disabled until WHATSAPP_APP_SECRET is set",
      webhookPath: "/whatsapp",
      ...(whatsappMode === "personal" ? {} : { adapterConfig: whatsapp }),
    },
  ]
  return {
    registrations,
    enabled: registrations.filter((item) => item.enabled),
    byPath: new Map(registrations.map((item) => [item.webhookPath, item])),
  }
}
