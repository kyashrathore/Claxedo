import { foldTurnOutline, TURN_OUTLINE_LIMIT, TURN_OUTLINE_SNIPPET_LENGTH, type OutlineTextRow, type OutlineUserRow, type TurnOutline } from "@claxedo/agent-runtime-contract"

import type { StoredMessageColumn, StoredMessageQuery } from "./stored-messages"

type UserRow = OutlineUserRow & { ordinal: number }

type TurnOutlineBounds = { limit: number; snippetLength: number }

const TURN_OUTLINE_BOUNDS: TurnOutlineBounds = { limit: TURN_OUTLINE_LIMIT, snippetLength: TURN_OUTLINE_SNIPPET_LENGTH }

function newestUsersSql(column: StoredMessageColumn): string {
  return `
    SELECT message_id AS id, ordinal,
      json_extract(${column}, '$.info.time.created') AS created_at,
      json_extract(${column}, '$.info.summary.title') AS title
    FROM session_messages
    WHERE session_id = ? AND workspace_id = ? AND role = 'user'
    ORDER BY ordinal DESC
    LIMIT ?
  `
}

/** The parts live inside the message's JSON, so `json_each` walks them, for user messages only; the text is cut in SQL so a part's payload never crosses into JavaScript whole. */
function userTextsSql(column: StoredMessageColumn): string {
  return `
    SELECT m.message_id,
      substr(json_extract(p.value, '$.text'), 1, ?) AS text,
      json_extract(p.value, '$.synthetic') AS synthetic,
      json_extract(p.value, '$.ignored') AS ignored
    FROM session_messages m, json_each(m.${column}, '$.parts') AS p
    WHERE m.session_id = ? AND m.workspace_id = ? AND m.role = 'user' AND m.ordinal >= ? AND json_extract(p.value, '$.type') = 'text'
    ORDER BY m.ordinal ASC, p.key ASC
  `
}

/** The outline of a stored session's newest `limit` turns, read from the control plane's `session_messages` rows whose `role` column is `user`. */
export async function readStoredTurnOutline(
  query: StoredMessageQuery,
  column: StoredMessageColumn,
  sessionId: string,
  workspaceId: string,
  bounds: TurnOutlineBounds = TURN_OUTLINE_BOUNDS,
): Promise<TurnOutline> {
  const newest = await query<UserRow>(newestUsersSql(column), [sessionId, workspaceId, bounds.limit + 1])
  const users = newest.slice(0, bounds.limit).reverse()
  const oldest = users[0]
  if (!oldest) return { turns: [], complete: true }
  const texts = await query<OutlineTextRow>(userTextsSql(column), [bounds.snippetLength, sessionId, workspaceId, oldest.ordinal])
  return foldTurnOutline({ users, texts, complete: newest.length <= bounds.limit }, bounds.snippetLength)
}
