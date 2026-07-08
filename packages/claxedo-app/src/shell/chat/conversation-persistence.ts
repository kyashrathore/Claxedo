import type { ChatClientPersistence } from "@tanstack/ai-client"
import type { UIMessage } from "@tanstack/ai"
import { createStore, del, get, set, type UseStore } from "idb-keyval"

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
try {
  if (typeof indexedDB !== "undefined") {
    store = createStore("claxedo-conversations", "messages")
  }
} catch {
  store = undefined
}

export const conversationPersistence: ChatClientPersistence = {
  getItem: (id) => (store ? get<UIMessage[]>(id, store) : undefined),
  setItem: (id, messages) => (store ? set(id, messages, store) : undefined),
  removeItem: (id) => (store ? del(id, store) : undefined),
}
