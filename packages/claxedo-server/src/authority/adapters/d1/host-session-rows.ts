import type { D1Database } from "@cloudflare/workers-types"
import {
  planHostSessionRows,
  type HostSessionRow,
  type HostSessionRowsOutcome,
  type HostSessionRowsPublication,
  type HostSessionRowsPublisher,
} from "@claxedo/server-core/platform/auth/host-session-rows"
import { sessionAdoptionOperationId } from "@claxedo/server-core/platform/auth/private-session-authority"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { SESSION_STATUS_COLUMNS, sessionStatusNotices, type SessionStatusColumns } from "./session-status-notices"

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
 * Republishing is idempotent: turn and update times only move forward, a
 * status (with its wait and background work) replaces the held one only when
 * it was reported at or after it, and a last turn replaces the held one only
 * when it ended later. Each row's update returns what it left, so the status
 * notices compare the committed row with the one read before the batch.
 */
export async function publishD1HostSessionRows(
  database: D1Database,
  now: number,
  publisher: HostSessionRowsPublisher,
  publication: HostSessionRowsPublication,
): Promise<HostSessionRowsOutcome> {
  const touched = [...publication.rows, ...publication.removed]
  const served = await servedD1Workspaces(database, now, publisher, [...new Set(touched.map((row) => row.workspaceId))])
  const existing = await registeredD1Sessions(database, [...new Set(touched.map((row) => row.sessionId))])
  const plan = planHostSessionRows(publication, served, existing)
  const adoptions = plan.adopt.flatMap(({ row, workspace }) => adoptionStatements(database, now, workspace, row))
  const statements = [
    ...adoptions,
    ...plan.update.map((row) => listFieldsStatement(database, row)),
    ...plan.remove.map((ref) =>
      database
        .prepare(`update sessions set deleted_at = ? where session_id = ? and workspace_id = ? and deleted_at is null`)
        .bind(now, ref.sessionId, ref.workspaceId)),
  ]
  if (!statements.length) return { ...plan.result, statusNotices: [] }
  const results = await database.batch<SessionStatusColumns>(statements)
  const written = results.slice(adoptions.length, adoptions.length + plan.update.length).flatMap((result) => result.results)
  const before = new Map([...existing].flatMap(([sessionId, session]) => (session.status ? [[sessionId, session.status]] : [])))
  return { ...plan.result, statusNotices: await sessionStatusNotices(database, before, written) }
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

type RegisteredSession = { workspaceId: string; deleted: boolean; status?: SessionStatusColumns }

async function registeredD1Sessions(database: D1Database, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, RegisteredSession>()
  const result = await database
    .prepare(`select ${SESSION_STATUS_COLUMNS}, deleted_at from sessions where session_id in (${sessionIds.map(() => "?").join(", ")})`)
    .bind(...sessionIds)
    .all<SessionStatusColumns & { deleted_at: number | null }>()
  return new Map(result.results.map(({ deleted_at, ...status }): [string, RegisteredSession] =>
    [status.session_id, { workspaceId: status.workspace_id, deleted: deleted_at !== null, status }]))
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
  const work = status.backgroundWork
  const at = row.lastTurn?.completedAt ?? null
  const current = "status_at is null or status_at <= ?"
  return database
    .prepare(`
      update sessions set
        title = coalesce(?, title),
        updated_at = max(updated_at, ?),
        last_human_turn_at = case when ? is null then last_human_turn_at
          else max(coalesce(last_human_turn_at, 0), ?) end,
        archived_at = ?,
        status = case when ${current} then ? else status end,
        awaiting_input = case when ${current} then ? else awaiting_input end,
        background_agents = case when ${current} then ? else background_agents end,
        background_shells = case when ${current} then ? else background_shells end,
        background_other = case when ${current} then ? else background_other end,
        status_at = case when ${current} then ? else status_at end,
        last_turn_status = case when ? is not null and (last_turn_completed_at is null or last_turn_completed_at < ?) then ? else last_turn_status end,
        last_turn_completed_at = case when ? is not null and (last_turn_completed_at is null or last_turn_completed_at < ?) then ? else last_turn_completed_at end
      where session_id = ? and workspace_id = ? and deleted_at is null
      returning ${SESSION_STATUS_COLUMNS}
    `)
    .bind(
      row.title ?? null,
      row.updatedAt,
      row.lastHumanTurnAt ?? null,
      row.lastHumanTurnAt ?? null,
      row.archivedAt ?? null,
      status.at, status.kind,
      status.at, status.awaitingInput ? 1 : 0,
      status.at, work?.agents ?? 0,
      status.at, work?.shells ?? 0,
      status.at, work?.other ?? 0,
      status.at, status.at,
      at, at, row.lastTurn?.status ?? null,
      at, at, at,
      row.sessionId,
      row.workspaceId,
    )
}
