import { trimToUndefined } from "@claxedo/helpers/string"
import type { ChannelCore } from "../core/command-emit"
import { parseChannelCommand } from "../core/channel-command"
import type { ApprovalDecision, ChannelChatType, ChannelId, InboundEnvelope } from "../envelope"
import type { ChannelTextMinimizationOptions } from "../core/data-minimization"
import type { ChannelWebhookHandler } from "../ingress"
import { chatSdkApprovalDecision } from "./chat-sdk-actions"
import { createChatSdkRenderer, type ChatSdkThread } from "./chat-sdk-render"
import { repoTargetFromText } from "./repo-target"
import { telegramSenderId } from "./telegram"
import { record } from "../json"

/**
 * Chat SDK `Author`, narrowed to the fields this bridge reads.
 *
 * `userId` is the platform's stable account id and the ONLY identity here:
 * every adapter fills it from the immutable id (`user.id.toString()` on
 * GitHub, `String(user.id)` on Telegram). `userName` is the renameable handle
 * and `fullName` a display string; both are shown, neither is ever a key.
 */
export type ChatSdkAuthor = {
  userId: string
  userName?: string
  fullName?: string
}

export type ChatSdkMessage = {
  id?: string
  text?: string
  isMention?: boolean
  timestamp?: number | Date | string
  author?: ChatSdkAuthor
  raw?: unknown
}

/**
 * The ids a thread is addressed by, with no posting surface.
 *
 * Split out because `threadKey()` reads only these — a button-action payload
 * carries the same ids but is not a postable thread, and composing its key used
 * to mean asserting the payload WAS one.
 */
export type ChatSdkThreadIdentity = {
  id?: string
  threadId?: string
  /**
   * `Postable.adapter`; its `name` is the platform ("slack", "github", …).
   *
   * The SDK states the platform HERE and nowhere else a thread carries:
   * `Thread.channel` is a `Channel` object, so declaring a string `channel`
   * beside this made every real `Thread` unassignable to this type.
   */
  adapter?: { name?: string }
  installationId?: string
  teamId?: string
  guildId?: string
  channelId?: string
  conversationId?: string
  messageId?: string
  threadTs?: string
  thread_ts?: string
}

export type ChatSdkBridgeThread = ChatSdkThread & ChatSdkThreadIdentity & {
  /** Chat SDK's own 1:1 classification (`Postable.isDM`), when the thread has it. */
  isDM?: boolean
  subscribe?: () => unknown
}

export type ChatSdkBot = {
  onNewMention?: (handler: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>) => unknown
  onSubscribedMessage?: (handler: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>) => unknown
  onAction?: (handler: (action: unknown) => Promise<void>) => unknown
  thread?: (threadId: string) => ChatSdkThread
  webhooks?: Partial<Record<ChannelId, ChannelWebhookHandler>>
}

/**
 * Which platform a thread belongs to, per the adapter that delivered it.
 *
 * An unrecognized platform yields undefined and the message is dropped. The
 * channel is half of the `channel:externalUserId` key the access gate admits
 * on, so naming an unknown transport after a known one would file its senders
 * under that platform's allowlist and bindings.
 */
