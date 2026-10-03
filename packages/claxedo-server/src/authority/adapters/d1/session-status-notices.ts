import type { D1Database } from "@cloudflare/workers-types"
import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { SessionRowStatusKind } from "@claxedo/server-core/session/navigation-list"
import { orgMemberSql } from "./authorization"

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
 * The people who read each session and hear its status: the owner of its
 * workspace and every person it is shared with directly, while each is active
 * and stands in the session's organization, under every subject they sign in
 * with. A share to an organization or a team names no person and hears nothing.
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
        where g.session_id in (${marks}) and g.revoked_at is null and g.target_user_id is not null
      )
      select r.session_id, ai.subject
      from readers r
      join sessions s on s.session_id = r.session_id
      join users u on u.user_id = r.user_id and u.state = 'active'
      join auth_identities ai on ai.user_id = r.user_id and ai.unlinked_at is null
      where ${orgMemberSql("s.org_id", "r.user_id")}
    `)
    .bind(...sessionIds, ...sessionIds)
    .all<{ session_id: string; subject: string }>()
  const readers = new Map<string, Set<string>>()
  for (const row of result.results) readers.set(row.session_id, (readers.get(row.session_id) ?? new Set()).add(row.subject))
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
  return changes.flatMap((row) => [...(readers.get(row.session_id) ?? [])].map((subject) => statusNoticeFor(row, subject)))
}
