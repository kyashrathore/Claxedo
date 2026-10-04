import { foldTurnOutline, TURN_OUTLINE_LIMIT, TURN_OUTLINE_SNIPPET_LENGTH, type OutlineTextRow, type OutlineUserRow, type TurnOutline } from "@claxedo/agent-runtime-contract"

export type TurnOutlineDatabase = {
  prepare<Row>(sql: string): { all(...params: unknown[]): Row[] }
}

type UserRow = OutlineUserRow & { ord: number }

type OutlineBounds = { limit: number; snippetLength: number }

const USERS_SQL = `
  SELECT id, ord, json_extract(info_json, '$.time.created') AS created_at, json_extract(info_json, '$.summary.title') AS title
  FROM message
  WHERE session_id = ? AND role = 'user'
  ORDER BY ord DESC
  LIMIT ?
`

const TEXTS_SQL = `
  SELECT
    p.message_id,
    substr(json_extract(p.data_json, '$.text'), 1, ?) AS text,
    json_extract(p.data_json, '$.synthetic') AS synthetic,
    json_extract(p.data_json, '$.ignored') AS ignored
  FROM message m
  INNER JOIN part p ON p.session_id = m.session_id AND p.message_id = m.id
  WHERE m.session_id = ? AND m.role = 'user' AND m.ord >= ? AND json_extract(p.data_json, '$.type') = 'text'
  ORDER BY m.ord ASC, p.ord ASC
`

/** The store's statements are single-use: under `bun:sqlite` it finalizes each one after its first call, so each read prepares its own. */
export function readTurnOutline(
  db: TurnOutlineDatabase,
  sessionId: string,
  bounds: OutlineBounds = { limit: TURN_OUTLINE_LIMIT, snippetLength: TURN_OUTLINE_SNIPPET_LENGTH },
): TurnOutline {
  const newest = db.prepare<UserRow>(USERS_SQL).all(sessionId, bounds.limit + 1)
  const users = newest.slice(0, bounds.limit).reverse()
  const oldest = users[0]
  if (!oldest) return { turns: [], complete: true }
  const texts = db.prepare<OutlineTextRow>(TEXTS_SQL).all(bounds.snippetLength, sessionId, oldest.ord)
  return foldTurnOutline({ users, texts, complete: newest.length <= bounds.limit }, bounds.snippetLength)
}
