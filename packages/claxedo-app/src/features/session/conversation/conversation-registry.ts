import type { Event } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, type Accessor } from "solid-js"
import {
  applyOpencodeConversationEvent,
  mergeConversationSnapshot,
  opencodeConversationSnapshot,
  opencodeConversationProjection,
  type ConversationChatHandle,
} from "./opencode-conversation"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { UIMessage } from "@tanstack/ai"
import {
  conversationScopeKey,
  createConversationChatClient,
  readConversationSnapshot,
  type ConversationChatEntry,
  type ConversationDirectory,
  type ConversationScope,
} from "./conversation-chat-client"
import { queryClient } from "@/platform/query/query-client"
import { estimateConversationMemory } from "./conversation-memory"

/**
 * One canonical conversation store per session. The registry owns a TanStack
 * `ChatClient` per `sessionId` (see {@link createConversationChatClient}); the
 * query cache is its durable backing. There is no second handle set, no
 * cache/live dual-apply, and no union-read — every reader projects from the one
 * owned client.
 *
 * Reactivity is per-session: `entry.version` bumps on that session's message
 * changes, while a single `topology` signal bumps only when an entry is created
 * or cleared. Readers subscribe to both, so a stream in session A re-runs only
 * session A's consumers (entry creation is the rare, app-wide event).
 */
const entries = new Map<string, ConversationChatEntry>()
// ChatClient normalizes manually supplied UIMessage metadata once its lazy
// runtime has loaded, so the top-level `optimistic` marker is not durable
// enough to own rollback. Keep dispatch ownership process-local and scoped by
// directory/session/message; server events and snapshots explicitly confirm
// and release that ownership.
const optimisticMessageKeys = new Set<string>()
const [topology, bumpTopology] = createSignal(0, { equals: false })
const markTopologyChanged = () => bumpTopology((value) => value + 1)
type ConversationProjection = ReturnType<typeof opencodeConversationProjection>
const projectedSnapshots = new WeakMap<UIMessage[], ConversationProjection>()

// Bound the number of live in-memory ChatClients. The client deliberately
// outlives unmount (instant reopen, no refetch flash), so without a cap the
// store would grow for the tab's lifetime. We keep the N most-recently-used and
// evict cold (unmounted) ones beyond that. Eviction loses no data: the message
// snapshot persists in the query cache, so reopening rehydrates a fresh client.
const conversationEntryLimit = 32

function ensureEntry(scope: ConversationScope) {
  const key = conversationScopeKey(scope)
  const existing = entries.get(key)
  if (existing) {
    // Mark most-recently-used (Map preserves insertion order = LRU order).
    entries.delete(key)
    entries.set(key, existing)
    return existing
  }
  const entry = createConversationChatClient(scope)
  entries.set(key, entry)
  evictColdEntries()
  markTopologyChanged()
  return entry
}

function evictColdEntries() {
  if (entries.size <= conversationEntryLimit) return
  for (const [id, entry] of entries) {
    if (entries.size <= conversationEntryLimit) break
    if (entry.refs > 0) continue // never evict a mounted session
    entries.delete(id)
    entry.unsubscribe?.()
  }
}

/**
 * Drop one cold session's live ChatClients.
 *
 * The count cap above only runs when a NEW entry pushes the map past the limit,
 * so a session's client could outlive the byte-budget eviction that already
 * decided its transcript should go — the cache ceiling freed the query data
 * while the far larger live client (full `UIMessage[]`, parts, embedded images)
 * stayed resident. This lets the byte-budget policy release that memory too.
 *
 * Entries are keyed by directory + session, so one session id can hold an entry
 * per directory it was opened from; all of its cold entries are released here.
 * Uses the same `refs > 0` guard as `evictColdEntries`, so a mounted session is
 * never evicted; the caller's session is additionally never an eviction
 * candidate. Eviction loses no data — reopening rehydrates from the query cache.
 */
export function evictConversationEntry(sessionID: string) {
  let evicted = false
  for (const [key, entry] of entries) {
    if (entry.sessionID !== sessionID || entry.refs > 0) continue
    entries.delete(key)
    entry.unsubscribe?.()
    evicted = true
  }
  if (evicted) markTopologyChanged()
  return evicted
}

