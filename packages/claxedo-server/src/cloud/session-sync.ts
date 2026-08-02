import { ClaxedoDB, eq } from "../platform/db/db"
import { ClaxedoCloudMessageTable } from "../platform/db/cloud-session.sql"
import type { Workspace } from "../workspace/store"

function now() {
  return Date.now()
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function role(input: unknown) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.role) ?? txt(info?.role) ?? null
}

function messageId(input: unknown, session_id: string, ordinal: number) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.id) ?? txt(info?.id) ?? `${session_id}:${ordinal}`
}

function cloud(ws: Workspace) {
  return ws.kind === "cloud"
}

export async function syncCloudMessages(
  ws: Workspace,
  session_id: string,
  messages: unknown[],
  options: { maxEventOrdinal?: number } = {},
) {
  if (!cloud(ws)) return
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

  ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.session_id, session_id)).run()
    for (const row of rows) {
      db.insert(ClaxedoCloudMessageTable).values(row).run()
    }
  })
}
