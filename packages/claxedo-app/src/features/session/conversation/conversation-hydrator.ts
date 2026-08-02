import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeStoredItems, normalizeMessageRows, reconcileStoredParts } from "../store/message-page"
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

/**
 * Whether a hydrate call carries the server's CANONICAL view of a message's
 * parts — the only case where an absent id means "deleted" rather than "not
 * in this fragment".
 *
 * Three conditions, all required:
 *   - `rows` (the body of `GET /session/:id/message`) — the `messages`/`parts`
 *     seed path is a prefetch, not an enumeration;
 *   - not `prepend` — that page is older history, a fragment by construction;
 *   - the message is SETTLED (`time.completed`). Mid-turn, a REST refetch
 *     describes only what the server has persisted so far, and a part SSE
 *     delivered moments ago is legitimately missing from it. Pruning then
 *     erases text the user is watching stream in.
 *
 * That last condition is the same boundary `opencode-conversation.ts`'s
 * `settledAssistantMessage` draws for `mergeChatMessage`. This is deliberately
 * the same rule applied one layer earlier: `mergeChatMessage` can only judge
 * the part list it is handed, and by then the union below has already folded
 * the stale id into it, so its prune has nothing left to drop.
 *
 * The settled condition is defense in depth rather than the last line of
 * defense — `mergeChatParts` would currently re-add a live part this layer
 * dropped, so relaxing it does not visibly lose text TODAY. It is kept, and
 * tested directly here, because "don't prune against a payload that cannot
 * see the whole message yet" is correct independent of whether a downstream
 * layer happens to compensate.
 */
export function canonicalPartMessageIds(input: { rows?: unknown; mode?: "replace" | "prepend" }, messages: Message[]) {
  if (input.rows === undefined || input.mode === "prepend") return undefined
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (typeof (message.time as { completed?: number } | undefined)?.completed === "number") {
      settled.add(message.id)
    }
  }
  return settled
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
  const canonicalIds = canonicalPartMessageIds(input, normalized.messages)
  const parts = { ...conversation.parts }
  normalized.parts.forEach((row) => {
    if (row.parts.length === 0) return
    parts[row.id] = canonicalIds?.has(row.id)
      ? reconcileStoredParts(parts[row.id] as Part[] | undefined, row.parts)
      : resolveStoredParts(parts[row.id], row.parts)
  })
  const messages = resolveStoredMessages({
    existing: conversation.messages as Message[],
    next: normalized.messages,
    mode: input.mode,
  })
  hydrateRegisteredConversationSnapshot({ sessionID: input.sessionID, messages, parts })
  return messages.length
}
