import type { ChannelCore } from "../core/command-emit"
import { parseChannelCommand } from "../core/channel-command"
import type { ApprovalDecision, ChannelChatType, ChannelId, InboundEnvelope } from "../envelope"
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
  /** Chat SDK's own 1:1 classification (`Postable.isDM`), when the thread has it. */
  isDM?: boolean
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

/**
 * Classify the Chat SDK thread as a DM or a group.
 *
 * `isDM` is the SDK's own answer (`Postable.isDM`) and wins when present. When
 * an adapter doesn't set it, the shared-room ids stand in: a `guildId` (Discord
 * server), `teamId` (Slack workspace), or `channelId` only exist for a room with
 * other people in it, whereas a 1:1 conversation carries only a conversation id.
 * Nothing to go on at all → "group", the stricter surface: reading a room as a
 * DM would run it under DM policy and skip mention-gating.
 */
function chatType(thread: ChatSdkBridgeThread): ChannelChatType {
  if (typeof thread.isDM === "boolean") return thread.isDM ? "dm" : "group"
  if (text(thread.guildId) || text(thread.teamId) || text(thread.channelId)) return "group"
  return text(thread.conversationId) ? "dm" : "group"
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

export function chatSdkEnvelope(
  thread: ChatSdkBridgeThread,
  message: ChatSdkMessage,
  options: { addressed?: boolean } = {},
): InboundEnvelope {
  const nextChannel = channel(thread.channel ?? thread.platform)
  const nextThreadKey = threadKey({ channel: nextChannel, thread })
  const text = message.text ?? ""
  const nextReceivedAt = receivedAt(message.timestamp)
  const repo = repoTargetFromText(text)
  // A mention is either the SDK telling us so (`message.isMention`), the
  // delivery path telling us so (`onNewMention` sets `addressed`), or the bot
  // name appearing in the text. The token itself is only used to strip a
  // leading mention before command parsing, so a synthetic marker is enough
  // when the SDK reported the fact without giving us the text span.
  const addressed = options.addressed === true || message.isMention === true
  const mentions = addressed ? ["@bot"] : []
  return {
    channel: nextChannel,
    externalUserId: message.author?.id ?? message.author?.userName ?? "unknown",
    threadKey: nextThreadKey,
    idempotencyKey: idempotencyKey({ threadKey: nextThreadKey, message, text, receivedAt: nextReceivedAt }),
    text,
    ...(nextReceivedAt ? { receivedAt: nextReceivedAt } : {}),
    chatType: chatType(thread),
    intent: parseChannelCommand(text),
    ...(mentions.length ? { mentions } : {}),
    ...(repo ? { repo } : {}),
    raw: message.raw ?? message,
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

/**
 * Rebuild the envelope threadKey from a button-action payload.
 *
 * The action carries the thread it was clicked in (`ActionEvent.thread`, or the
 * ids inline), so the key is composed with the SAME `threadKey()` — and the same
 * channel defaulting — used for inbound messages. The two must agree exactly or
 * the approval bridge's thread check would reject every legitimate press instead
 * of only the cross-thread ones.
 *
 * A payload carrying no thread identity returns undefined, so the decision
 * travels with no threadKey rather than one composed entirely from `threadKey()`
 * defaults ("default:conversation:root") — which would collide with any other
 * equally-empty thread.
 */
function actionThreadKey(action: unknown): string | undefined {
  const row = record(action)
  if (!row) return
  const nested = record(row.thread)
  const source = (nested ?? row) as ChatSdkBridgeThread
  const hasIdentity = firstText(
    source.threadId,
    source.threadTs,
    source.id,
    source.channelId,
    source.conversationId,
    source.messageId,
  )
  if (!hasIdentity) return
  return threadKey({ channel: channel(source.channel ?? source.platform), thread: source })
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
  const handle = async (
    thread: ChatSdkBridgeThread,
    message: ChatSdkMessage,
    options: { addressed?: boolean } = {},
  ) => {
    await thread.subscribe?.()
    await input.core.handleInbound(chatSdkEnvelope(thread, message, options), {
      reply: createChatSdkRenderer(thread, {
        editInPlace: input.editInPlace,
        editCadenceMs: input.editCadenceMs ?? editCadenceMs(thread.channel ?? thread.platform),
        nativeStreaming: input.nativeStreaming,
        dataMinimization: input.dataMinimization,
      }),
    })
  }
  // `onNewMention` fires only for messages that addressed the bot, so the
  // delivery path itself is the mention evidence. `onSubscribedMessage` fires
  // for every message in a subscribed thread, so those carry no such claim and
  // fall back to whatever the message payload says.
  input.bot.onNewMention?.((thread, message) => handle(thread, message, { addressed: true }))
  input.bot.onSubscribedMessage?.((thread, message) => handle(thread, message))
  input.bot.onAction?.(async (action) => {
    // The thread the button lives in is the SAME identity the prompt was posted
    // to, so deriving the threadKey here is what lets the approval bridge check
    // that a decision came from the thread that was asked — without it the
    // bridge's threadKey guard has nothing to compare and never fires.
    const threadKey = actionThreadKey(action)
    const decision = input.toApprovalDecision?.(action)
      ?? chatSdkApprovalDecision(action, threadKey ? { threadKey } : {})
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
