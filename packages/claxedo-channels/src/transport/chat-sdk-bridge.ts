import type { ChannelCore } from "../core/command-emit"
import { parseChannelCommand } from "../core/approval-token"
import type { ApprovalDecision, ChannelId, InboundEnvelope } from "../envelope"
import type { ChannelTextMinimizationOptions } from "../core/data-minimization"
import type { ChannelWebhookHandler } from "../ingress"
import { chatSdkApprovalDecision } from "./chat-sdk-actions"
import { createChatSdkRenderer, type ChatSdkThread } from "./chat-sdk-render"
import { repoTargetFromText } from "./repo-target"

export type ChatSdkMessage = {
  id?: string
  text?: string
  isMention?: boolean
  timestamp?: number | Date | string
  author?: {
    id?: string
    userName?: string
    fullName?: string
  }
  raw?: unknown
}

export type ChatSdkBridgeThread = ChatSdkThread & {
  id?: string
  threadId?: string
  channel?: string
  platform?: string
  installationId?: string
  teamId?: string
  guildId?: string
  channelId?: string
  conversationId?: string
  messageId?: string
  threadTs?: string
  thread_ts?: string
  subscribe?: () => Promise<unknown> | unknown
}

export type ChatSdkBot = {
  onNewMention?: (handler: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>) => unknown
  onSubscribedMessage?: (handler: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>) => unknown
  onAction?: (handler: (action: unknown) => Promise<void>) => unknown
  thread?: (threadId: string) => ChatSdkThread
  webhooks?: Partial<Record<ChannelId, ChannelWebhookHandler>>
}

function channel(input: unknown): ChannelId {
  if (input === "github" || input === "slack" || input === "telegram" || input === "discord" || input === "whatsapp") return input
  return "telegram"
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function firstText(...input: unknown[]) {
  for (const item of input) {
    const value = text(item)
    if (value) return value
  }
}

function threadKey(input: { channel: ChannelId; thread: ChatSdkBridgeThread }) {
  const installation = input.channel === "discord"
    ? firstText(input.thread.guildId, input.thread.installationId, input.thread.teamId) ?? "default"
    : firstText(input.thread.installationId, input.thread.teamId) ?? "default"
  const conversation = input.channel === "slack" || input.channel === "discord"
    ? firstText(input.thread.channelId, input.thread.conversationId, input.thread.id) ?? "conversation"
    : firstText(input.thread.conversationId, input.thread.channelId, input.thread.id) ?? "conversation"
  const root = input.channel === "slack"
    ? firstText(input.thread.threadTs, input.thread.thread_ts, input.thread.threadId, input.thread.id) ?? "root"
    : input.channel === "discord"
      ? firstText(input.thread.threadId, input.thread.messageId, input.thread.id) ?? "root"
      : firstText(input.thread.threadId, input.thread.id) ?? "root"
  return [
    input.channel,
    installation,
    conversation,
    root,
  ].join(":")
}

function receivedAt(input: unknown) {
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.getTime() : undefined
  if (typeof input === "string") {
    const parsed = Date.parse(input)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  return input < 10_000_000_000 ? input * 1000 : input
}

function idempotencyKey(input: { threadKey: string; message: ChatSdkMessage; text: string; receivedAt?: number }) {
  return input.message.id ?? `${input.threadKey}:${input.receivedAt ?? 0}:${input.text}`
}

export function chatSdkEnvelope(thread: ChatSdkBridgeThread, message: ChatSdkMessage): InboundEnvelope {
  const nextChannel = channel(thread.channel ?? thread.platform)
  const nextThreadKey = threadKey({ channel: nextChannel, thread })
  const text = message.text ?? ""
  const nextReceivedAt = receivedAt(message.timestamp)
  const repo = repoTargetFromText(text)
  return {
    channel: nextChannel,
    externalUserId: message.author?.id ?? message.author?.userName ?? "unknown",
    threadKey: nextThreadKey,
    idempotencyKey: idempotencyKey({ threadKey: nextThreadKey, message, text, receivedAt: nextReceivedAt }),
    text,
    ...(nextReceivedAt ? { receivedAt: nextReceivedAt } : {}),
    intent: parseChannelCommand(text),
    ...(repo ? { repo } : {}),
    raw: message.raw ?? message,
  }
}

export function createChatSdkBridge(input: {
  bot: ChatSdkBot
  core: ChannelCore
  editInPlace?: boolean
  editCadenceMs?: number
  /** SDK-native text streaming (thread.post(iterable)); default on. */
  nativeStreaming?: boolean
  dataMinimization?: ChannelTextMinimizationOptions
  toApprovalDecision?: (action: unknown) => ApprovalDecision | undefined
}) {
  const handle = async (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => {
    await thread.subscribe?.()
    await input.core.handleInbound(chatSdkEnvelope(thread, message), {
      reply: createChatSdkRenderer(thread, {
        editInPlace: input.editInPlace,
        editCadenceMs: input.editCadenceMs ?? editCadenceMs(thread.channel ?? thread.platform),
        nativeStreaming: input.nativeStreaming,
        dataMinimization: input.dataMinimization,
      }),
    })
  }
  input.bot.onNewMention?.(handle)
  input.bot.onSubscribedMessage?.(handle)
  input.bot.onAction?.(async (action) => {
    const decision = input.toApprovalDecision?.(action) ?? chatSdkApprovalDecision(action)
    if (decision) await input.core.onApproval(decision)
  })
  return {
    handle,
  }
}

function editCadenceMs(input: unknown) {
  if (input === "slack") return 250
  if (input === "telegram" || input === "discord" || input === "whatsapp" || input === "github") return 1000
  return 500
}
