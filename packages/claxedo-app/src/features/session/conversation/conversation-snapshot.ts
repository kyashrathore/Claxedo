import type { UIMessage } from "@tanstack/ai"
import type { Message } from "./opencode-conversation"

export function compactConversationSnapshot(messages: UIMessage[] | undefined) {
  if (!messages) return messages
  const byId = new Map<string, UIMessage>()
  for (const message of messages) byId.set(message.id, message)
  return byId.size === messages.length ? messages : [...byId.values()]
}

function errorDetailRank(error: unknown) {
  if (!error || typeof error !== "object") return 0
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object") return 1
  const fields = data as { statusCode?: unknown; responseBody?: unknown; message?: unknown }
  let rank = 1
  if (typeof fields.message === "string" && fields.message.trim()) rank += 1
  if (typeof fields.statusCode === "number") rank += 2
  if (typeof fields.responseBody === "string" && fields.responseBody.trim()) rank += 2
  return rank
}

function richestError(current: Message | undefined, next: Message | undefined) {
  const incoming = next?.role === "assistant" ? next.error : undefined
  if (!incoming) return undefined
  const existing = current?.role === "assistant" ? current.error : undefined
  if (!existing) return incoming
  return errorDetailRank(existing) > errorDetailRank(incoming) ? existing : incoming
}

function withPreservedError(current: Message | undefined, next: Message): Message {
  if (next.role !== "assistant") return next
  const error = richestError(current, next)
  if (error === next.error) return next
  if (!error) {
    const { error: _dropped, ...rest } = next as Message & { error?: unknown }
    return rest as Message
  }
  return { ...next, error } as Message
}

function propertyRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function messageAuthorRecord(message: Message | undefined) {
  if (!message || message.role !== "user") return
  return propertyRecord(propertyRecord((message as { claxedo?: unknown }).claxedo)?.author)
}

export function withPreservedAuthor(current: Message | undefined, next: Message): Message {
  if (next.role !== "user") return next
  const currentAuthor = messageAuthorRecord(current)
  if (!currentAuthor || messageAuthorRecord(next)) return next
  const nextClaxedo = propertyRecord((next as { claxedo?: unknown }).claxedo) ?? {}
  return { ...next, claxedo: { ...nextClaxedo, author: currentAuthor } } as Message
}

export function preserveMessageFields(current: Message | undefined, next: Message): Message {
  return withPreservedAuthor(current, withPreservedError(current, next))
}
