import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { record, raw } from "../../platform/json"

const log = Log.create({ service: "session-rows-publisher" })

export type SessionProjectionWriteObserver = {
  sessionChanged: (workspaceId: string, sessionId: string) => void
  sessionRemoved: (workspaceId: string, sessionId: string) => void
  /** A snapshot rewrote the workspace's rows; which ones changed is not known. */
  workspaceChanged: (workspaceId: string) => void
}

type ObservedWrites = Pick<
  SessionProjectionStore,
  "put_session_meta" | "delete_session_meta" | "sync_session_meta" | "sync_session_metas" | "session_meta"
>

/**
 * The projection store with every session-metadata write reported after it
 * lands — the HTTP tap, the runtime's `session.updated` events, the created
 * and snapshot hooks all write through these four methods, so this is the one
 * place a change to a session's list entry is seen.
 *
 * Reporting never fails the write: a report that throws costs a stale
 * published row, which the next full resync corrects, while a failed write
 * would cost the row itself.
 */
export function observedSessionProjectionStore<Store extends ObservedWrites>(
  store: Store,
  observer: SessionProjectionWriteObserver,
): Store {
  const report = (what: string, act: () => void | Promise<void>) => {
    return Promise.resolve()
      .then(act)
      .catch((error: unknown) => log.warn(`session row change not reported after ${what}`, { error: String(error) }))
  }
  const reportSession = (sessionId: string) => report("write", async () => {
    const meta = await store.session_meta(sessionId)
    if (meta?.workspaceID) observer.sessionChanged(meta.workspaceID, sessionId)
  })
  return {
    ...store,
    put_session_meta: async (sessionId, input) => {
      await store.put_session_meta(sessionId, input)
      await reportSession(sessionId)
    },
    sync_session_meta: async (ws, input) => {
      await store.sync_session_meta(ws, input)
      const sessionId = raw(record(input)?.id)
      if (sessionId) await reportSession(sessionId)
    },
    sync_session_metas: async (ws, input) => {
      await store.sync_session_metas(ws, input)
      if (ws?.id) await report("snapshot", () => observer.workspaceChanged(ws.id))
    },
    delete_session_meta: async (sessionId) => {
      const workspaceId = (await store.session_meta(sessionId).catch(() => undefined))?.workspaceID
      await store.delete_session_meta(sessionId)
      if (workspaceId) await report("delete", () => observer.sessionRemoved(workspaceId, sessionId))
    },
  }
}
