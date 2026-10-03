import { updateSessionReader, type SessionReaderCommand } from "@claxedo/agent-runtime-contract"
import { ClaxedoDB, and, eq } from "../platform/db"
import { ClaxedoError } from "../platform/errors/base"
import { ClaxedoSessionMetaTable } from "./meta.sql"
import { ClaxedoSessionReaderTable } from "./reader.sql"
import { storedSessionAttention, storedSessionReader } from "./reader-contract"

export const LOCAL_SESSION_READER = "local-owner"

export function readSessionReader(sessionRef: string, readerId: string) {
  return ClaxedoDB.use((db) => storedSessionReader(db.select().from(ClaxedoSessionReaderTable).where(and(
    eq(ClaxedoSessionReaderTable.session_ref, sessionRef),
    eq(ClaxedoSessionReaderTable.reader_id, readerId),
  )).get()?.state_json))
}

export function writeSessionReader(input: {
  sessionRef: string
  readerId: string
  command: SessionReaderCommand
  now: number
}) {
  return ClaxedoDB.transaction((db) => {
    const meta = db.select({ attention_json: ClaxedoSessionMetaTable.attention_json }).from(ClaxedoSessionMetaTable)
      .where(eq(ClaxedoSessionMetaTable.session_ref, input.sessionRef)).get()
    if (!meta) throw new ClaxedoError({ code: "session_not_found", message: "Session not found", status: 404 })
    const facts = storedSessionAttention(meta.attention_json)
    if (!facts) throw new ClaxedoError({ code: "session_attention_unavailable", message: "Session activity is unavailable", status: 503 })
    const row = db.select().from(ClaxedoSessionReaderTable).where(and(
      eq(ClaxedoSessionReaderTable.session_ref, input.sessionRef),
      eq(ClaxedoSessionReaderTable.reader_id, input.readerId),
    )).get()
    const result = updateSessionReader(facts, storedSessionReader(row?.state_json), input.command, input.now)
    if (!result.ok) return result
    const state_json = JSON.stringify(result.state)
    db.insert(ClaxedoSessionReaderTable).values({ session_ref: input.sessionRef, reader_id: input.readerId, state_json })
      .onConflictDoUpdate({ target: [ClaxedoSessionReaderTable.session_ref, ClaxedoSessionReaderTable.reader_id], set: { state_json } }).run()
    return result
  })
}
