import type { D1Database } from "@cloudflare/workers-types"
import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SessionRowStatusKind } from "@claxedo/server-core/session/navigation-list"
import { sessionReaderSql } from "./authorization"

/** A session's status columns as `sessions` holds them, before or after a publication. */
export type SessionStatusColumns = {
  session_id: string
  workspace_id: string
  org_id: string
  status: SessionRowStatusKind | null
  status_at: number | null
  awaiting_input: number
  background_agents: number
  background_shells: number
  background_other: number
  last_turn_status: SessionLastTurn["status"] | null
  last_turn_completed_at: number | null
}

export const SESSION_STATUS_COLUMNS =
  "session_id, workspace_id, org_id, status, status_at, awaiting_input, background_agents, background_shells, background_other, last_turn_status, last_turn_completed_at"

export const SESSION_STATUS_STAMP_SQL = `status = case when status_at is null or status_at <= ? then ? else status end,
        awaiting_input = case when status_at is null or status_at <= ? then 0 else awaiting_input end,
        status_at = case when status_at is null or status_at <= ? then ? else status_at end`

export function sessionStatusStampBindings(status: "busy" | "idle", at: number) {
  return [at, status, at, at, at]
}

const REPORTED = [
  "status",
  "awaiting_input",
  "background_agents",
  "background_shells",
  "background_other",
  "last_turn_status",
  "last_turn_completed_at",
] as const

/** A newer `status_at` alone is a republish of the same status, not a change. */
function changed(before: SessionStatusColumns | undefined, after: SessionStatusColumns) {
  return after.status !== null && (!before || REPORTED.some((column) => before[column] !== after[column]))
}

/**
 * The people who hear each session's status: the owner of its workspace and
 * every person it is shared with, each only while the session read rule
 * still admits them, by their canonical user id, which their live-sync
 * connection is keyed by.
 */
async function readSessionReaders(database: D1Database, sessionIds: readonly string[]) {
  const marks = sessionIds.map(() => "?").join(", ")
  const result = await database
    .prepare(`
      with readers(session_id, user_id) as (
        select s.session_id, w.owner_user_id from sessions s
        join workspaces w on w.workspace_id = s.workspace_id
        where s.session_id in (${marks})
        union
        select g.session_id, g.target_user_id from session_share_grants g
        where g.session_id in (${marks}) and g.revoked_at is null
      )
      select r.session_id, r.user_id
      from readers r
      join sessions s on s.session_id = r.session_id
      where ${sessionReaderSql("s", "r.user_id")}
    `)
    .bind(...sessionIds, ...sessionIds)
    .all<{ session_id: string; user_id: string }>()
  const readers = new Map<string, Set<string>>()
  for (const row of result.results) readers.set(row.session_id, (readers.get(row.session_id) ?? new Set()).add(row.user_id))
  return readers
}

function statusNoticeFor(row: SessionStatusColumns & { status: SessionRowStatusKind }, ownerUserId: string): SessionStatusChangedEvent {
  const backgroundWork = { agents: row.background_agents, shells: row.background_shells, other: row.background_other }
  const active = backgroundWork.agents + backgroundWork.shells + backgroundWork.other > 0
  return {
    type: "session.status.changed",
    ownerUserId,
    orgId: row.org_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    status: row.status,
    awaitingInput: row.awaiting_input === 1,
    ...(active ? { backgroundWork } : {}),
    ...(row.last_turn_status !== null && row.last_turn_completed_at !== null
      ? { lastTurn: { status: row.last_turn_status, completedAt: row.last_turn_completed_at } }
      : {}),
    ts: row.status_at ?? 0,
  }
}

/** One notice per reader of every session whose reported status the write changed. */
export async function sessionStatusNotices(
  database: D1Database,
  before: ReadonlyMap<string, SessionStatusColumns>,
  after: readonly SessionStatusColumns[],
): Promise<SessionStatusChangedEvent[]> {
  const changes = after.filter((row): row is SessionStatusColumns & { status: SessionRowStatusKind } =>
    changed(before.get(row.session_id), row))
  if (!changes.length) return []
  const readers = await readSessionReaders(database, changes.map((row) => row.session_id))
  return changes.flatMap((row) => [...(readers.get(row.session_id) ?? [])].map((userId) => statusNoticeFor(row, userId)))
}
