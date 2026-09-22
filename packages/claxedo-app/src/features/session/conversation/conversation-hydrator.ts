import { readField } from "@/lib/record"
import type {
  AgentContentPart as Part,
  AgentPresentationMessage as Message,
} from "@claxedo/agent-runtime-contract"
import { normalizeMessageRows, reconcileStoredParts } from "../store/message-page"
import { hydrateRegisteredConversationSnapshot, registeredConversationSnapshot } from "./conversation-registry"
import { isRuntimeAgentMessage } from "./agent-conversation-codec"
import type { ConversationDirectory } from "./conversation-chat-client"

type PartRows = Array<{ id: string; parts: Part[] }>
export type ConversationPageCompleteness = "canonical" | "fragment"

function mergeByID<T extends { id: string }>(existing: T[], next: T[]) {
  if (existing.length === 0) return next
  const nextIds = new Set(next.map((item) => item.id))
  return [...next, ...existing.filter((item) => !nextIds.has(item.id))]
}

function replaceWindowByID<T extends { id: string }>(existing: T[], next: T[]) {
  if (existing.length === 0 || next.length === 0) return next.length > 0 ? next : existing
  const nextIds = new Set(next.map((item) => item.id))
  const indexes = existing.flatMap((item, index) => nextIds.has(item.id) ? [index] : [])
  if (indexes.length === 0) return [...existing, ...next]
  const first = Math.min(...indexes)
  const last = Math.max(...indexes)
  return [...existing.slice(0, first), ...next, ...existing.slice(last + 1)]
}

/**
 * Overlay a projected message fragment onto the canonical order we already
 * hold. A latest-surface response intentionally omits older and intermediate
 * messages, so absence from that response is not deletion. Matching messages
 * overlay the fields the projection actually carries while every omitted
 * field/message keeps its canonical value and exact position. Genuinely new
 * fragment rows are appended in producer order.
 */
function overlayByID<T extends { id: string }>(existing: T[], next: T[]) {
  if (existing.length === 0) return next
  if (next.length === 0) return existing
  const existingIds = new Set(existing.map((item) => item.id))
  const nextByID = new Map(next.map((item) => [item.id, item] as const))
  let changed = false
  const overlaid = existing.map((item) => {
    const replacement = nextByID.get(item.id)
    if (!replacement) return item
    const unchanged = replacement === item || Object.entries(replacement)
      .every(([key, value]) => Object.is(readField(item, key), value))
    if (unchanged) return item
    changed = true
    return { ...item, ...replacement }
  })
  const appended = next.filter((item) => !existingIds.has(item.id))
  if (appended.length > 0) changed = true
  return changed ? [...overlaid, ...appended] : existing
}

export function resolveStoredMessages<T extends { id: string }>(input: {
  existing: T[] | undefined
  next: T[]
  completeness: ConversationPageCompleteness
  mode?: "replace" | "prepend" | "replace-window"
}) {
  if (input.completeness === "fragment") return overlayByID(input.existing ?? [], input.next)
  if (input.mode === "prepend") return mergeByID(input.existing ?? [], input.next)
  if (input.mode === "replace-window") return replaceWindowByID(input.existing ?? [], input.next)
  if (input.next.length > 0) return reuseUnchanged(input.existing, input.next)
  return input.next
}

/**
 * Identity-preserving replace, mirroring `reconcileStoredParts`' contract: the
 * canonical payload wins on membership, order, and content, but every row that
 * is CONTENT-EQUAL to one we already hold keeps its existing object — and a
 * fully unchanged list hands back the SAME array. Without this, every
 * turn-settle/hydrate refetch minted a fresh message-info object per row, so
 * reactive consumers re-rendered the whole timeline for a no-op payload —
 * observed as the turn fold snapping shut (and clicks landing on the wrong
 * element) whenever a background refetch raced an open turn.
 */
function reuseUnchanged<T extends { id: string }>(existing: T[] | undefined, next: T[]) {
  if (!existing || existing.length === 0) return next
  const before = new Map(existing.map((item) => [item.id, item] as const))
  const resolved = next.map((item) => {
    const prior = before.get(item.id)
    return prior && (prior === item || JSON.stringify(prior) === JSON.stringify(item)) ? prior : item
  })
  const unchanged = existing.length === resolved.length && resolved.every((item, index) => existing[index] === item)
  return unchanged ? existing : resolved
}

/**
 * A non-canonical page (an unsettled message, a `latest-surface` fragment)
 * cannot prune, so membership is the union: client-only ids stay in place,
 * server-only ids are appended. For an id both sides carry the SERVER row is
 * handed on. Freshness is not decided here — `mergeChatPart` compares the row
 * against what the client streamed (tool-call rank, text length) and keeps
 * the client's when it is ahead. Keeping the client's row at this layer
 * instead meant a `completed` the stream lost could never land: the stale
 * `running` was the only version the merge ever saw.
 */