function threadChannel(thread: ChatSdkThreadIdentity): ChannelId | undefined {
  const name = trimToUndefined(thread.adapter?.name)
  if (name === "github" || name === "slack" || name === "telegram" || name === "discord" || name === "whatsapp") return name
  return undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function firstText(...input: unknown[]): string | undefined {
  for (const item of input) {
    const value = trimToUndefined(item)
    if (value) return value
  }
  return undefined
}

function threadKey(input: { channel: ChannelId; thread: ChatSdkThreadIdentity }) {
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
  if (trimToUndefined(thread.guildId) || trimToUndefined(thread.teamId) || trimToUndefined(thread.channelId)) return "group"
  return trimToUndefined(thread.conversationId) ? "dm" : "group"
}

/**
 * The sender the SDK reports, held to what the payload actually attributed.
 *
 * `Author.userId` is the platform's account id on every installed adapter but
 * one: `@chat-adapter/telegram` synthesizes an author from the CHAT when an
 * update carries neither `from` nor `sender_chat` (dist/index.js
 * parseTelegramMessage), so on Telegram the SDK's "user" can be a room that
 * named nobody. `telegramSenderId` re-reads the raw update under the rule the
 * direct webhook path uses, and an author the payload does not support is no
 * author — a message the platform left unattributed must not become a
 * principal that allowlists, bindings and approvals are then written against.
 */
function sender(channel: ChannelId, message: ChatSdkMessage) {
  const claimed = trimToUndefined(message.author?.userId)
  if (channel !== "telegram") return claimed
  return claimed && telegramSenderId(message.raw) === claimed ? claimed : undefined
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

/**
 * Normalize an SDK thread + message into an inbound envelope, or undefined when
 * the message names no platform or no sender. Both are keys the access gate,
 * the pairing store and the identity bindings are written in terms of, so a
 * message missing either is not admissible under any policy.
 */
export function chatSdkEnvelope(
  thread: ChatSdkBridgeThread,
  message: ChatSdkMessage,
  options: { addressed?: boolean } = {},
): InboundEnvelope | undefined {
  const nextChannel = threadChannel(thread)
  if (!nextChannel) return undefined
  const externalUserId = sender(nextChannel, message)
  if (!externalUserId) return undefined
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
    externalUserId,
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

/** The thread ids carried inline on a button-action payload. */
function threadIdentity(row: Record<string, unknown>): ChatSdkThreadIdentity {
  return {
    id: text(row.id),
    threadId: text(row.threadId),
    adapter: { name: text(record(row.adapter)?.name) },
    installationId: text(row.installationId),
    teamId: text(row.teamId),
    guildId: text(row.guildId),
    channelId: text(row.channelId),
    conversationId: text(row.conversationId),
    messageId: text(row.messageId),
    threadTs: text(row.threadTs),
    thread_ts: text(row.thread_ts),
  }
}

/**
 * The thread a button was pressed in, as the approval path needs it.
 *
 * The action carries the thread it was clicked in (`ActionEvent.thread`, or the
 * ids inline), so the key is composed with the SAME `threadKey()` used for
 * inbound messages. The two must agree exactly or the approval bridge's thread
 * check would reject every legitimate press instead of only the cross-thread
 * ones.
 *
 * An identified thread on an unrecognized platform yields undefined and the
 * press is dropped: no inbound message from that platform can have opened a
 * prompt (`chatSdkEnvelope` refuses it), so any prompt the press would resolve
 * belongs to some other thread — the exact case the key exists to catch.
 *
 * A payload carrying no thread identity at all yields no key rather than one
 * composed entirely from `threadKey()` defaults ("default:conversation:root"),
 * which would collide with any other equally-empty thread.
 */
function actionThread(action: unknown): { threadKey?: string } | undefined {
  const row = record(action)
  if (!row) return {}
  const source = threadIdentity(record(row.thread) ?? row)
  const hasIdentity = firstText(
    source.threadId,
    source.threadTs,
    source.id,
    source.channelId,
    source.conversationId,
    source.messageId,
  )
  if (!hasIdentity) return {}
  const nextChannel = threadChannel(source)
  if (!nextChannel) return undefined
  return { threadKey: threadKey({ channel: nextChannel, thread: source }) }
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
    const envelope = chatSdkEnvelope(thread, message, options)
    // Subscribing makes the bot a participant in someone's thread, and every
    // step after it is taken on behalf of a named principal. A message whose
    // platform or sender the SDK didn't give us ends here, before either.
    if (!envelope) return
    await thread.subscribe?.()
    await input.core.handleInbound(envelope, {
      reply: createChatSdkRenderer(thread, {
        editInPlace: input.editInPlace,
        editCadenceMs: input.editCadenceMs ?? editCadenceMs(envelope.channel),
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
    const pressed = actionThread(action)
    if (!pressed) return
    const decision = input.toApprovalDecision?.(action)
      ?? chatSdkApprovalDecision(action, pressed.threadKey ? { threadKey: pressed.threadKey } : {})
    if (decision) await input.core.onApproval(decision)
  })
  return {
    handle,
  }
}

function editCadenceMs(channel: ChannelId) {
  return channel === "slack" ? 250 : 1000
}
