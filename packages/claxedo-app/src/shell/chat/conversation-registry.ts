import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSignal } from "solid-js"
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
  createConversationChatClient,
  readConversationSnapshot,
  type ConversationChatEntry,
} from "./conversation-chat-client"
import { queryClient } from "../../shared/query/query-client"

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
const [topology, bumpTopology] = createSignal(0, { equals: false })
const markTopologyChanged = () => bumpTopology((value) => value + 1)

// Bound the number of live in-memory ChatClients. The client deliberately
// outlives unmount (instant reopen, no refetch flash), so without a cap the
// store would grow for the tab's lifetime. We keep the N most-recently-used and
// evict cold (unmounted) ones beyond that. Eviction loses no data: the message
// snapshot persists in the query cache, so reopening rehydrates a fresh client.
const conversationEntryLimit = 32

function ensureEntry(sessionID: string) {
  const existing = entries.get(sessionID)
  if (existing) {
    // Mark most-recently-used (Map preserves insertion order = LRU order).
    entries.delete(sessionID)
    entries.set(sessionID, existing)
    return existing
  }
  const entry = createConversationChatClient(sessionID)
  entries.set(sessionID, entry)
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

export function registerSessionConversationChat(sessionID: string, chat?: ConversationChatHandle) {
  const entry = ensureEntry(sessionID)
  if (chat) {
    const current = entry.handle.messages()
    const next = mergeConversationSnapshot(current, chat.messages())
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

export function applyRegisteredConversationEvent(event: Event) {
  const sessionID = sessionIdFromEvent(event)
  if (!sessionID) return false
  // Ignore events for sessions we have never materialized (no entry and no
  // cached snapshot) so the global SSE firehose does not spawn clients for
  // background sessions the user never opened.
  if (!entries.get(sessionID) && !readConversationSnapshot(sessionID)) return false
  return applyOpencodeConversationEvent(ensureEntry(sessionID).handle, event)
}

export function hydrateRegisteredConversationSnapshot(input: {
  sessionID: string
  messages: Message[]
  parts: Record<string, Part[] | undefined>
}) {
  const entry = ensureEntry(input.sessionID)
  const snapshot = opencodeConversationSnapshot({
    messages: input.messages,
    parts: input.parts,
  })
  const current = entry.handle.messages()
  const next = mergeConversationSnapshot(current, snapshot)
  if (sameConversationMessages(current, next)) return false
  entry.handle.setMessages(next)
  return true
}

export function addRegisteredConversationMessage(input: {
  directory?: string
  sessionID: string
  message: Message
  parts: Part[]
}) {
  const entry = ensureEntry(input.sessionID)
  const snapshot = opencodeConversationSnapshot({
    messages: [input.message],
    parts: { [input.message.id]: input.parts },
  }).map(markOptimistic)
  entry.handle.setMessages(mergeConversationSnapshot(entry.handle.messages(), snapshot))
  return true
}

export function removeRegisteredConversationMessage(input: {
  directory?: string
  sessionID: string
  messageID: string
}) {
  const entry = entries.get(input.sessionID)
  if (!entry) return false
  const current = entry.handle.messages()
  const target = current.find((message) => message.id === input.messageID)
  // Only roll back a message that is still optimistic. Once the server echoes
  // the same id (via applyOpencodeConversationEvent / hydrate), the message is
  // re-projected without the optimistic flag, so a late dispatch failure can no
  // longer delete a server-confirmed message (and orphan its assistant turn).
  if (!target || !isOptimistic(target)) return false
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

function isOptimistic(message: UIMessage) {
  return (message as OptimisticUIMessage).metadata?.optimistic === true
}

export function registeredConversationHasUserMessage(sessionID: string | undefined) {
  return registeredConversationUserMessages(sessionID).length > 0
}

export function registeredConversationUserMessages(sessionID: string | undefined) {
  const messages = new Map<string, { id: string; role: "user" }>()
  for (const message of conversationMessages(sessionID)) {
    if (message.role !== "user") continue
    messages.set(message.id, { id: message.id, role: "user" })
  }
  return [...messages.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function registeredConversationSnapshot(sessionID: string | undefined) {
  return opencodeConversationProjection(conversationMessages(sessionID))
}

export function conversationEntryIdsForTest() {
  return [...entries.keys()]
}

export function clearConversationChatRegistryForTest() {
  entries.clear()
  queryClient.removeQueries({ queryKey: ["shell", "session"] })
  markTopologyChanged()
}

function sameConversationMessages(left: UIMessage[], right: UIMessage[]) {
  if (left.length !== right.length) return false
  return left.every((message, index) => {
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
function conversationMessages(sessionID: string | undefined): UIMessage[] {
  topology()
  if (!sessionID) return []
  const entry = entries.get(sessionID)
  if (!entry) return readConversationSnapshot(sessionID) ?? []
  entry.version()
  return entry.client.getMessages()
}

function sessionIdFromEvent(event: Event) {
  const props = record(event.properties)
  return text(props?.sessionID) ??
    text(props?.sessionId) ??
    text(record(props?.info)?.sessionID) ??
    text(record(props?.part)?.sessionID)
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
