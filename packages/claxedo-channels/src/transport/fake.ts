import type { Context } from "hono"
import type { ChannelChatType, ChannelId, InboundEnvelope, OutboundChunk } from "../envelope"
import type { ChannelCore } from "../core/command-emit"

function channel(input: unknown): ChannelId {
  if (input === "github" || input === "slack" || input === "telegram" || input === "discord" || input === "whatsapp") return input
  return "telegram"
}

function str(input: unknown, fallback: string) {
  return typeof input === "string" && input.length > 0 ? input : fallback
}

function intent(input: unknown): InboundEnvelope["intent"] {
  if (!input || typeof input !== "object") return { kind: "message" }
  const row = input as Record<string, unknown>
  if (row.kind === "cancel") return { kind: "cancel", ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}) }
  if (row.kind === "approval_reply" && typeof row.callId === "string") {
    return { kind: "approval_reply", callId: row.callId, approved: row.approved === true }
  }
  return { kind: "message" }
}

/**
 * Passthrough so a local caller can exercise the group surface. Only the two
 * declared values are accepted — anything else is dropped rather than coerced,
 * leaving the core's own "dm" default to apply.
 */
function chatType(input: unknown): ChannelChatType | undefined {
  return input === "dm" || input === "group" ? input : undefined
}

function mentions(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const values = input.filter((item): item is string => typeof item === "string" && item.length > 0)
  return values.length ? values : undefined
}

function repo(input: unknown): InboundEnvelope["repo"] {
  if (!input || typeof input !== "object") return undefined
  const row = input as Record<string, unknown>
  if (typeof row.owner !== "string" || typeof row.name !== "string") return undefined
  if (row.owner.length === 0 || row.name.length === 0) return undefined
  return { owner: row.owner, name: row.name }
}

export async function fakeTransportHandler(core: ChannelCore, c: Context) {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const chunks: OutboundChunk[] = []
  const parsedRepo = repo(body.repo)
  const parsedChatType = chatType(body.chatType)
  const parsedMentions = mentions(body.mentions)
  await core.handleInbound({
    channel: channel(body.channel),
    externalUserId: str(body.externalUserId, "owner"),
    threadKey: str(body.threadKey, `${channel(body.channel)}:fake:default:default`),
    idempotencyKey: str(body.idempotencyKey, crypto.randomUUID()),
    text: str(body.text, ""),
    ...(typeof body.receivedAt === "number" ? { receivedAt: body.receivedAt } : {}),
    ...(parsedChatType ? { chatType: parsedChatType } : {}),
    ...(parsedMentions ? { mentions: parsedMentions } : {}),
    ...(parsedRepo ? { repo: parsedRepo } : {}),
    // Loopback-gated test/dev injection — bypasses the access gate + rate limit.
    trustedSource: true,
    intent: intent(body.intent),
    raw: body,
  }, {
    reply(chunk) {
      chunks.push(chunk)
    },
  })
  return c.json({ ok: true, chunks })
}
