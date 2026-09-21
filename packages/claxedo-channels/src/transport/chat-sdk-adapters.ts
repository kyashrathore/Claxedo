import type { ChannelId } from "../envelope"
import type { ChannelAdapterConfig, ChannelRegistration } from "../registry"
import { createMemoryStateAdapter } from "./chat-sdk-memory-state"
import { createChatSdkBridge, type ChatSdkBot } from "./chat-sdk-bridge"
import type { ChannelWebhookHandler } from "../ingress"
import type { ChannelCore } from "../core/command-emit"
import type { ChannelTextMinimizationOptions } from "../core/data-minimization"
import type { ApprovalDecision } from "../envelope"

type ModuleImporter = (specifier: string) => Promise<Record<string, unknown>>
type ChatConstructor = new (input: {
  userName: string
  adapters: Record<string, unknown>
  state?: unknown
}) => ChatSdkBot & { webhooks?: Partial<Record<ChannelId, ChannelWebhookHandler>> }

const CHAT_SDK_ADAPTERS = {
  github: {
    specifier: "@chat-adapter/github",
    factory: "createGitHubAdapter",
    load: async () => await import("@chat-adapter/github") as Record<string, unknown>,
  },
  slack: {
    specifier: "@chat-adapter/slack",
    factory: "createSlackAdapter",
    load: async () => await import("@chat-adapter/slack") as Record<string, unknown>,
  },
  telegram: {
    specifier: "@chat-adapter/telegram",
    factory: "createTelegramAdapter",
    load: async () => await import("@chat-adapter/telegram") as Record<string, unknown>,
  },
  discord: {
    specifier: "@chat-adapter/discord",
    factory: "createDiscordAdapter",
    load: async () => await import("@chat-adapter/discord") as Record<string, unknown>,
  },
  whatsapp: {
    specifier: "@chat-adapter/whatsapp",
    factory: "createWhatsAppAdapter",
    load: async () => await import("@chat-adapter/whatsapp") as Record<string, unknown>,
  },
} as const satisfies Record<ChannelId, {
  specifier: string
  factory: string
  load: () => Promise<Record<string, unknown>>
}>

const loadChatSdk = async () => await import("chat") as Record<string, unknown>

/**
 * The `chat` module and its adapter packages are loaded dynamically and reach
 * this file as `Record<string, unknown>` — deliberately, so tests can inject a
 * fake module. These two guards are the seam where a dynamically loaded export
 * is taken at its word; both check what JavaScript can check (callability) and
 * name what the vendor documents the export to be.
 */
function isAdapterFactory(value: unknown): value is (config?: ChannelAdapterConfig) => unknown {
  return typeof value === "function"
}

function isChatConstructor(value: unknown): value is ChatConstructor {
  return typeof value === "function"
}

function factory(module: Record<string, unknown>, name: string) {
  const value = module[name]
  if (!isAdapterFactory(value)) throw new Error(`Chat SDK factory ${name} is not available`)
  return value
}

/**
 * An enabled Telegram channel must arrive with both credentials resolved.
 * Whatever the registration leaves out, `@chat-adapter/telegram` answers from
 * `process.env` under its own fixed key — a second source that can disagree
 * with the one that enabled the channel, and for the secret token means an
 * adapter that logs a warning and then accepts every caller. Refusing the whole
 * bot rather than skipping the one adapter keeps that misconfiguration from
 * going unnoticed until a forged update has already been processed.
 */
function assertTelegramConfigured(registrations: ChannelRegistration[]) {
  for (const registration of registrations) {
    if (!registration.enabled || registration.channel !== "telegram" || registration.transport !== "chat-sdk") continue
    const unresolved: string[] = []
    if (!registration.adapterConfig?.botToken) unresolved.push("TELEGRAM_BOT_TOKEN")
    if (!registration.adapterConfig?.secretToken) unresolved.push("TELEGRAM_WEBHOOK_SECRET_TOKEN")
    if (unresolved.length > 0) {
      throw new Error(
        `Telegram ingress is enabled with ${unresolved.join(" and ")} unresolved. The channel registry must resolve both; the adapter's own process.env fallback is not a second source.`,
      )
    }
  }
}

export async function createChatSdkBot(input: {
  registrations: ChannelRegistration[]
  userName: string
  state?: unknown
  importer?: ModuleImporter
  onAdapterError?: (input: { channel: ChannelId; error: unknown }) => void
}) {
  assertTelegramConfigured(input.registrations)
  const chatModule = await (input.importer ? input.importer("chat") : loadChatSdk())
  const Chat = chatModule.Chat
  if (!isChatConstructor(Chat)) throw new Error("Chat SDK Chat constructor is not available")
  const entries = (await Promise.all(input.registrations.map(async (registration) => {
    if (!registration.enabled || registration.transport !== "chat-sdk" || registration.channel === "fake") return []
    try {
      const config = CHAT_SDK_ADAPTERS[registration.channel]
      const module = await (input.importer ? input.importer(config.specifier) : config.load())
      return [[registration.channel, factory(module, config.factory)(registration.adapterConfig)]]
    } catch (error) {
      input.onAdapterError?.({ channel: registration.channel, error })
      return []
    }
  }))).flat()
  const adapters = Object.fromEntries(entries)
  // The Chat SDK requires a state adapter (its first webhook calls
  // state.connect()); default to a single-process in-memory one when the
  // caller doesn't inject a shared (Redis/SQLite) adapter.
  return new Chat({
    userName: input.userName,
    adapters,
    state: input.state ?? createMemoryStateAdapter(),
  })
}

export async function createChatSdkChannelBot(input: {
  registrations: ChannelRegistration[]
  userName: string
  core: ChannelCore
  state?: unknown
  editInPlace?: boolean
  editCadenceMs?: number
  /** SDK-native text streaming (thread.post(iterable)); default on. */
  nativeStreaming?: boolean
  dataMinimization?: ChannelTextMinimizationOptions
  toApprovalDecision?: (action: unknown) => ApprovalDecision | undefined
  importer?: ModuleImporter
  onAdapterError?: (input: { channel: ChannelId; error: unknown }) => void
}) {
  const bot = await createChatSdkBot(input)
  createChatSdkBridge({
    bot,
    core: input.core,
    editInPlace: input.editInPlace,
    editCadenceMs: input.editCadenceMs,
    nativeStreaming: input.nativeStreaming,
    dataMinimization: input.dataMinimization,
    toApprovalDecision: input.toApprovalDecision,
  })
  return bot
}
