import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionAttentionFacts, SessionAttentionPage, SessionRef } from "@claxedo/agent-runtime-contract"
import { sessionAttentionPageSchema } from "@claxedo/server-core/session/session-publication"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import type { RuntimeSessionStatus } from "./runtime-session-status"
import { hostSessionRowFromMeta } from "./session-row"
import { readMountedEmbeddedWorkspaceRuntime, readMountedEmbeddedWorkspaceRuntimeAttention, readMountedEmbeddedWorkspaceRuntimeRemoved } from "../../deployments/local/embedded-workspace-runtime"

export type SessionRowRead =
  | { kind: "row"; row: HostSessionRow }
  /** No root session by that id in that workspace any more. */
  | { kind: "absent" }
  /** A child session, which is never a list entry of its own. */
  | { kind: "child" }

export type SessionRowSource = {
  prepareWorkspace: (workspaceId: string) => Promise<void>
  /** Synchronous committed root facts; undefined until the workspace's runtime is mounted. */
  attentionSnapshot: (workspaceId: string, sessionId?: string) => Array<{ sessionId: string; attention: SessionAttentionFacts }> | undefined
  /** Every root session of the workspace, archived ones included, with the status its runtime holds now. */
  listRows: (workspaceId: string) => Promise<HostSessionRow[]>
  readRow: (workspaceId: string, sessionId: string) => Promise<SessionRowRead>
  attentionPage: (workspaceId: string, sessionId: string, after: number) => Promise<SessionAttentionPage>
  removedRows: (workspaceId: string) => Promise<SessionRef[]>
}

/** Rows read from the local projection, with status from the runtimes mounted in this process. */
export function localSessionRowSource(
  store: Pick<SessionProjectionStore, "list_session_metas" | "session_meta">,
  status: Pick<RuntimeSessionStatus, "current" | "snapshot">,
  refresh: (workspaceId: string, sessionId: string) => Promise<boolean>,
  prepareWorkspace: (workspaceId: string) => Promise<void>,
): SessionRowSource {
  return {
    prepareWorkspace,
    attentionSnapshot: readMountedEmbeddedWorkspaceRuntimeAttention,
    removedRows: async (workspaceId) => {
      const removed = readMountedEmbeddedWorkspaceRuntimeRemoved(workspaceId)
      if (removed === undefined) throw new Error(`Runtime ${workspaceId} is unavailable`)
      return removed.map((sessionId) => ({ workspaceId, sessionId }))
    },
    attentionPage: async (workspaceId, sessionId, after) => {
      const path = `/session/${encodeURIComponent(sessionId)}/attention?after=${after}&limit=256`
      const response = await readMountedEmbeddedWorkspaceRuntime(workspaceId, path)
      if (!response?.ok) throw new Error(`Session attention history unavailable: ${response?.status ?? "runtime unavailable"}`)
      return sessionAttentionPageSchema.parse(await response.json())
    },
    listRows: async (workspaceId) => {
      const metas = await store.list_session_metas({ workspaceID: workspaceId, includeArchived: true })
      const absent = new Set<string>()
      for (const meta of metas) {
        if (!meta.parentID && !await refresh(workspaceId, meta.sessionID)) absent.add(meta.sessionID)
      }
      const live = await status.snapshot(workspaceId)
      if (!live) throw new Error(`Runtime ${workspaceId} is unavailable`)
      const rows: HostSessionRow[] = []
      for (const previous of metas) {
        if (absent.has(previous.sessionID)) continue
        const meta = previous.parentID ? previous : await store.session_meta(previous.sessionID)
        if (!meta) continue
        const current = live.get(meta.sessionID) ?? status.current(workspaceId, meta.sessionID)
        if (!current) throw new Error(`Runtime status for ${meta.sessionID} is unavailable`)
        const row = hostSessionRowFromMeta(meta, current)
        if (row) rows.push(row)
      }
      return rows
    },
    readRow: async (workspaceId, sessionId) => {
      let meta = await store.session_meta(sessionId)
      if (!meta || meta.workspaceID !== workspaceId) return { kind: "absent" }
      if (meta.parentID) return { kind: "child" }
      if (!await refresh(workspaceId, sessionId)) return { kind: "absent" }
      meta = await store.session_meta(sessionId)
      if (!meta) return { kind: "absent" }
      let current = status.current(workspaceId, sessionId)
      if (!current) {
        await status.snapshot(workspaceId)
        current = status.current(workspaceId, sessionId)
      }
      if (!current) throw new Error(`Runtime status for ${sessionId} is unavailable`)
      const row = hostSessionRowFromMeta(meta, current)
      return row ? { kind: "row", row } : { kind: "absent" }
    },
  }
}
