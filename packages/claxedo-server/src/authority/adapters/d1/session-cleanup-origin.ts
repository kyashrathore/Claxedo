import type { D1Database } from "@cloudflare/workers-types"
import type { HostSessionRowsPublisher } from "@claxedo/server-core/platform/auth/host-session-rows"
import { servedD1Workspaces } from "./host-session-rows"

export async function hostSessionCleanupOrigin(database: D1Database, publisher: HostSessionRowsPublisher, workspaceId: string, sessionId: string, now = Date.now()) {
  const workspace = (await servedD1Workspaces(database, now, publisher, [workspaceId])).get(workspaceId)
  if (!workspace) return undefined
  return cleanupOrigin(database, publisher.ownerUserId, workspace.owner_actor_id, workspaceId, sessionId)
}

export async function cleanupOrigin(database: D1Database, userId: string, actorId: string, workspaceId: string, sessionId: string) {
  return await database.prepare(`
    WITH RECURSIVE ancestors(session_id, parent_session_id, creator_actor_id, deleted_at, path) AS (
      SELECT session_id, parent_session_id, creator_actor_id, deleted_at, ',' || session_id || ','
      FROM sessions WHERE session_id = ? AND workspace_id = ?
      UNION ALL
      SELECT parent.session_id, parent.parent_session_id, parent.creator_actor_id, parent.deleted_at, child.path || parent.session_id || ','
      FROM sessions parent JOIN ancestors child ON parent.session_id = child.parent_session_id
      WHERE parent.workspace_id = ? AND instr(child.path, ',' || parent.session_id || ',') = 0
    )
    SELECT s.session_id FROM ancestors s
    JOIN actors owner ON owner.actor_id = s.creator_actor_id AND owner.user_id = ? AND owner.kind = 'human' AND owner.state = 'active'
    JOIN users u ON u.user_id = owner.user_id AND u.state = 'active'
    WHERE s.session_id = ? AND s.creator_actor_id = ? AND s.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ancestors ancestor WHERE ancestor.deleted_at IS NOT NULL OR ancestor.creator_actor_id <> s.creator_actor_id
          OR (ancestor.parent_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ancestors parent WHERE parent.session_id = ancestor.parent_session_id))
          OR (ancestor.parent_session_id IS NOT NULL AND instr(ancestor.path, ',' || ancestor.parent_session_id || ',') > 0)
      )
      AND NOT EXISTS (
        SELECT 1 FROM session_turn_producers producer JOIN actors actor ON actor.actor_id = producer.actor_id
        WHERE producer.session_id IN (SELECT session_id FROM ancestors) AND actor.kind = 'human' AND producer.actor_id <> s.creator_actor_id
      )
  `).bind(sessionId, workspaceId, workspaceId, userId, sessionId, actorId).first<{ session_id: string }>().then(Boolean)
}

export async function cleanupOriginParentMatches(database: D1Database, workspaceId: string, sessionId: string, parentSessionId: string | undefined) {
  const row = await database.prepare("SELECT parent_session_id FROM sessions WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL")
    .bind(sessionId, workspaceId).first<{ parent_session_id: string | null }>()
  return row !== null && row.parent_session_id === (parentSessionId ?? null)
}
