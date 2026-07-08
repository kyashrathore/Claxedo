import { parseChannelCommand } from "../core/approval-token"
import type { InboundEnvelope } from "../envelope"
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
  return {
    channel: "telegram",
    externalUserId,
    threadKey: `telegram:bot:${chatId}:${thread}`,
    idempotencyKey: `telegram:${updateId}`,
    text,
    receivedAt: num(msg.date) ? num(msg.date)! * 1000 : undefined,
    intent: parseChannelCommand(text),
    mentions: mentions(text, options.botName),
    ...(repo ? { repo } : {}),
    raw: update,
  }
}