export function registerSessionConversationChat(scope: ConversationScope, chat?: ConversationChatHandle) {
  const entry = ensureEntry(scope)
  if (chat) {
    const current = entry.handle.messages()
    const next = mergeConversationSnapshot(current, chat.messages(), { order: "snapshot" })
    if (!sameConversationMessages(current, next)) entry.handle.setMessages(next)
  }
  entry.refs += 1
  return () => {
    entry.refs -= 1
    // The client deliberately outlives unmount so reopening a session is instant
    // (no refetch flash). The durable copy also lives in the query cache.
    // Teardown of the live SSE side-channel happens here once it is wired (W1-P3).
  }
}

export function applyRegisteredConversationEvent(input: { directory: ConversationDirectory; event: Event }) {
  const event = input.event
  const sessionID = sessionIdFromEvent(event)
  if (!sessionID) return false
  const scope = { directory: input.directory, sessionID }
  // Ignore events for sessions we have never materialized (no entry and no
  // cached snapshot) so the global SSE firehose does not spawn clients for
  // background sessions the user never opened.
  if (!entries.get(conversationScopeKey(scope)) && !readConversationSnapshot(scope)) return false
  const applied = applyOpencodeConversationEvent(ensureEntry(scope).handle, event)
  if (applied && (event.type === "message.updated" || event.type === "message.removed")) {
    const messageID = messageIdFromEvent(event)
    if (messageID) optimisticMessageKeys.delete(optimisticMessageKey({ ...scope, messageID }))
  }
  return applied
}

export function hydrateRegisteredConversationSnapshot(input: {
  directory: ConversationDirectory
  sessionID: string
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  resolvedMembership?: boolean
  canonicalMessageIDs?: ReadonlySet<string>
  canonicalPartMessageIDs?: ReadonlySet<string>
}) {
  // The hydrator passes its merged working set here, so `input.messages` can
  // include client-only optimistic rows. Only ids explicitly identified as
  // canonical producer rows confirm dispatch ownership.
  for (const messageID of input.canonicalMessageIDs ?? []) {
    optimisticMessageKeys.delete(optimisticMessageKey({ ...input, messageID }))
  }
  const entry = ensureEntry(input)
  const snapshot = opencodeConversationSnapshot({
    messages: input.messages,
    parts: input.parts,
  })
  const current = entry.handle.messages()
  const next = mergeConversationSnapshot(current, snapshot, {
    order: "snapshot",
    ...(input.resolvedMembership ? { membership: "resolved" as const } : {}),
    canonicalMessageIDs: input.canonicalMessageIDs,
    canonicalPartMessageIDs: input.canonicalPartMessageIDs,
  })
  if (sameConversationMessages(current, next)) return false
  entry.handle.setMessages(next)
  return true
}

export function addRegisteredConversationMessage(input: {
  directory: ConversationDirectory
  sessionID: string
  message: Message
  parts: Part[]
}) {
  optimisticMessageKeys.add(optimisticMessageKey({ ...input, messageID: input.message.id }))
  const entry = ensureEntry(input)
  const snapshot = opencodeConversationSnapshot({
    messages: [input.message],
    parts: { [input.message.id]: input.parts },
  }).map(markOptimistic)
  entry.handle.setMessages(mergeConversationSnapshot(entry.handle.messages(), snapshot))
  return true
}

export function removeRegisteredConversationMessage(input: {
  directory: ConversationDirectory
  sessionID: string
  messageID: string
}) {
  const entry = entries.get(conversationScopeKey(input))
  if (!entry) return false
  const current = entry.handle.messages()
  const target = current.find((message) => message.id === input.messageID)
  // Only roll back a message that is still optimistic. Once the server echoes
  // the same id, the registry releases its process-local dispatch ownership,
  // so a late dispatch failure can no longer delete a server-confirmed message
  // (and orphan its assistant turn). The UI metadata marker is intentionally
  // not authoritative because ChatClient normalizes it after lazy activation.
  const owned = optimisticMessageKeys.delete(optimisticMessageKey(input))
  if (!owned || !target) return false
  const next = current.filter((message) => message.id !== input.messageID)
  if (next.length === current.length) return false
  entry.handle.setMessages(next)
  return true
}

