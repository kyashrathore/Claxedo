import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { SessionRowStatus } from "@claxedo/server-core/session/navigation-list"

/** The list entry a machine publishes for one of its root sessions; nothing for a child or an unplaced one. */
export function hostSessionRowFromMeta(meta: SessionMeta, status: SessionRowStatus): HostSessionRow | undefined {
  if (meta.parentID || !meta.workspaceID) return undefined
  return {
    workspaceId: meta.workspaceID,
    sessionId: meta.sessionID,
    ...(meta.title ? { title: meta.title } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.lastHumanTurnAt !== undefined ? { lastHumanTurnAt: meta.lastHumanTurnAt } : {}),
    ...(meta.archived !== undefined ? { archivedAt: meta.archived } : {}),
    status,
    ...(meta.lastTurn ? { lastTurn: meta.lastTurn } : {}),
  }
}
