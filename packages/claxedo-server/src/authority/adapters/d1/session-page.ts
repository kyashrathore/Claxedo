import type { D1Database } from "@cloudflare/workers-types"
import type { SessionPageQuery } from "@claxedo/server-core/platform/auth/private-session-authority"
import { sessionOrderSql } from "@claxedo/server-core/session/navigation-order"
import type { BoundSql } from "./authorization"

type SessionPageRow = {
  session_id: string
  workspace_id: string
  project_id: string
  title: string | null
  created_at: number
  updated_at: number
  last_human_turn_at: number | null
  archived_at: number | null
  status: string | null
  status_at: number | null
  awaiting_input: number
}

const COLUMNS = {
  lastHumanTurnAt: "s.last_human_turn_at",
  createdAt: "s.created_at",
  updatedAt: "s.updated_at",
  sessionRef: "('workspace:' || s.workspace_id || ':session:' || s.session_id)",
}

/** `access` is the caller's read predicate over `s`, with the values its placeholders bind. */
export async function readD1SessionPage(database: D1Database, query: SessionPageQuery, access: BoundSql) {
  const where = ["s.deleted_at is null"]
  const params: unknown[] = []
  if ("projectId" in query) {
    where.push("s.project_id = ?")
    params.push(query.projectId)
  } else {
    where.push("s.workspace_id = ?")
    params.push(query.workspaceId)
  }
  if (query.archived === "archived") where.push("s.archived_at is not null")
  if (query.archived === "active") where.push("s.archived_at is null")
  if (query.search) {
    where.push("lower(coalesce(s.title, '')) like ?")
    params.push(`%${query.search.toLowerCase()}%`)
  }
  where.push(access.sql)
  params.push(...access.bind)
  const order = sessionOrderSql(COLUMNS, query.sort, query.after)
  if (order.keyset) {
    where.push(order.keyset.sql)
    params.push(...order.keyset.params)
  }
  const result = await database
    .prepare(`
      select s.session_id, s.workspace_id, s.project_id, s.title, s.created_at, s.updated_at,
        s.last_human_turn_at, s.archived_at, s.status, s.status_at, s.awaiting_input
      from sessions s
      where ${where.join(" and ")}
      order by ${order.orderBy}
      limit ?
    `)
    .bind(...params, query.limit)
    .all<SessionPageRow>()
  return result.results.map(pageRowJson)
}

function pageRowJson(row: SessionPageRow) {
  return {
    session_id: row.session_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.last_human_turn_at === null ? {} : { last_human_turn_at: row.last_human_turn_at }),
    ...(row.archived_at === null ? {} : { archived_at: row.archived_at }),
    ...(row.status === null || row.status_at === null
      ? {}
      : { status: row.status, status_at: row.status_at, awaiting_input: row.awaiting_input === 1 }),
  }
}
