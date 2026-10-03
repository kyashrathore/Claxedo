import type { D1Database } from "@cloudflare/workers-types"
import {
  planHostSessionRows,
  type HostSessionRow,
  type HostSessionRowsPublication,
  type HostSessionRowsPublisher,
  type HostSessionRowsResult,
} from "@claxedo/server-core/platform/auth/host-session-rows"
import { sessionAdoptionOperationId } from "@claxedo/server-core/platform/auth/private-session-authority"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"

type ServedWorkspace = { workspace_id: string; owner_actor_id: string; org_id: string; project_id: string }

/**
 * Lands a machine's published list rows in the session registry.
 *
 * A row is admitted only for a workspace this enrollment serves right now, by
 * the same predicate that routes the relay and mints the tunnel credential,
 * so a machine that lost the assignment or was superseded by a newer serving
 * generation stops publishing on its next call. A session the registry has
 * never seen is adopted for the enrollment owner, as `adoptRuntimeSession`
 * adopts one: the machine held it before anyone reached it through the plane.
 *
 * Republishing is idempotent: turn and update times only move forward, and a
 * status replaces the held one only when it was reported at or after it.
 */
export async function publishD1HostSessionRows(
  database: D1Database,
  now: number,
  publisher: HostSessionRowsPublisher,
  publication: HostSessionRowsPublication,
): Promise<HostSessionRowsResult> {
  const touched = [...publication.rows, ...publication.removed]
  const served = await servedD1Workspaces(database, now, publisher, [...new Set(touched.map((row) => row.workspaceId))])
  const existing = await registeredD1Sessions(database, [...new Set(touched.map((row) => row.sessionId))])
  const plan = planHostSessionRows(publication, served, existing)
  const statements = [
    ...plan.adopt.flatMap(({ row, workspace }) => adoptionStatements(database, now, workspace, row)),
    ...plan.update.map((row) => listFieldsStatement(database, row)),
    ...plan.remove.map((ref) =>
      database
        .prepare(`update sessions set deleted_at = ? where session_id = ? and workspace_id = ? and deleted_at is null`)
        .bind(now, ref.sessionId, ref.workspaceId)),
  ]
  if (statements.length) await database.batch(statements)
  return plan.result
}

async function servedD1Workspaces(
  database: D1Database,
  now: number,
  publisher: HostSessionRowsPublisher,
  workspaceIds: string[],
) {
  const claimed = workspaceIds.filter((id) => publisher.workspaceIds.includes(id))
  if (!claimed.length) return new Map<string, ServedWorkspace>()
  const fence = publisher.enrollmentId !== undefined && publisher.generation !== undefined
  const result = await database
    .prepare(`
      select assignment.workspace_id, assignment.owner_actor_id, w.org_id, w.project_id
      from host_workspace_assignments assignment
      join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      join workspaces w on w.workspace_id = assignment.workspace_id and w.deleted_at is null
      where assignment.host_id = ? and enrollment.owner_user_id = ?
        and assignment.workspace_id in (${claimed.map(() => "?").join(", ")})
        ${fence ? "and enrollment.enrollment_id = ? and enrollment.serving_generation = ?" : ""}
        and ${HOST_SERVING_WORKSPACE_SQL}
    `)
    .bind(
      publisher.hostId,
      publisher.ownerUserId,
      ...claimed,
      ...(fence ? [publisher.enrollmentId, publisher.generation] : []),
      now,
    )
    .all<ServedWorkspace>()
  return new Map(result.results.map((row) => [row.workspace_id, row]))
}

async function registeredD1Sessions(database: D1Database, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, { workspaceId: string; deleted: boolean }>()
  const result = await database
    .prepare(`select session_id, workspace_id, deleted_at from sessions where session_id in (${sessionIds.map(() => "?").join(", ")})`)
    .bind(...sessionIds)
    .all<{ session_id: string; workspace_id: string; deleted_at: number | null }>()
  return new Map(result.results.map((row) => [row.session_id, { workspaceId: row.workspace_id, deleted: row.deleted_at !== null }]))
}

function adoptionStatements(database: D1Database, now: number, workspace: ServedWorkspace, row: HostSessionRow) {
  const operationId = sessionAdoptionOperationId(row.sessionId)
  return [
    database
      .prepare(`delete from session_registration_operations where session_id = ? and state = 'compensated'`)
      .bind(row.sessionId),
    database
      .prepare(`
        insert into session_registration_operations (
          operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
          operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'create', null, ?, 'registered', null, ?, ?)
        on conflict do nothing
      `)
      .bind(operationId, row.sessionId, workspace.workspace_id, workspace.org_id, workspace.project_id,
        workspace.owner_actor_id, row.title ?? null, now, now),
    database
      .prepare(`
        insert into sessions (
          session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          lifecycle_generation, title, created_at, updated_at, deleted_at,
          max_event_ordinal, snapshot_generation, snapshot_hash, snapshot_token
        )
        select session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          1, requested_title, ?, ?, null, 0, 0, null, null
        from session_registration_operations
        where operation_id = ? and state = 'registered'
        on conflict do nothing
      `)
      .bind(row.createdAt, row.updatedAt, operationId),
  ]
}

function listFieldsStatement(database: D1Database, row: HostSessionRow) {
  const status = row.status
  const at = row.lastTurn?.completedAt ?? null
  return database
    .prepare(`
      update sessions set
        title = coalesce(?, title),
        updated_at = max(updated_at, ?),
        last_human_turn_at = case when ? is null then last_human_turn_at
          else max(coalesce(last_human_turn_at, 0), ?) end,
        archived_at = ?,
        status = case when status_at is null or status_at <= ? then ? else status end,
        awaiting_input = case when status_at is null or status_at <= ? then ? else awaiting_input end,
        status_at = case when status_at is null or status_at <= ? then ? else status_at end,
        last_turn_status = case when ? is not null and coalesce(last_turn_completed_at, 0) <= ? then ? else last_turn_status end,
        last_turn_completed_at = case when ? is not null and coalesce(last_turn_completed_at, 0) <= ? then ? else last_turn_completed_at end
      where session_id = ? and workspace_id = ? and deleted_at is null
    `)
    .bind(
      row.title ?? null,
      row.updatedAt,
      row.lastHumanTurnAt ?? null,
      row.lastHumanTurnAt ?? null,
      row.archivedAt ?? null,
      status.at, status.kind,
      status.at, status.awaitingInput ? 1 : 0,
      status.at, status.at,
      at, at, row.lastTurn?.status ?? null,
      at, at, at,
      row.sessionId,
      row.workspaceId,
    )
}
