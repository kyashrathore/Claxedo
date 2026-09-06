import { ClaxedoDB, desc, eq } from "../platform/db"
import { ClaxedoCloudMessageEventTable, ClaxedoCloudMessageTable } from "./cloud.sql"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { asRecord, asString } from "@claxedo/helpers/guards"

function now() {
  return Date.now()
}

function role(input: unknown) {
  const row = asRecord(input)
  const info = asRecord(row?.info)
  return asString(row?.role) ?? asString(info?.role) ?? null
}

function messageId(input: unknown, session_id: string, ordinal: number) {
  const row = asRecord(input)
  const info = asRecord(row?.info)
  return asString(row?.id) ?? asString(info?.id) ?? `${session_id}:${ordinal}`
}

function cloud(ws: Workspace) {
  return ws.kind === "cloud"
}

/** Whether the cloud messages were written. A non-cloud workspace stores nothing. */
export async function syncCloudMessages(
  ws: Workspace,
  session_id: string,
  messages: unknown[],
  options: { maxEventOrdinal?: number } = {},
): Promise<boolean> {
  if (!cloud(ws)) return false
  const stamp = now()
  const rows = messages.map((item, ordinal) => ({
    message_id: messageId(item, session_id, ordinal),
    session_id,
    workspace_id: ws.id,
    role: role(item),
    ordinal,
    event_ordinal: options.maxEventOrdinal ?? 0,
    data: JSON.stringify(item),
    created_at: stamp,
    updated_at: stamp,
  }))

  return ClaxedoDB.transaction((db) => {
    if (options.maxEventOrdinal !== undefined) {
      const lastMessage = db
        .select({ event_ordinal: ClaxedoCloudMessageTable.event_ordinal })
        .from(ClaxedoCloudMessageTable)
        .where(eq(ClaxedoCloudMessageTable.session_id, session_id))
        .orderBy(desc(ClaxedoCloudMessageTable.event_ordinal))
        .get()
      const lastEvent = db
        .select({ event_ordinal: ClaxedoCloudMessageEventTable.event_ordinal })
        .from(ClaxedoCloudMessageEventTable)
        .where(eq(ClaxedoCloudMessageEventTable.session_id, session_id))
        .orderBy(desc(ClaxedoCloudMessageEventTable.event_ordinal))
        .get()
      const storedOrdinal = Math.max(lastMessage?.event_ordinal ?? 0, lastEvent?.event_ordinal ?? 0)
      if (options.maxEventOrdinal < storedOrdinal) return false
      if (options.maxEventOrdinal === storedOrdinal) {
        const storedMessages = db
          .select({ message_id: ClaxedoCloudMessageTable.message_id })
          .from(ClaxedoCloudMessageTable)
          .where(eq(ClaxedoCloudMessageTable.session_id, session_id))
          .all()
        if (storedMessages.length > 0 && messages.length <= storedMessages.length) return false
      }
    }
    db.delete(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.session_id, session_id)).run()
    for (const row of rows) {
      db.insert(ClaxedoCloudMessageTable).values(row).run()
    }
    return true
  })
}
