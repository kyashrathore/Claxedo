import { parseChannelCommand } from "../core/channel-command"
import type { ChannelChatType, InboundEnvelope } from "../envelope"
import { repoTargetFromText } from "./repo-target"
import { asFiniteNumber, asRecord, asString } from "@claxedo/helpers/guards"

/** Telegram sends seconds; the envelope carries milliseconds. */
function receivedAt(input: unknown): number | undefined {
  const seconds = asFiniteNumber(input)
  return seconds ? seconds * 1000 : undefined
}

function message(input: Record<string, unknown>) {
  return asRecord(input.message) ?? asRecord(input.edited_message) ?? asRecord(input.channel_post)
}

function mentions(input: string, botName?: string) {
  if (!botName) return []
  const token = `@${botName.replace(/^@/, "")}`.toLowerCase()
  return input.toLowerCase().includes(token) ? [token] : []
}

/**
 * Who a raw Telegram message attributes itself to, as a stable id.
 *
 * `from.id` is the account id and never changes; `@username` is renameable and
 * reassignable, so it can key nothing. A message with no `from` was posted on
 * behalf of a chat (anonymous admin, channel post) — Telegram names the chat,
 * not a person, and `@chat-adapter/telegram` keys those as `chat:<id>`
 * (dist/index.js toReactionActorAuthor), so the same principal appears under
 * the same key on both ingress paths. The prefix keeps chat ids out of the
 * user-id namespace. Neither field → undefined; the update is not attributable.
 *
 * Exported because the Chat SDK bridge checks the SDK's author against it: the
 * Telegram adapter INVENTS an author from the chat when an update attributes
 * nobody, and one rule, read from the payload, is what keeps the two ingress
 * paths from disagreeing about who is speaking.
 */
export function telegramSenderId(message: unknown) {
  const row = asRecord(message)
  if (!row) return undefined
  const from = asFiniteNumber(asRecord(row.from)?.id)
  if (from !== undefined && Number.isSafeInteger(from) && from > 0) return String(from)
  const onBehalfOf = asFiniteNumber(asRecord(row.sender_chat)?.id)
  if (onBehalfOf !== undefined && Number.isSafeInteger(onBehalfOf)) return `chat:${onBehalfOf}`
  return undefined
}

/**
 * Telegram's `chat.type` is one of "private" | "group" | "supergroup" |
 * "channel". Only "private" is a 1:1 DM; the rest are multi-party rooms and
 * must land on the group surface. An absent or unrecognized type is treated as
 * a group: mistaking a room for a DM would run it under DM policy (which can be
 * "open") and skip mention-gating, so the unknown case takes the stricter side.
 */
function chatType(input: unknown): ChannelChatType {
  return input === "private" ? "dm" : "group"
}

export function telegramUpdateEnvelope(update: unknown, options: { botName?: string } = {}): InboundEnvelope | undefined {
  const payload = asRecord(update)
  if (!payload) return undefined
  const updateId = asFiniteNumber(payload.update_id)
  const msg = message(payload)
  const chat = asRecord(msg?.chat)
  if (updateId === undefined || !msg || !chat) return undefined
  const chatId = asFiniteNumber(chat.id) ?? asString(chat.id)
  if (chatId === undefined) return undefined
  const externalUserId = telegramSenderId(msg)
  // Every decision past this point — allowlist, pairing, binding, rate limit —
  // is made about a principal, so an unattributed update stops here rather
  // than reaching the access gate.
  if (!externalUserId) return undefined
  const text = asString(msg.text) ?? asString(msg.caption) ?? ""
  const repo = repoTargetFromText(text)
  const thread = String(asFiniteNumber(msg.message_thread_id) ?? chatId)
  const botMentions = mentions(text, options.botName)
  return {
    channel: "telegram",
    externalUserId,
    threadKey: `telegram:bot:${chatId}:${thread}`,
    idempotencyKey: `telegram:${updateId}`,
    text,
    receivedAt: receivedAt(msg.date),
    chatType: chatType(asString(chat.type)),
    intent: parseChannelCommand(text, { mentions: botMentions }),
    mentions: botMentions,
    ...(repo ? { repo } : {}),
    raw: update,
  }
}
