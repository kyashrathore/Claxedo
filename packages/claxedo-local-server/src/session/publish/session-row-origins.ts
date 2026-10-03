import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import { createSessionPublicationOrigins } from "@claxedo/server-core/session/publication-origin"
import type { SessionRowSource } from "./local-session-rows"

/** Machine startup policy over exact mounted runtime positions, independent of row batching. */
export function createSessionRowOrigins(source: Pick<SessionRowSource, "attentionSnapshot">) {
  const origins = createSessionPublicationOrigins()
  const seeded = new Set<string>()
  return {
    recover(workspaceId: string) {
      const snapshot = source.attentionSnapshot(workspaceId)
      if (snapshot === undefined) { seeded.delete(workspaceId); return }
      for (const row of snapshot) origins.remember({ workspaceId, sessionId: row.sessionId }, row.attention, true)
      seeded.add(workspaceId)
    },
    live(workspaceId: string, sessionId: string) {
      if (!seeded.has(workspaceId)) return
      const snapshot = source.attentionSnapshot(workspaceId, sessionId)
      if (snapshot === undefined) return
      for (const row of snapshot) origins.remember({ workspaceId, sessionId: row.sessionId }, row.attention, false)
    },
    replayed(row: HostSessionRow, recovering: boolean) {
      if (!row.attention) throw new Error(`Session ${row.sessionId} has no canonical attention position`)
      return origins.remember(row, row.attention, recovering || !seeded.has(row.workspaceId))
    },
    reset() { seeded.clear(); origins.reset() },
  }
}
