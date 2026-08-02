import { parseChannelCommand } from "../core/channel-command"
import type { ChannelChatType, InboundEnvelope } from "../envelope"
import { repoTargetFromText } from "./repo-target"

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function str(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
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
  if (!payload) return
  const updateId = num(payload.update_id)
  const msg = message(payload)
  const chat = record(msg?.chat)
  if (updateId === undefined || !msg || !chat) return
  const chatId = num(chat.id) ?? str(chat.id)
  if (chatId === undefined) return
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
    receivedAt: num(msg.date) ? num(msg.date)! * 1000 : undefined,
    chatType: chatType(str(chat.type)),
    intent: parseChannelCommand(text, { mentions: botMentions }),
    mentions: botMentions,
    ...(repo ? { repo } : {}),
    raw: update,
  }
}
