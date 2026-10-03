import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import type { RuntimeSessionStatus } from "./runtime-session-status"
import { hostSessionRowFromMeta } from "./session-row"

export type SessionRowRead =
  | { kind: "row"; row: HostSessionRow }
  /** No root session by that id in that workspace any more. */
  | { kind: "absent" }
  /** A child session, which is never a list entry of its own. */
  | { kind: "child" }

export type SessionRowSource = {
  /** Every root session of the workspace, archived ones included, with the status its runtime holds now. */
  listRows: (workspaceId: string) => Promise<HostSessionRow[]>
  readRow: (workspaceId: string, sessionId: string) => Promise<SessionRowRead>
}

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
