import type { AgentContentPart } from "@claxedo/agent-runtime-contract"
import type { StoredMessageColumn, StoredMessageQuery } from "./stored-messages"

/** The one message row is found by its primary key and `json_each` picks the part inside it, so no other part or message crosses into JavaScript. */
function storedPartSql(column: StoredMessageColumn): string {
  return `
    SELECT p.value AS part
    FROM session_messages m, json_each(m.${column}, '$.parts') AS p
    WHERE m.session_id = ? AND m.workspace_id = ? AND m.message_id = ? AND json_extract(p.value, '$.id') = ?
    LIMIT 1
  `
}

/** One part of one stored message whole, as the runtime synced it; nothing when the session has no such message or the message no such part. */
export async function readStoredPart(
  query: StoredMessageQuery,
  column: StoredMessageColumn,
  at: { sessionId: string; workspaceId: string; messageId: string; partId: string },
): Promise<AgentContentPart | undefined> {
  const [row] = (await query(storedPartSql(column), [at.sessionId, at.workspaceId, at.messageId, at.partId])) as Array<{ part: string }>
  return row ? (JSON.parse(row.part) as AgentContentPart) : undefined
}
