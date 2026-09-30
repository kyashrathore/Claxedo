import { asRecord } from "@claxedo/helpers/guards"
import { AgentMessagePageError, type TurnRead } from "@claxedo/agent-runtime-contract"
import { isOneOf, jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { latestViewPage, storedTurn, type LatestView } from "@claxedo/server-core/session/latest-view-page"
import { numberColumn, textColumn } from "../../../platform/db"
import type { StoredMessageQuery } from "../../../session/stored-messages"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

const MESSAGE_PAGE_CURSOR_PREFIX = "sawmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

const AUTHOR_KINDS = ["human", "agent"] as const

type MessageRow = {
  ordinal: number
  data: string
  author_actor_id: string | null
  author_kind: (typeof AUTHOR_KINDS)[number] | null
}

/** A session's stored transcript as one read asks for it: a latest view, a page before a cursor, or the whole replay. */
export function readSqliteMessages(
  db: SqliteAuthorityDb,
  value: { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView },
): { messages: unknown[]; nextCursor?: string } {
  if (value.view !== undefined) {
    const end = value.before === undefined ? undefined : decodeCursor(value.sessionId, value.before)
    return readLatestView(db, value.sessionId, value.workspaceId, value.view, end)
  }
  validatePage(value.limit, value.before)
  const before = value.before === undefined ? undefined : decodeCursor(value.sessionId, value.before)
  const query = value.limit === undefined
    ? db.prepare(`
        SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
        FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
        WHERE m.session_id = ? AND m.workspace_id = ? ORDER BY m.ordinal ASC
      `)
    : before === undefined
      ? db.prepare(`
          SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
          FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
          WHERE m.session_id = ? AND m.workspace_id = ? ORDER BY m.ordinal DESC LIMIT ?
        `)
      : db.prepare(`
          SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
          FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
          WHERE m.session_id = ? AND m.workspace_id = ? AND m.ordinal < ? ORDER BY m.ordinal DESC LIMIT ?
        `)
  const rows = (value.limit === undefined
    ? query.all(value.sessionId, value.workspaceId)
    : before === undefined
      ? query.all(value.sessionId, value.workspaceId, value.limit + 1)
      : query.all(value.sessionId, value.workspaceId, before, value.limit + 1)
  ).flatMap((row): MessageRow[] => {
    const item = jsonRecord(row)
    const ordinal = item && numberColumn(item, "ordinal")
    const data = item && textColumn(item, "data")
    if (item === undefined || ordinal === undefined || data === undefined) return []
    return [
      {
        ordinal,
        data,
        author_actor_id: textColumn(item, "author_actor_id") ?? null,
        author_kind: isOneOf(item.author_kind, AUTHOR_KINDS) ? item.author_kind : null,
      },
    ]
  })
  if (value.limit === undefined) return { messages: rows.map(publicMessage) }
  const selected = rows.slice(0, value.limit).reverse()
  return {
    messages: selected.map(publicMessage),
    ...(rows.length > value.limit && selected[0]
      ? { nextCursor: encodeCursor(value.sessionId, selected[0].ordinal) }
      : {}),
  }
}

function publicMessage(row: MessageRow) {
  const value = JSON.parse(row.data) as unknown
  const message = asRecord(value)
  if (!message) return value
  const info = asRecord(message.info) ?? {}
  const claxedo = asRecord(info.claxedo) ?? {}
  const { author: _author, ...safeClaxedo } = claxedo
  const { claxedo: _claxedo, ...safeInfo } = info
  const canonical = row.author_actor_id && (row.author_kind === "human" || row.author_kind === "agent")
    ? { ...safeClaxedo, author: { id: row.author_actor_id, kind: row.author_kind } }
    : safeClaxedo
  return {
    ...message,
    info: {
      ...safeInfo,
      ...(Object.keys(canonical).length ? { claxedo: canonical } : {}),
    },
  }
}

function validatePage(limit: number | undefined, before: string | undefined) {
  if (before !== undefined && limit === undefined) throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT)) {
    throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
}

function readLatestView(db: SqliteAuthorityDb, sessionId: string, workspaceId: string, view: LatestView, end?: number) {
  const endBound = end === undefined ? "" : " AND ordinal < ?"
  const boundary = db.prepare<unknown[], { ordinal: number | null }>(`
    SELECT MAX(ordinal) AS ordinal FROM session_messages WHERE session_id = ? AND workspace_id = ? AND role = 'user'${endBound}
  `).get(...[sessionId, workspaceId, ...(end === undefined ? [] : [end])])?.ordinal
  if (boundary === null || boundary === undefined) return { messages: [] }
  const turn = db.prepare<unknown[], MessageRow>(`
    SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
    FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
    WHERE m.session_id = ? AND m.workspace_id = ? AND m.ordinal >= ?${end === undefined ? "" : " AND m.ordinal < ?"} ORDER BY m.ordinal ASC
  `).all(...[sessionId, workspaceId, boundary, ...(end === undefined ? [] : [end])])
  const older = !!db.prepare(`SELECT 1 FROM session_messages WHERE session_id = ? AND workspace_id = ? AND ordinal < ? LIMIT 1`)
    .get(sessionId, workspaceId, boundary)
  return latestViewPage(
    view,
    turn.map((row) => ({ ordinal: row.ordinal, message: publicMessage(row) })),
    older,
    (ordinal) => encodeCursor(sessionId, ordinal),
  )
}

export function storedQuery(db: SqliteAuthorityDb): StoredMessageQuery {
  return (sql, params) => db.prepare(sql).all(...params)
}

export function sqliteTurnRead(db: SqliteAuthorityDb, sessionId: string, workspaceId: string): TurnRead {
  return (before) => storedTurn(readLatestView(db, sessionId, workspaceId, "latest-turn", before === undefined ? undefined : decodeCursor(sessionId, before)))
}

function encodeCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeCursor(sessionId: string, value: string) {
  try {
    if (!value.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error()
    const parsed = jsonRecord(
      JSON.parse(Buffer.from(value.slice(MESSAGE_PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8")),
    )
    const ordinal = parsed?.ordinal
    if (parsed?.sessionId !== sessionId || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0)
      throw new Error()
    return ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}
