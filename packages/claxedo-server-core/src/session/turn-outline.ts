import { foldTurnOutline, TURN_OUTLINE_LIMIT, TURN_OUTLINE_SNIPPET_LENGTH, type OutlineTextRow, type OutlineUserRow, type TurnOutline } from "@claxedo/agent-runtime-contract"

import { asRecord, numberField, stringField } from "../platform/json/index"
import type { StoredMessageColumn, StoredMessageQuery } from "./stored-messages"

function flag(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key]
  return value === true ? 1 : value === false ? 0 : (numberField(record, key) ?? null)
}

function textRows(messageId: string, parts: readonly unknown[], snippetLength: number): OutlineTextRow[] {
  return parts.flatMap((part) => {
    const record = asRecord(part)
    if (stringField(record, "type") !== "text") return []
    const text = stringField(record, "text")
    return [{ message_id: messageId, text: text === undefined ? null : text.slice(0, snippetLength), synthetic: flag(record, "synthetic"), ignored: flag(record, "ignored") }]
  })
}

/** The outline of messages already held whole in memory, folded the way the stored read folds its rows. */
export function turnOutlineOfMessages(messages: readonly unknown[], bounds: TurnOutlineBounds = TURN_OUTLINE_BOUNDS): TurnOutline {
  const users = messages.flatMap((message) => {
    const record = asRecord(message)
    const info = asRecord(record?.info)
    const id = stringField(info, "id")
    if (!info || id === undefined || info.role !== "user") return []
    return [{ id, info, parts: Array.isArray(record?.parts) ? record.parts : [] }]
  })
  const window = users.slice(-bounds.limit)
  return foldTurnOutline(
    {
      users: window.map((user) => ({ id: user.id, created_at: numberField(asRecord(user.info.time), "created") ?? null, title: stringField(asRecord(user.info.summary), "title") ?? null })),
      texts: window.flatMap((user) => textRows(user.id, user.parts, bounds.snippetLength)),
      complete: users.length <= bounds.limit,
    },
    bounds.snippetLength,
  )
}

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
  const newest = (await query(newestUsersSql(column), [sessionId, workspaceId, bounds.limit + 1])) as UserRow[]
  const users = newest.slice(0, bounds.limit).reverse()
  const oldest = users[0]
  if (!oldest) return { turns: [], complete: true }
  const texts = (await query(userTextsSql(column), [bounds.snippetLength, sessionId, workspaceId, oldest.ordinal])) as OutlineTextRow[]
  return foldTurnOutline({ users, texts, complete: newest.length <= bounds.limit }, bounds.snippetLength)
}
