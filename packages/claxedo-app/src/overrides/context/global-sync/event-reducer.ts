// Re-export upstream applyGlobalEvent unchanged.
// Claxedo only overrides cleanup/session eviction behavior.
export { applyGlobalEvent } from "../../../../../app/src/context/global-sync/event-reducer"

// RECONCILIATION NOTE: This file overrides the upstream event-reducer. When upstream
// adds new event types, they are handled by the `default` case (falls through to
// upstreamApplyDirectoryEvent). Only process.* and session-created/updated need
// explicit handling here.

import { Binary } from "@opencode-ai/util/binary"
import { trimSessions } from "../../../../../app/src/context/global-sync/session-trim"
import { dropSessionCaches } from "../../../../../app/src/context/global-sync/session-cache"
import { applyDirectoryEvent as upstreamApplyDirectoryEvent } from "../../../../../app/src/context/global-sync/event-reducer"
import type { SetStoreFunction, Store } from "solid-js/store"
import { produce, reconcile } from "solid-js/store"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { State, VcsCache } from "@/context/global-sync/types"
import { hasOpenSession } from "./open-sessions"

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionId: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionId) return
  setSessionTodo?.(sessionId, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionId])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
  directory?: string,
) {
  const keep = new Set(next.map((item) => item.id))
  const all = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.keys(store.session_agent ?? {}),
    ...Object.keys(store.session_config ?? {}),
    ...Object.keys(store.session_usage ?? {}),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionId): sessionId is string => !!sessionId),
  ].filter((sessionId, idx, list) => {
    if (keep.has(sessionId)) return false
    if (list.indexOf(sessionId) !== idx) return false
    return true
  })
  const stale = all.filter((sessionId) => {
    if (!directory) return true
    return !hasOpenSession(directory, sessionId)
  })
  if (stale.length === 0) return
  for (const sessionId of stale) {
    setSessionTodo?.(sessionId, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  vcsCache?: VcsCache
}) {
  switch (input.event.type) {
    case "process.status":
    case "process.started":
    case "process.stopped":
    case "process.crashed":
    case "process.config.changed":
      // Handled by ProcessPaneProvider via direct SSE subscription
      break
    case "session.created": {
      const info = (input.event.properties as { info: Session }).info
      const idx = Binary.search(input.store.session, info.id, (item) => item.id)
      if (idx.found) {
        input.setStore("session", idx.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(idx.index, 0, info)
      const list = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(list, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, list, input.setSessionTodo, input.directory)
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (input.event.properties as { info: Session }).info
      const idx = Binary.search(input.store.session, info.id, (item) => item.id)
      if (info.time.archived) {
        if (idx.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(idx.index, 1)
            }),
          )
        }
        cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (idx.found) {
        input.setStore("session", idx.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(idx.index, 0, info)
      const list = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(list, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, list, input.setSessionTodo, input.directory)
      break
    }
    default:
      upstreamApplyDirectoryEvent(input)
      break
  }
}
