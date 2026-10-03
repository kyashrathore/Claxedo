import { ClaxedoDB, textColumns } from "../../platform/db"
import { isJsonRecord } from "../../platform/runtime/lib/json"
import { sessionOrderSql, type SessionOrderColumns } from "../navigation-order"
import { sessionReaderSql } from "../navigation-reader"
import { LOCAL_SESSION_READER } from "../reader"
import { storedSessionReader } from "../reader-contract"
import { ids } from "./shape"
import { sessionMetaMapByRef } from "./read"
import type { SessionMeta, SessionMetaNavigationListInput } from "./types"

/**
 * One bounded page of a workspace's root sessions, ordered as the rail reads
 * them.
 *
 * Children are excluded in SQL rather than by the caller: this query hands back
 * `limit + 1` rows for the page window, so a child dropped afterwards would take
 * a root's slot, shorten the page and — because the window would then be no
 * longer than the limit — retire the cursor with roots still unread.
 */
const NAVIGATION_COLUMNS: SessionOrderColumns = {
  lastHumanTurnAt: "m.last_human_turn_at",
  createdAt: "m.created_at",
  updatedAt: "m.updated_at",
  sessionRef: "m.session_ref",
}

function navigationQuery(input: SessionMetaNavigationListInput) {
  const where: string[] = ["m.parent_session_id IS NULL"]
  if (input.ownership === "shared") where.push("0 = 1")
  const params: Array<string | number | null> = [input.readerId ?? LOCAL_SESSION_READER]
  if (input.sessionID !== undefined) {
    where.push("m.session_id = ?", "(SELECT COUNT(*) FROM claxedo_session_meta identity WHERE identity.session_id = m.session_id) = 1")
    params.push(input.sessionID)
  }
  const reader = sessionReaderSql({ facts: "m.attention_json", reader: "r.state_json", created: "m.created_at",
    }, input)
  where.push(...reader.where)
  params.push(...reader.params)
  if (input.workspaceIDs !== undefined) {
    where.push(input.workspaceIDs.length ? `m.workspace_id IN (${input.workspaceIDs.map(() => "?").join(",")})` : "0 = 1")
    params.push(...input.workspaceIDs)
  }
  if (input.excludeWorkspaces?.length) {
    where.push(`(m.workspace_id IS NULL OR m.workspace_id NOT IN (${input.excludeWorkspaces.map(() => "?").join(",")}))`)
    params.push(...input.excludeWorkspaces)
  }
  if (input.workspaceID) {
    where.push("m.workspace_id = ?")
    params.push(input.workspaceID)
  }
  if (input.directory) {
    where.push("m.directory = ?")
    params.push(input.directory)
  }
  if (input.projectID) {
    where.push("m.project_id = ?")
    params.push(input.projectID)
  }
  if (input.global) {
    where.push(`(
      m.directory = 'global'
      OR EXISTS (
        SELECT 1 FROM claxedo_session_tag gt
        WHERE gt.session_ref = m.session_ref
        AND gt.tag IN ('global', 'global:default')
      )
    )`)
  }
  if (input.archived === "archived") where.push("m.archived_at IS NOT NULL")
  if (input.archived !== "all" && input.archived !== "archived") where.push("m.archived_at IS NULL")
  if (input.search) {
    where.push("LOWER(COALESCE(m.title, '')) LIKE ?")
    params.push(`%${input.search.toLowerCase()}%`)
  }
  const status = ids(input.status ?? [])
  if (status.length) {
    where.push(`(${status.map(() => statusPredicate()).join(" OR ")})`)
    for (const item of status) {
      params.push(item, item, item, item)
    }
  }
  const order = sessionOrderSql(NAVIGATION_COLUMNS, input.sort ?? "updated_desc", input.cursor)
  if (order.keyset) {
    where.push(order.keyset.sql)
    params.push(...order.keyset.params)
  }

  return { where, params, order }
}

function from() {
  return `FROM claxedo_session_meta m
    LEFT JOIN claxedo_session_reader r ON r.session_ref = m.session_ref AND r.reader_id = ?
    `
}

export async function listSessionNavigationMetas(input: SessionMetaNavigationListInput) {
  const { where, params, order } = navigationQuery(input)
  const rows = ClaxedoDB.raw()
      .prepare(`
        SELECT m.session_ref, r.state_json AS reader_json
        ${from()}
        WHERE ${where.join(" AND ")}
        ORDER BY ${order.orderBy}
        LIMIT ?
      `)
      .all(...params, Math.max(0, input.limit))
      .filter(isJsonRecord)
  const hit = textColumns(rows, "session_ref")
  const meta = await sessionMetaMapByRef(hit)
  for (const row of rows) {
    const item = typeof row.session_ref === "string" ? meta.get(row.session_ref) : undefined
    if (item && typeof row.reader_json === "string") item.reader = storedSessionReader(row.reader_json)
  }
  return hit
    .map((item) => meta.get(item))
    .filter((item): item is SessionMeta => !!item)
}

export function countSessionNavigation(input: SessionMetaNavigationListInput): number {
  const { where, params } = navigationQuery({ ...input, cursor: undefined })
  const row = ClaxedoDB.raw().prepare(`SELECT COUNT(*) AS total ${from()} WHERE ${where.join(" AND ")}`).get(...params)
  if (!isJsonRecord(row) || typeof row.total !== "number") throw new Error("Session inventory total is unavailable")
  return row.total
}

function statusPredicate() {
  return `(
    (? = 'active' AND m.archived_at IS NULL)
    OR (? = 'archived' AND m.archived_at IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM claxedo_session_tag st
      WHERE st.session_ref = m.session_ref
      AND st.tag = ?
    )
    OR EXISTS (
      SELECT 1 FROM claxedo_session_attachment sa
      WHERE sa.session_ref = m.session_ref
      AND sa.kind = ?
    )
  )`
}
