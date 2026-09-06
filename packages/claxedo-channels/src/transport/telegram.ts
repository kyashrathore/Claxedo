import { parseChannelCommand } from "../core/channel-command"
import type { ChannelChatType, InboundEnvelope } from "../envelope"
import { repoTargetFromText } from "./repo-target"
import { num, raw as str, record } from "../json"

/** Telegram sends seconds; the envelope carries milliseconds. */
function receivedAt(input: unknown): number | undefined {
  const seconds = num(input)
  return seconds ? seconds * 1000 : undefined
}

function message(input: Record<string, unknown>) {
  return record(input.message) ?? record(input.edited_message) ?? record(input.channel_post)
}

function mentions(input: string, botName?: string) {
  if (!botName) return []
  const token = `@${botName.replace(/^@/, "")}`.toLowerCase()
  return input.toLowerCase().includes(token) ? [token] : []
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
  const payload = record(update)
  if (!payload) return undefined
  const updateId = num(payload.update_id)
  const msg = message(payload)
  const chat = record(msg?.chat)
  if (updateId === undefined || !msg || !chat) return undefined
  const chatId = num(chat.id) ?? str(chat.id)
  if (chatId === undefined) return undefined
  const text = str(msg.text) ?? str(msg.caption) ?? ""
  const repo = repoTargetFromText(text)
  const from = record(msg.from)
  const externalUserId = String(num(from?.id) ?? str(from?.username) ?? chatId)
  const thread = String(num(msg.message_thread_id) ?? chatId)
  const botMentions = mentions(text, options.botName)
  return {
    channel: "telegram",
    externalUserId,
    threadKey: `telegram:bot:${chatId}:${thread}`,
    idempotencyKey: `telegram:${updateId}`,
    text,
    receivedAt: receivedAt(msg.date),
    chatType: chatType(str(chat.type)),
    intent: parseChannelCommand(text, { mentions: botMentions }),
    mentions: botMentions,
    ...(repo ? { repo } : {}),
    raw: update,
  }
}
