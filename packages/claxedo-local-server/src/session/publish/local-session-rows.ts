import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import type { RuntimeSessionStatus } from "@claxedo/server-core/session/publish/runtime-session-status"
import type { SessionRowSource } from "@claxedo/server-core/session/publish/session-rows-publisher"
import { hostSessionRowFromMeta } from "./session-row"

/** Rows read from the local projection, with status from the runtimes mounted in this process. */
export function localSessionRowSource(
  store: Pick<SessionProjectionStore, "list_session_metas" | "session_meta">,
  status: Pick<RuntimeSessionStatus, "current" | "snapshot">,
): SessionRowSource {
  return {
    listRows: async (workspaceId) => {
      const metas = await store.list_session_metas({ workspaceID: workspaceId, includeArchived: true })
      const live = await status.snapshot(workspaceId)
      const rows: HostSessionRow[] = []
      for (const meta of metas) {
        const row = hostSessionRowFromMeta(meta, live.get(meta.sessionID) ?? status.current(workspaceId, meta.sessionID))
        if (row) rows.push(row)
      }
      return rows
    },
    readRow: async (workspaceId, sessionId) => {
      const meta = await store.session_meta(sessionId)
      if (!meta || meta.workspaceID !== workspaceId) return { kind: "absent" }
      if (meta.parentID) return { kind: "child" }
      const row = hostSessionRowFromMeta(meta, status.current(workspaceId, sessionId))
      return row ? { kind: "row", row } : { kind: "absent" }
    },
  }
}
