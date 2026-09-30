import { AGENT_MESSAGE_PAGE_LIMIT, AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import { asRecord, numberField, parseJson } from "@claxedo/server-core/platform/json/index"
import { latestViewPage, type LatestView } from "@claxedo/server-core/session/latest-view-page"
import type { D1Database } from "@cloudflare/workers-types"
import type { SessionPageQuery } from "@claxedo/server-core/platform/auth/private-session-authority"
import { sessionOrderSql } from "@claxedo/server-core/session/navigation-order"

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
export async function readD1SessionPage(
  database: D1Database,
  query: SessionPageQuery,
  access: { sql: string; params: string[] },
) {
  const where = ["s.deleted_at is null"]
  const params: Array<string | number | null> = []
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
  params.push(...access.params)
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

type MessageRow = {
  ordinal: number
  data_json: string
  author_actor_id: string | null
  author_kind: "human" | "agent" | null
}

const MESSAGE_PAGE_CURSOR_PREFIX = "d1sm1:"

type MessageReadInput = { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView }

export function validateD1MessageRead(args: MessageReadInput) {
  if (args.view === undefined) {
    if (args.before !== undefined && args.limit === undefined) {
      throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
    }
    if (
      args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > AGENT_MESSAGE_PAGE_LIMIT)
    ) {
      throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}`)
    }
  }
  return args.before === undefined ? undefined : decodeMessagePageCursor(args.sessionId, args.before)
}

export async function readD1MessagePage(database: D1Database, args: MessageReadInput, beforeOrdinal?: number) {
  const { sessionId, workspaceId } = args
  if (args.view !== undefined) return readD1LatestView(database, sessionId, workspaceId, args.view, beforeOrdinal)
  const limit = args.limit
  const query = database.prepare(`
    select m.ordinal, m.data_json, m.author_actor_id, a.kind as author_kind
    from session_messages m
    left join actors a on a.actor_id = m.author_actor_id and a.state = 'active'
    where m.session_id = ? and m.workspace_id = ? and (? is null or m.ordinal < ?)
    order by m.ordinal ${limit === undefined ? "asc" : "desc"}
    ${limit === undefined ? "" : "limit ?"}
  `)
  const result =
    limit === undefined
      ? await query.bind(sessionId, workspaceId, beforeOrdinal ?? null, beforeOrdinal ?? null).all<MessageRow>()
      : await query
          .bind(sessionId, workspaceId, beforeOrdinal ?? null, beforeOrdinal ?? null, limit + 1)
          .all<MessageRow>()
  const rows = limit === undefined ? result.results : result.results.slice(0, limit).reverse()
  const hasMore = limit !== undefined && result.results.length > limit
  return {
    messages: rows.map(publicMessage),
    ...(hasMore && rows[0] ? { nextCursor: encodeMessagePageCursor(sessionId, rows[0].ordinal) } : {}),
  }
}

export async function readD1LatestView(database: D1Database, sessionId: string, workspaceId: string, view: LatestView, end?: number) {
  const endBound = end === undefined ? [] : [end]
  const boundary = await database
    .prepare(`select max(ordinal) as ordinal from session_messages where session_id = ? and workspace_id = ? and role = 'user'${end === undefined ? "" : " and ordinal < ?"}`)
    .bind(sessionId, workspaceId, ...endBound)
    .first<{ ordinal: number | null }>()
  if (boundary?.ordinal === null || boundary?.ordinal === undefined) return { messages: [] }
  const [turn, older] = await Promise.all([
    database.prepare(`
      select m.ordinal, m.data_json, m.author_actor_id, a.kind as author_kind
      from session_messages m
      left join actors a on a.actor_id = m.author_actor_id and a.state = 'active'
      where m.session_id = ? and m.workspace_id = ? and m.ordinal >= ?${end === undefined ? "" : " and m.ordinal < ?"}
      order by m.ordinal asc
    `).bind(sessionId, workspaceId, boundary.ordinal, ...endBound).all<MessageRow>(),
    database
      .prepare(`select 1 as found from session_messages where session_id = ? and workspace_id = ? and ordinal < ? limit 1`)
      .bind(sessionId, workspaceId, boundary.ordinal)
      .first<{ found: number }>(),
  ])
  return latestViewPage(
    view,
    turn.results.map((row) => ({ ordinal: row.ordinal, message: publicMessage(row) })),
    !!older,
    (ordinal) => encodeMessagePageCursor(sessionId, ordinal),
  )
}

function publicMessage(row: MessageRow) {
  const parsed = parseJson(row.data_json)
  const message = asRecord(parsed)
  if (!message) return parsed
  const info = asRecord(message.info) ?? {}
  const claxedo = asRecord(info.claxedo) ?? {}
  const { author: _untrustedAuthor, ...safeClaxedo } = claxedo
  const { claxedo: _untrustedClaxedo, ...safeInfo } = info
  const canonicalClaxedo =
    row.author_actor_id && row.author_kind && (message.role === "user" || info.role === "user")
      ? { ...safeClaxedo, author: { id: row.author_actor_id, kind: row.author_kind } }
      : safeClaxedo
  return {
    ...message,
    info: {
      ...safeInfo,
      ...(Object.keys(canonicalClaxedo).length > 0 ? { claxedo: canonicalClaxedo } : {}),
    },
  }
}

function encodeMessagePageCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({ sessionId, ordinal }))}`
}

export function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const value = asRecord(parseJson(decodeURIComponent(input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length))))
    const ordinal = numberField(value, "ordinal")
    if (value?.sessionId !== sessionId || ordinal === undefined || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error("invalid cursor payload")
    }
    return ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

