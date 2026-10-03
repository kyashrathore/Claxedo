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
import { batchUnder, type BoundSql } from "./authorization"
import { sessionAttentionStatements } from "./session-attention-history"

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
  const touched = [...publication.rows, ...publication.removed, ...(publication.attention ?? [])]
  const served = await servedD1Workspaces(database, now, publisher, [...new Set(touched.map((row) => row.workspaceId))])
  const existing = await registeredD1Sessions(database, [...new Set(touched.map((row) => row.sessionId))])
  const plan = planHostSessionRows(publication, served, existing)
  const statements = [
    ...plan.adopt.flatMap(({ row, workspace }) => adoptionStatements(database, now, workspace, row)),
    ...plan.update.map((row) => listFieldsStatement(database, row)),
    ...plan.update.flatMap((row) => sessionAttentionFieldsStatements(database, row, undefined,
      publisher.enrollmentId !== undefined && publisher.generation !== undefined
        ? { hostId: publisher.hostId, generation: publisher.generation, enrollmentId: publisher.enrollmentId } : undefined)),
    ...sessionAttentionStatements(database, plan.attention, plan.attention),
    ...plan.remove.map((ref) =>
      database
        .prepare(`update sessions set deleted_at = ? where session_id = ? and workspace_id = ? and deleted_at is null`)
        .bind(now, ref.sessionId, ref.workspaceId)),
  ]
  if (statements.length) {
    const admittedWorkspaces = [...new Set([...plan.update, ...plan.remove, ...plan.attention].map((ref) => ref.workspaceId))]
    const query = servedD1WorkspacesQuery(now, publisher, admittedWorkspaces)
    if (!query) throw new Error("Session publication has no served workspace")
    await batchUnder(database, { sql: `(SELECT COUNT(*) FROM (${query.sql})) = ?`, bind: [...query.bind, admittedWorkspaces.length] }, statements)
  }
  return plan.result
}

export async function servedD1Workspaces(
  database: D1Database,
  now: number,
  publisher: HostSessionRowsPublisher,
  workspaceIds: string[],
) {
  const query = servedD1WorkspacesQuery(now, publisher, workspaceIds)
  if (!query) return new Map<string, ServedWorkspace>()
  const result = await database.prepare(query.sql).bind(...query.bind).all<ServedWorkspace>()
  return new Map(result.results.map((row) => [row.workspace_id, row]))
}

function servedD1WorkspacesQuery(now: number, publisher: HostSessionRowsPublisher, workspaceIds: string[]): BoundSql | undefined {
  const claimed = workspaceIds.filter((id) => publisher.workspaceIds.includes(id))
  if (!claimed.length) return undefined
  const fence = publisher.enrollmentId !== undefined && publisher.generation !== undefined
  return { sql: `
      select assignment.workspace_id, assignment.owner_actor_id, w.org_id, w.project_id
      from host_workspace_assignments assignment
      join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      join workspaces w on w.workspace_id = assignment.workspace_id and w.deleted_at is null
      where assignment.host_id = ? and enrollment.owner_user_id = ?
        and assignment.workspace_id in (SELECT value FROM json_each(?))
        ${fence ? "and enrollment.enrollment_id = ? and enrollment.serving_generation = ?" : ""}
        and ${HOST_SERVING_WORKSPACE_SQL}
    `, bind: [
      publisher.hostId,
      publisher.ownerUserId,
      JSON.stringify(claimed),
      ...(fence ? [publisher.enrollmentId, publisher.generation] : []),
      now,
    ] }
}

async function registeredD1Sessions(database: D1Database, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, { workspaceId: string; deleted: boolean }>()
  const result = await database
    .prepare(`select session_id, workspace_id, deleted_at from sessions where session_id in (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(sessionIds))
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

export function listFieldsStatement(database: D1Database, row: HostSessionRow, guard?: BoundSql) {
  const status = row.status
  return database
    .prepare(`
      update sessions set
        title = coalesce(?, title),
        parent_session_id = ?,
        updated_at = max(updated_at, ?),
        last_human_turn_at = case when ? is null then last_human_turn_at
          else max(coalesce(last_human_turn_at, 0), ?) end,
        archived_at = ?,
        status = case when status_at is null or status_at <= ? then ? else status end,
        awaiting_input = case when status_at is null or status_at <= ? then ? else awaiting_input end,
        status_at = case when status_at is null or status_at <= ? then ? else status_at end
      where session_id = ? and workspace_id = ? and deleted_at is null ${guard ? `and (${guard.sql})` : ""}
    `)
    .bind(
      row.title ?? null,
      row.parentSessionId ?? null,
      row.updatedAt,
      row.lastHumanTurnAt ?? null,
      row.lastHumanTurnAt ?? null,
      row.archivedAt ?? null,
      status.at, status.kind,
      status.at, status.awaitingInput ? 1 : 0,
      status.at, status.at,
      row.sessionId,
      row.workspaceId,
      ...(guard?.bind ?? []),
    )
}

export function sessionAttentionFieldsStatements(database: D1Database, row: HostSessionRow, guard?: BoundSql,
  producer?: { hostId: string; generation: number; enrollmentId?: string }) {
  if (!row.attention) return []
  return [database.prepare(`
    UPDATE sessions SET attention_json = ?, last_turn_json = ?,
      runtime_host_id = ?, runtime_generation = ?, runtime_enrollment_id = ?
    WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL
      AND (attention_json IS NULL OR json_extract(attention_json, '$.sequence') <= ?)
      ${guard ? `AND (${guard.sql})` : ""}
  `).bind(JSON.stringify(row.attention), row.lastTurn ? JSON.stringify(row.lastTurn) : null,
    producer?.hostId ?? null, producer?.generation ?? null, producer?.enrollmentId ?? null,
    row.sessionId, row.workspaceId, row.attention.sequence, ...(guard?.bind ?? []))]
}
