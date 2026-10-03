import { ClaxedoDB, and, eq } from "@claxedo/server-core/platform/db/index"
import { ClaxedoSessionMetaTable } from "@claxedo/server-core/session/meta.sql"
import { ClaxedoSessionReaderTable } from "@claxedo/server-core/session/reader.sql"
import { LOCAL_SESSION_READER } from "@claxedo/server-core/session/reader"
import { storedSessionAttention, storedSessionReader } from "@claxedo/server-core/session/reader-contract"
import type { SessionCleanupTarget } from "@claxedo/agent-runtime-contract"

export function admitLocalSessionCleanup(target: SessionCleanupTarget) {
  ClaxedoDB.transaction((db) => {
    const row = db.select().from(ClaxedoSessionMetaTable).where(and(
      eq(ClaxedoSessionMetaTable.session_id, target.sessionId),
      eq(ClaxedoSessionMetaTable.workspace_id, target.workspaceId),
    )).get()
    if (!row) throw cleanupChanged("Session metadata was removed")
    const facts = storedSessionAttention(row.attention_json)
    if (!facts || facts.generation !== target.generation) throw cleanupChanged("Session generation changed")
    const state = storedSessionReader(db.select().from(ClaxedoSessionReaderTable).where(and(
      eq(ClaxedoSessionReaderTable.session_ref, row.session_ref),
      eq(ClaxedoSessionReaderTable.reader_id, LOCAL_SESSION_READER),
    )).get()?.state_json)
    const revision = state?.generation === facts.generation ? state.revision : 0
    if (revision !== target.readerRevision) throw cleanupChanged("Session reader state changed")
  })
}

function cleanupChanged(message: string) {
  return Object.assign(new Error(message), { code: "session_cleanup_changed", status: 409 })
}
