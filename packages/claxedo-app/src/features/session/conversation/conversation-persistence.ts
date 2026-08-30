import type { ChatClientPersistence } from "@tanstack/ai-client"
import type { UIMessage } from "@tanstack/ai"
import { createStore, del, get, keys, set, type UseStore } from "idb-keyval"
import { compactConversationSnapshot } from "./conversation-snapshot"

/**
 * Durable per-session conversation persistence backed by IndexedDB.
 *
 * Why IndexedDB rather than the shared localStorage query-persister blob: IDB
 * stores each session under its own key with a much larger quota, so one large
 * conversation can't exhaust the ~5MB budget and silently break persistence for
 * unrelated cached data (projects/directory/commands). Wired into ChatClient via
 * its `persistence` adapter (ai-client 0.16+), so the client owns async
 * hydration, write ordering, and clear-during-stream suppression — the
 * correctness guarantees that only matter once storage is asynchronous.
 *
 * No-ops gracefully where IndexedDB is unavailable (tests/SSR). ChatClient also
 * swallows adapter errors, so storage problems never break chat.
 */
let store: UseStore | undefined
let principalNamespace = ""
try {
  if (typeof indexedDB !== "undefined") {
    store = createStore("claxedo-conversations", "messages")
  }
} catch {
  store = undefined
}

export const conversationPersistence: ChatClientPersistence = {
  getItem: (id) => store
    ? get<UIMessage[]>(id, store).then((messages) => compactConversationSnapshot(messages))
    : undefined,
  setItem: (id, messages) => (store ? set(id, compactConversationSnapshot(messages) ?? [], store) : undefined),
  removeItem: (id) => (store ? del(id, store) : undefined),
}

/** Local unsigned mode intentionally retains the historical unprefixed key. */
export function setConversationPersistencePrincipal(namespace: string | undefined) {
  const next = namespace ?? ""
  if (next === principalNamespace) return false
  principalNamespace = next
  return true
}

export function conversationPersistenceKey(id: string) {
  return principalNamespace ? `${principalNamespace}\0${id}` : id
}

export function conversationPersistenceKeyMatchesSession(key: IDBValidKey, sessionID: string) {
  return typeof key === "string" && key.endsWith(`\0${sessionID}`)
}

/**
 * Remove every directory alias for a revoked session from the durable owner.
 * Enumerating IndexedDB is intentional: a cold tab can receive the revoke
 * doorbell without having materialized the conversation in memory first.
 */
export async function removePersistedSessionConversations(sessionID: string) {
  if (!store) return
  const persistedKeys = await keys(store)
  await Promise.all(
    persistedKeys
      .filter((key) => conversationPersistenceKeyMatchesSession(key, sessionID))
      .map((key) => del(key, store)),
  )
}