type OptimisticUIMessage = UIMessage & { metadata?: { optimistic?: boolean; [key: string]: unknown } }

function markOptimistic(message: UIMessage): UIMessage {
  const current = (message as OptimisticUIMessage).metadata
  return { ...message, metadata: { ...current, optimistic: true } } as UIMessage
}

export function registeredConversationHasUserMessage(directory: ConversationDirectory, sessionID: string | undefined) {
  return registeredConversationUserMessages(directory, sessionID).length > 0
}

export function registeredConversationUserMessages(directory: ConversationDirectory, sessionID: string | undefined) {
  const messages = new Map<string, { id: string; role: "user" }>()
  for (const message of conversationMessages(directory, sessionID)) {
    if (message.role !== "user") continue
    messages.set(message.id, { id: message.id, role: "user" })
  }
  return [...messages.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function registeredConversationSnapshot(directory: ConversationDirectory, sessionID: string | undefined) {
  const messages = conversationMessages(directory, sessionID)
  const cached = projectedSnapshots.get(messages)
  if (cached) return cached
  const projected = opencodeConversationProjection(messages)
  projectedSnapshots.set(messages, projected)
  return projected
}

/**
 * Pane-local projection of the canonical registry snapshot. While a retained
 * pane is hidden it keeps the last snapshot by reference and, critically,
 * unsubscribes from the registry entry's version signal. Live events still
 * update the registry and its query-cache backing; they simply cannot wake the
 * hidden timeline/Markdown graph. The next active edge reads the authoritative
 * snapshot once and publishes that one catch-up value to the pane.
 */
export function createActiveConversationSnapshot(input: {
  directory: Accessor<ConversationDirectory>
  sessionID: Accessor<string | undefined>
  active: Accessor<boolean>
}) {
  return createMemo<ConversationProjection | undefined>((previous) => {
    if (!input.active()) return previous
    const sessionID = input.sessionID()
    if (!sessionID) return undefined
    return registeredConversationSnapshot(input.directory(), sessionID)
  })
}

export function conversationEntryIdsForTest() {
  return [...entries.keys()]
}

export function warmConversationMemorySnapshot() {
  return [...entries.values()].toReversed().map((entry, recency) => {
    const messages = entry.handle.messages()
    return {
      sessionId: entry.sessionID,
      directory: entry.directory,
      mounted: entry.refs > 0,
      recency,
      messageCount: messages.length,
      buckets: estimateConversationMemory(messages),
    }
  })
}

export function clearConversationChatRegistryForTest() {
  entries.clear()
  optimisticMessageKeys.clear()
  queryClient.removeQueries({ queryKey: ["shell", "session"] })
  markTopologyChanged()
}

function sameConversationMessages(left: UIMessage[], right: UIMessage[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((message, index) => {
    // Merge preserves references for unchanged messages; stringify is the
    // fallback for genuinely rebuilt ones only.
    if (message === right[index]) return true
    try {
      return JSON.stringify(message) === JSON.stringify(right[index])
    } catch {
      return false
    }
  })
}

/**
 * The UIMessage list backing a read. Subscribes to `topology` (entry creation /
 * clear) and, when the session has an entry, to that entry's `version` so the
 * reader re-runs on this session's message changes only.
 */
function conversationMessages(directory: ConversationDirectory, sessionID: string | undefined): UIMessage[] {
  topology()
  if (!sessionID) return []
  const scope = { directory, sessionID }
  const entry = entries.get(conversationScopeKey(scope))
  if (!entry) return readConversationSnapshot(scope) ?? []
  entry.version()
  return entry.handle.messages()
}

function sessionIdFromEvent(event: Event) {
  const props = record(event.properties)
  return (
    text(props?.sessionID) ??
    text(props?.sessionId) ??
    text(record(props?.info)?.sessionID) ??
    text(record(props?.part)?.sessionID)
  )
}

function messageIdFromEvent(event: Event) {
  const props = record(event.properties)
  return text(props?.messageID) ?? text(record(props?.info)?.id)
}

function optimisticMessageKey(input: { directory: ConversationDirectory; sessionID: string; messageID: string }) {
  return `${conversationScopeKey(input)}\0${input.messageID}`
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
