/**
 * Session message text helpers.
 *
 * Extracted so the summarize_logs fallback-fetch logic can be unit tested
 * without importing server.ts (which connects a live stdio transport as a
 * side effect of module load).
 */
import { bool, record, records, text } from "./json"

export type SessionMessage = {
  info?: { id?: string; role?: string; error?: { message?: string; data?: { message?: string } } | null }
  parts?: Array<{ type?: string; text?: string; ignored?: boolean }>
}

const clean = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

// ---------------------------------------------------------------------------
// Reading a message off the wire
//
// `SessionMessage` is entirely optional fields, so the old
// `httpRequest<SessionMessage>` looked harmless — but it also accepted a string,
// an array, or an error envelope and handed it on as a message. These parsers
// produce the declared shape from anything, so the only thing a caller has to
// handle is "no text yet", which it already handles.
// ---------------------------------------------------------------------------

function parseMessageError(value: unknown): NonNullable<NonNullable<SessionMessage["info"]>["error"]> | undefined {
  const row = record(value)
  if (!row) return undefined
  const data = record(row.data)
  return {
    message: text(row.message),
    ...(data ? { data: { message: text(data.message) } } : {}),
  }
}

export function parseSessionMessage(value: unknown): SessionMessage {
  const row = record(value)
  if (!row) return {}
  const info = record(row.info)
  const parts = records(row.parts).map((part) => ({
    type: text(part.type),
    // Part text is passed through untrimmed: `messageText` trims, and a part
    // whose text is only whitespace must stay distinguishable from one with no
    // text field at all.
    text: typeof part.text === "string" ? part.text : undefined,
    ignored: bool(part.ignored),
  }))
  return {
    ...(info ? { info: { id: text(info.id), role: text(info.role), error: parseMessageError(info.error) } } : {}),
    ...(Array.isArray(row.parts) ? { parts } : {}),
  }
}

export function parseSessionMessages(value: unknown): SessionMessage[] {
  return Array.isArray(value) ? value.map((item) => parseSessionMessage(item)) : []
}

export const messageText = (message: SessionMessage) =>
  (message.parts || [])
    .filter((part) => part.type === "text" && !part.ignored)
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join("\n")

export const formatSessionMessages = (messages: SessionMessage[]) =>
  messages
    .map((message, idx) => {
      const role = clean(message.info?.role) || "unknown"
      const id = clean(message.info?.id)
      const text = messageText(message)
      const body = text.length > 1200 ? `${text.slice(0, 1200)}...` : text
      return `${idx + 1}. ${role}${id ? ` [${id}]` : ""}\n${body || "(no text content)"}`
    })
    .join("\n\n")

/**
 * The runtime only exposes `GET /session/:id/message` (a list route) — there
 * is no singular `GET /session/:id/message/:messageId` route. When the
 * initial POST response has no text yet, fall back to re-fetching the list
 * and locating the message by id, instead of hitting the dead per-id route.
 */
export async function resolveResponseText(
  result: SessionMessage,
  fetchMessages: () => Promise<SessionMessage[]>,
): Promise<string> {
  const initial = messageText(result).trim()
  if (initial) return initial
  if (!result.info?.id) return ""
  const messages = await fetchMessages()
  const match = messages.find((m) => m.info?.id === result.info?.id)
  return match ? messageText(match).trim() : ""
}
