import type { ChannelId } from "../envelope"
import type { ChannelRegistration } from "../registry"
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
  github: { specifier: "@chat-adapter/github", factory: "createGitHubAdapter" },
  slack: { specifier: "@chat-adapter/slack", factory: "createSlackAdapter" },
  telegram: { specifier: "@chat-adapter/telegram", factory: "createTelegramAdapter" },
  discord: { specifier: "@chat-adapter/discord", factory: "createDiscordAdapter" },
  whatsapp: { specifier: "@chat-adapter/whatsapp", factory: "createWhatsAppAdapter" },
} as const satisfies Record<ChannelId, { specifier: string; factory: string }>

async function dynamicImport(specifier: string) {
  return await import(specifier) as Record<string, unknown>
}

function factory(module: Record<string, unknown>, name: string) {
  const value = module[name]
  if (typeof value !== "function") throw new Error(`Chat SDK factory ${name} is not available`)
  return value as () => unknown
}

export async function createChatSdkBot(input: {
  registrations: ChannelRegistration[]
  userName: string
  state?: unknown
  importer?: ModuleImporter
  onAdapterError?: (input: { channel: ChannelId; error: unknown }) => void
}) {
  const importer = input.importer ?? dynamicImport
  const chatModule = await importer("chat")
  const Chat = chatModule.Chat
  if (typeof Chat !== "function") throw new Error("Chat SDK Chat constructor is not available")
  const entries = (await Promise.all(input.registrations.map(async (registration) => {
    if (!registration.enabled || registration.transport !== "chat-sdk" || registration.channel === "fake") return []
    try {
      const config = CHAT_SDK_ADAPTERS[registration.channel]
      return [[registration.channel, factory(await importer(config.specifier), config.factory)()]]
    } catch (error) {
      input.onAdapterError?.({ channel: registration.channel, error })
      return []
    }
  }))).flat()
  const adapters = Object.fromEntries(entries)
  // The Chat SDK requires a state adapter (its first webhook calls
  // state.connect()); default to a single-process in-memory one when the
  // caller doesn't inject a shared (Redis/SQLite) adapter.
  return new (Chat as ChatConstructor)({
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
