import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeStoredItems, normalizeMessageRows } from "../store/message-page"
import { hydrateRegisteredConversationSnapshot, registeredConversationSnapshot } from "./conversation-registry"

type PartRows = Array<{ id: string; parts: Part[] }>

function mergeByID<T extends { id: string }>(existing: T[], next: T[]) {
  if (existing.length === 0) return next
  const map = new Map(existing.map((item) => [item.id, item] as const))
  next.forEach((item) => map.set(item.id, item))
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function resolveStoredMessages<T extends { id: string }>(input: {
  existing: T[] | undefined
  next: T[]
  mode?: "replace" | "prepend"
}) {
  if (input.mode === "prepend") return mergeByID(input.existing ?? [], input.next)
  if (input.next.length > 0) return input.next
  if ((input.existing?.length ?? 0) === 0) return input.next
  return input.existing!
}

export function resolveStoredParts<T extends { id: string }>(existing: T[] | undefined, next: T[]) {
  return mergeStoredItems(existing, next)
}

export function hydrateConversationPage(input: {
  sessionID: string
  rows?: unknown
  messages?: Message[]
  parts?: PartRows
  mode?: "replace" | "prepend"
}) {
  const conversation = registeredConversationSnapshot(input.sessionID)
  const normalized = input.rows === undefined
    ? { messages: input.messages ?? [], parts: input.parts ?? [] }
    : normalizeMessageRows(input.rows)
  const parts = { ...conversation.parts }
  normalized.parts.forEach((row) => {
    if (row.parts.length === 0) return
    parts[row.id] = resolveStoredParts(parts[row.id], row.parts)
  })
  const messages = resolveStoredMessages({
    existing: conversation.messages as Message[],
    next: normalized.messages,
    mode: input.mode,
  })
  hydrateRegisteredConversationSnapshot({ sessionID: input.sessionID, messages, parts })
  return messages.length
}
