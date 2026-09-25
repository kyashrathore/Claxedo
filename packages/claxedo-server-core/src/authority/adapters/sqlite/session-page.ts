import type { SessionPageQuery } from "@claxedo/server-core/platform/auth/private-session-authority"
import { sessionOrderSql, type SessionOrderKey } from "@claxedo/server-core/session/navigation-order"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

export type SessionPageRow = {
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  created_at: number
  updated_at: number
  last_human_turn_at: number | null
}

const SESSION_REF = "('workspace:' || h.workspace_id || ':session:' || h.session_id)"

const COLUMNS = {
  lastHumanTurnAt: "h.last_human_turn_at",
  createdAt: "h.created_at",
  updatedAt: "h.updated_at",
  sessionRef: SESSION_REF,
}

const MIN_SCAN = 32

/**
 * Walks the keyset in the session list's order and keeps the rows `admits`
 * lets through, until the page is full or the store runs out.
 *
 * Admission is this store's per-row check, shared with every other session
 * read, so the walk continues from the last row it scanned rather than the
 * last one it kept: resuming from a kept row would rescan refused ones, and a
 * page never comes back short while admitted rows remain after it.
 */
export function readSqliteSessionPage<Row extends SessionPageRow>(
  db: SqliteAuthorityDb,
  query: SessionPageQuery,
  admits: (row: Row) => boolean,
): Row[] {
  const kept: Row[] = []
  const scan = Math.max(query.limit, MIN_SCAN)
  let after = query.after
  for (;;) {
    const rows = scanRows<Row>(db, query, after, scan)
    for (const row of rows) {
      if (!admits(row)) continue
      kept.push(row)
      if (kept.length === query.limit) return kept
    }
    const last = rows.at(-1)
    if (rows.length < scan || !last) return kept
    after = orderKeyOf(last)
  }
}

function scanRows<Row>(db: SqliteAuthorityDb, query: SessionPageQuery, after: SessionOrderKey | undefined, limit: number) {
  const where = ["h.deleted_at IS NULL", "w.deleted_at IS NULL"]
  const params: Array<string | number | null> = []
  if ("projectId" in query) {
    where.push("w.project_id = ?")
    params.push(query.projectId)
  } else {
    where.push("h.workspace_id = ?")
    params.push(query.workspaceId)
  }
  if (query.archived === "archived") where.push("h.archived_at IS NOT NULL")
  if (query.archived === "active") where.push("h.archived_at IS NULL")
  if (query.search) {
    where.push("LOWER(COALESCE(h.title, '')) LIKE ?")
    params.push(`%${query.search.toLowerCase()}%`)
  }
  const order = sessionOrderSql(COLUMNS, query.sort, after)
  if (order.keyset) {
    where.push(order.keyset.sql)
    params.push(...order.keyset.params)
  }
  return db.prepare<unknown[], Row>(`
    SELECT h.*, w.org_id AS org_id, w.project_id AS project_id
    FROM session_history h
    JOIN workspaces w ON w.workspace_id = h.workspace_id
    WHERE ${where.join(" AND ")}
    ORDER BY ${order.orderBy}
    LIMIT ?
  `).all(...params, limit)
}

function orderKeyOf(row: SessionPageRow): SessionOrderKey {
  return {
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    ...(row.last_human_turn_at === null ? {} : { lastHumanTurnAt: row.last_human_turn_at }),
    sessionRef: `workspace:${row.workspace_id}:session:${row.session_id}`,
  }
}
