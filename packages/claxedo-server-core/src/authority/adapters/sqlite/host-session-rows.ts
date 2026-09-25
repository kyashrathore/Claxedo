import {
  planHostSessionRows,
  type HostSessionRow,
  type HostSessionRowsPublication,
  type HostSessionRowsPublisher,
  type HostSessionRowsResult,
} from "@claxedo/server-core/platform/auth/host-session-rows"
import { sessionAdoptionOperationId } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

type ServedWorkspace = { workspace_id: string; owner_token_identifier: string }

/**
 * The self-hosted twin of the hosted registry's machine row intake: admitted
 * only for workspaces this enrollment serves now (`servingSql`, the adapter's
 * serving predicate over `assignment` and `enrollment`), adopting unseen
 * sessions for the enrollment owner, and never moving a turn, an update time
 * or a status backwards.
 */
export function publishSqliteHostSessionRows(
  db: SqliteAuthorityDb,
  now: number,
  servingSql: string,
  publisher: HostSessionRowsPublisher,
  publication: HostSessionRowsPublication,
): HostSessionRowsResult {
  return db.transaction(() => {
    const touched = [...publication.rows, ...publication.removed]
    const served = servedSqliteWorkspaces(db, now, servingSql, publisher, [...new Set(touched.map((row) => row.workspaceId))])
    const plan = planHostSessionRows(publication, served, registeredSqliteSessions(db, [...new Set(touched.map((row) => row.sessionId))]))
    for (const { row, workspace } of plan.adopt) adopt(db, now, workspace, row)
    for (const row of plan.update) writeListFields(db, row)
    for (const ref of plan.remove) {
      db.prepare(`
        UPDATE session_history SET deleted_at = ?, updated_at = MAX(updated_at, ?)
        WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL
      `).run(now, now, ref.sessionId, ref.workspaceId)
    }
    return plan.result
  })()
}

function servedSqliteWorkspaces(
  db: SqliteAuthorityDb,
  now: number,
  servingSql: string,
  publisher: HostSessionRowsPublisher,
  workspaceIds: string[],
) {
  const claimed = workspaceIds.filter((id) => publisher.workspaceIds.includes(id))
  if (!claimed.length) return new Map<string, ServedWorkspace>()
  const fence = publisher.enrollmentId !== undefined && publisher.generation !== undefined
  const rows = db.prepare<unknown[], ServedWorkspace>(`
    SELECT assignment.workspace_id, assignment.owner_token_identifier
    FROM host_workspace_assignments assignment
    JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
      AND enrollment.owner_token_identifier = assignment.owner_token_identifier
    JOIN workspaces w ON w.workspace_id = assignment.workspace_id AND w.deleted_at IS NULL
    WHERE assignment.host_id = ? AND enrollment.owner_token_identifier = ?
      AND assignment.workspace_id IN (${claimed.map(() => "?").join(", ")})
      ${fence ? "AND enrollment.enrollment_id = ? AND enrollment.serving_generation = ?" : ""}
      AND ${servingSql}
  `).all(
    publisher.hostId,
    publisher.ownerUserId,
    ...claimed,
    ...(fence ? [publisher.enrollmentId, publisher.generation] : []),
    now,
  )
  return new Map(rows.map((row) => [row.workspace_id, row]))
}

function registeredSqliteSessions(db: SqliteAuthorityDb, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, { workspaceId: string; deleted: boolean }>()
  const rows = db.prepare<unknown[], { session_id: string; workspace_id: string; deleted_at: number | null }>(`
    SELECT session_id, workspace_id, deleted_at FROM session_history
    WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})
  `).all(...sessionIds)
  return new Map(rows.map((row) => [row.session_id, { workspaceId: row.workspace_id, deleted: row.deleted_at !== null }]))
}

function adopt(db: SqliteAuthorityDb, now: number, workspace: ServedWorkspace, row: HostSessionRow) {
  const operationId = sessionAdoptionOperationId(row.sessionId)
  const owner = workspace.owner_token_identifier
  db.prepare(`DELETE FROM session_registration_operations WHERE session_id = ? AND state = 'compensated'`).run(row.sessionId)
  db.prepare(`
    INSERT INTO session_registration_operations (
      operation_id, session_id, workspace_id, creator_actor_id, operation_kind,
      parent_session_id, requested_title, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'create', NULL, ?, 'registered', ?, ?)
    ON CONFLICT DO NOTHING
  `).run(operationId, row.sessionId, row.workspaceId, owner, row.title ?? null, now, now)
  db.prepare(`
    INSERT INTO session_history (
      session_id, workspace_id, creator_actor_id, operation_id, title, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(row.sessionId, row.workspaceId, owner, operationId, row.title ?? null, row.createdAt, row.updatedAt)
  db.prepare(`
    INSERT INTO session_participants (
      session_id, workspace_id, participant_actor_id, added_by_actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(row.sessionId, row.workspaceId, owner, owner, now)
}

function writeListFields(db: SqliteAuthorityDb, row: HostSessionRow) {
  const status = row.status
  db.prepare(`
    UPDATE session_history SET
      title = COALESCE(?, title),
      updated_at = MAX(updated_at, ?),
      last_human_turn_at = CASE WHEN ? IS NULL THEN last_human_turn_at
        ELSE MAX(COALESCE(last_human_turn_at, 0), ?) END,
      archived_at = ?,
      status = CASE WHEN status_at IS NULL OR status_at <= ? THEN ? ELSE status END,
      awaiting_input = CASE WHEN status_at IS NULL OR status_at <= ? THEN ? ELSE awaiting_input END,
      status_at = CASE WHEN status_at IS NULL OR status_at <= ? THEN ? ELSE status_at END
    WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL
  `).run(
    row.title ?? null,
    row.updatedAt,
    row.lastHumanTurnAt ?? null,
    row.lastHumanTurnAt ?? null,
    row.archivedAt ?? null,
    status.at, status.kind,
    status.at, status.awaitingInput ? 1 : 0,
    status.at, status.at,
    row.sessionId,
    row.workspaceId,
  )
}