export function resolveStoredParts<T extends { id: string }>(existing: T[] | undefined, next: T[]) {
  if (!existing) return [...next]
  const incoming = new Map(next.map((item) => [item.id, item] as const))
  const resolved = existing.map((item) => incoming.get(item.id) ?? item)
  const held = new Set(existing.map((item) => item.id))
  for (const item of next) {
    if (!held.has(item.id)) resolved.push(item)
  }
  return resolved
}

/**
 * Whether a hydrate call carries the server's CANONICAL view of a message's
 * parts — the only case where an absent id means "deleted" rather than "not
 * in this fragment".
 *
 * Three conditions, all required:
 *   - `rows` (the body of `GET /session/:id/message`) — the `messages`/`parts`
 *     seed path is a prefetch, not an enumeration;
 *   - not an explicitly projected `fragment` such as `latest-surface`;
 *   - the message is SETTLED (`time.completed`). Mid-turn, a REST refetch
 *     describes only what the server has persisted so far, and a part SSE
 *     delivered moments ago is legitimately missing from it. Pruning then
 *     erases text the user is watching stream in.
 *
 * That last condition is the same boundary `agent-conversation.ts`'s
 * `settledAssistantMessage` draws for `mergeChatMessage`. This is deliberately
 * the same rule applied one layer earlier: `mergeChatMessage` can only judge
 * the part list it is handed, and by then `resolveStoredParts` has already
 * folded the stale id into it, so its prune has nothing left to drop.
 *
 * The settled condition is defense in depth rather than the last line of
 * defense — `mergeChatParts` re-adds a live part this layer dropped, so
 * relaxing it does not visibly lose text TODAY. It is kept, and tested
 * directly here, because "don't prune against a payload that cannot see the
 * whole message yet" is correct independent of whether a downstream layer
 * happens to compensate.
 */
export function canonicalPartMessageIds(input: { rows?: unknown; partCompleteness: ConversationPageCompleteness }, messages: Message[]) {
  if (input.rows === undefined || input.partCompleteness === "fragment") return undefined
  const settled = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (typeof (message.time as { completed?: number } | undefined)?.completed === "number") {
      settled.add(message.id)
    }
  }
  return settled
}

/**
 * Whether a newest-page read overlaps the history this client already holds.
 * Only then can the page replace its own span and keep the older pages the
 * reader scrolled in; a page with nothing in common leaves a gap the paging
 * cursor cannot reach, so it has to replace the whole conversation.
 */
export function pageContinuesConversation(input: { directory: ConversationDirectory; sessionID: string; rows: unknown }) {
  const held = new Set(registeredConversationSnapshot(input.directory, input.sessionID).messages.map((message) => message.id))
  return normalizeMessageRows(input.rows).messages.some((message) => held.has(message.id))
}

export function hydrateConversationPage(input: {
  directory: ConversationDirectory
  sessionID: string
  rows?: unknown
  messages?: Message[]
  parts?: PartRows
  mode?: "replace" | "prepend" | "replace-window"
  messageCompleteness: ConversationPageCompleteness
  partCompleteness: ConversationPageCompleteness
}) {
  const conversation = registeredConversationSnapshot(input.directory, input.sessionID)
  const normalized = input.rows === undefined
    ? { messages: input.messages ?? [], parts: input.parts ?? [] }
    : normalizeMessageRows(input.rows)
  const canonicalIds = canonicalPartMessageIds(input, normalized.messages)
  const canonicalMessageIDs = input.messageCompleteness === "canonical"
    ? new Set(normalized.messages.map((message) => message.id))
    : undefined
  const parts = { ...conversation.parts }
  normalized.parts.forEach((row) => {
    if (row.parts.length === 0 && !canonicalIds?.has(row.id)) return
    parts[row.id] = canonicalIds?.has(row.id)
      ? reconcileStoredParts(parts[row.id], row.parts)
      : resolveStoredParts(parts[row.id], row.parts)
  })
  const messages = resolveStoredMessages({
    // Hydration reconciles server-backed rows. An optimistic stub has no
    // canonical counterpart to reconcile against, and `mergeConversationSnapshot`
    // retains it in the store on its own (`retainOutsideCanonicalSnapshot`), so
    // it never needs to travel back out through the snapshot builder.
    existing: conversation.messages.filter(isRuntimeAgentMessage),
    next: normalized.messages,
    completeness: input.messageCompleteness,
    mode: input.mode,
  })
  hydrateRegisteredConversationSnapshot({
    directory: input.directory,
    sessionID: input.sessionID,
    messages,
    parts,
    resolvedMembership: true,
    canonicalMessageIDs,
    canonicalPartMessageIDs: canonicalIds,
    fragmentParts: input.partCompleteness === "fragment",
  })
  return registeredConversationSnapshot(input.directory, input.sessionID).messages.length
}
