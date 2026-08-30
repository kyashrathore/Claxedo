import type { ChatClientPersistence } from "@tanstack/ai-client"
import type { UIMessage } from "@tanstack/ai"
import { createStore, del, get, keys, set } from "idb-keyval"
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
type ConversationStorage = {
  get: (key: IDBValidKey) => Promise<UIMessage[] | undefined>
  set: (key: IDBValidKey, value: UIMessage[]) => Promise<void>
  delete: (key: IDBValidKey) => Promise<void>
  keys: () => Promise<IDBValidKey[]>
}

let storage: ConversationStorage | undefined
let principalNamespace = "anonymous"
function createPersistenceState() {
  return {
    pendingOperations: new Map<IDBValidKey, Promise<void>>(),
    revokedScopes: new Map<string, object>(),
  }
}
const persistenceState = createPersistenceState()
try {
  if (typeof indexedDB !== "undefined") {
    const store = createStore("claxedo-conversations", "messages")
    storage = {
      get: (key) => get<UIMessage[]>(key, store),
      set: (key, value) => set(key, value, store),
      delete: (key) => del(key, store),
      keys: () => keys(store),
    }
  }
} catch {
  storage = undefined
}

function persistenceScopeKey(sessionID: string, namespace: string) {
  return `${namespace}\0${sessionID}`
}

function persistenceKeyIsRevoked(key: IDBValidKey) {
  for (const scope of persistenceState.revokedScopes.keys()) {
    const separator = scope.lastIndexOf("\0")
    const namespace = scope.slice(0, separator)
    const sessionID = scope.slice(separator + 1)
    if (conversationPersistenceKeyMatchesSession(key, sessionID, namespace)) return true
  }
  return false
}

function serializePersistenceOperation(key: IDBValidKey, operation: () => Promise<void>) {
  const previous = persistenceState.pendingOperations.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  persistenceState.pendingOperations.set(key, current)
  void current.finally(() => {
    if (persistenceState.pendingOperations.get(key) === current) persistenceState.pendingOperations.delete(key)
  }).catch(() => undefined)
  return current
}

export const conversationPersistence: ChatClientPersistence = {
  getItem: (id) => storage
    ? storage.get(id).then((messages) => compactConversationSnapshot(messages))
    : undefined,
  setItem: (id, messages) => {
    if (!storage || persistenceKeyIsRevoked(id)) return
    const snapshot = compactConversationSnapshot(messages) ?? []
    return serializePersistenceOperation(id, async () => {
      if (persistenceKeyIsRevoked(id)) return
      await storage?.set(id, snapshot)
    })
  },
  removeItem: (id) => storage
    ? serializePersistenceOperation(id, async () => storage?.delete(id))
    : undefined,
}

export function setConversationPersistencePrincipal(namespace: string | undefined) {
  const next = namespace ?? "anonymous"
  if (next === principalNamespace) return false
  principalNamespace = next
  return true
}

export function conversationPersistenceKey(id: string) {
  return `${principalNamespace}\0${id}`
}

export function conversationPersistenceKeyMatchesSession(
  key: IDBValidKey,
  sessionID: string,
  namespace = principalNamespace,
) {
  if (typeof key !== "string" || !key.endsWith(`\0${sessionID}`)) return false
  return key.startsWith(`${namespace}\0`)
}

export function conversationPersistencePrincipal() {
  return principalNamespace
}

/**
 * Remove every directory alias for a revoked session from the current durable
 * principal. Other principals may independently retain access to the same
 * session, so their namespaces must remain untouched.
 * Enumerating IndexedDB is intentional: a cold tab can receive the revoke
 * doorbell without having materialized the conversation in memory first.
 */
export function preparePersistedSessionRevocation(
  sessionID: string,
  namespace = principalNamespace,
) {
  const scope = persistenceScopeKey(sessionID, namespace)
  const token = {}
  persistenceState.revokedScopes.set(scope, token)
  const isActive = () => persistenceState.revokedScopes.get(scope) === token

  return {
    async purge() {
      if (!storage || !isActive()) return
      const pending = [...persistenceState.pendingOperations]
        .filter(([key]) => conversationPersistenceKeyMatchesSession(key, sessionID, namespace))
        .map(([, operation]) => operation.catch(() => undefined))
      await Promise.all(pending)
      if (!isActive()) return

      const persistedKeys = await storage.keys()
      await Promise.all(persistedKeys
        .filter((key) => conversationPersistenceKeyMatchesSession(key, sessionID, namespace))
        .map((key) => serializePersistenceOperation(key, async () => {
          if (!isActive()) return
          await storage?.delete(key)
        })))
    },
  }
}

/** Resume durable writes only after canonical authority proves access again. */
export function allowPersistedSessionConversations(
  sessionID: string,
  namespace = principalNamespace,
) {
  persistenceState.revokedScopes.delete(persistenceScopeKey(sessionID, namespace))
}

export function setConversationPersistenceStorageForTest(next: ConversationStorage | undefined) {
  storage = next
  persistenceState.pendingOperations.clear()
  persistenceState.revokedScopes.clear()
}
