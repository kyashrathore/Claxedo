import { sql } from "drizzle-orm"
import { ClaxedoDB, and, eq, queryRow, queryRows } from "../platform/db"
import type { AccountSessionAttentionEvent, AccountSessionAttentionPage } from "../platform/auth/session-attention-authority"
import type { SessionAttentionPublication } from "../platform/auth/host-session-rows"
import { ClaxedoError } from "../platform/errors/base"
import { ClaxedoSessionMetaTable } from "./meta.sql"
import { ClaxedoSessionAttentionScanTable, ClaxedoSessionAttentionTable } from "./attention-ledger.sql"
import { storedSessionAttention } from "./reader-contract"
import { sessionAttentionEventSchema, sessionAttentionPublicationSchema } from "./session-publication"

export function localSessionAttentionPosition(sessionRef: string, generation: number): number {
  return ClaxedoDB.use((db) => db.select({ through: ClaxedoSessionAttentionScanTable.through })
    .from(ClaxedoSessionAttentionScanTable).where(and(
      eq(ClaxedoSessionAttentionScanTable.session_ref, sessionRef),
      eq(ClaxedoSessionAttentionScanTable.generation, generation),
    )).get()?.through ?? 0)
}

export function appendLocalSessionAttention(sessionRef: string, input: SessionAttentionPublication): AccountSessionAttentionEvent[] {
  const batch = sessionAttentionPublicationSchema.parse(input)
  return ClaxedoDB.transaction((db) => {
    const meta = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_ref, sessionRef)).get()
    if (!meta || meta.parent_session_id || meta.workspace_id !== batch.workspaceId || meta.session_id !== batch.sessionId || !meta.project_id) {
      throw new ClaxedoError({ code: "session_not_found", message: "Root session not found", status: 404 })
    }
    const facts = storedSessionAttention(meta.attention_json)
    if (!facts || facts.generation !== batch.generation || batch.through > facts.sequence) {
      throw new ClaxedoError({ code: "session_attention_changed", message: "Session activity changed during history read", status: 409 })
    }
    const events: AccountSessionAttentionEvent[] = []
    for (const event of batch.events) {
      const event_json = JSON.stringify(event)
      const existing = db.select({ event_json: ClaxedoSessionAttentionTable.event_json }).from(ClaxedoSessionAttentionTable).where(and(
        eq(ClaxedoSessionAttentionTable.session_ref, sessionRef), eq(ClaxedoSessionAttentionTable.generation, batch.generation),
        eq(ClaxedoSessionAttentionTable.sequence, event.sequence),
      )).get()
      if (existing) {
        if (existing.event_json !== event_json) throw new Error("Canonical session attention event changed at a persisted position")
        continue
      }
      const inserted = db.insert(ClaxedoSessionAttentionTable).values({
        session_ref: sessionRef, generation: batch.generation, sequence: event.sequence, event_json,
      }).onConflictDoNothing().returning({ ordinal: ClaxedoSessionAttentionTable.ordinal }).get()
      if (inserted) events.push({ cursor: inserted.ordinal, sessionId: meta.session_id, workspaceId: meta.workspace_id,
        projectId: meta.project_id, ...(meta.title ? { title: meta.title } : {}), generation: batch.generation, event })
    }
    db.insert(ClaxedoSessionAttentionScanTable).values({ session_ref: sessionRef, generation: batch.generation, through: batch.through })
      .onConflictDoUpdate({ target: [ClaxedoSessionAttentionScanTable.session_ref, ClaxedoSessionAttentionScanTable.generation],
        set: { through: sql`max(${ClaxedoSessionAttentionScanTable.through}, ${batch.through})` } }).run()
    return events
  })
}

export function listLocalSessionAttention(input: { after: number; limit: number }): AccountSessionAttentionPage {
  if (!Number.isSafeInteger(input.after) || input.after < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
    throw new ClaxedoError({ code: "invalid_session_attention_page", message: "Invalid attention page position or limit", status: 400 })
  }
  const sqlite = ClaxedoDB.raw()
  const through = Number(queryRow(sqlite, "SELECT seq FROM sqlite_sequence WHERE name = 'claxedo_session_attention'")?.seq ?? 0)
  const rows = queryRows(sqlite, `SELECT a.ordinal, a.generation, a.event_json, m.session_id, m.workspace_id, m.project_id, m.title
    FROM claxedo_session_attention a JOIN claxedo_session_meta m ON m.session_ref = a.session_ref
    WHERE a.ordinal > ? AND a.ordinal <= ? AND m.parent_session_id IS NULL
      AND m.workspace_id IS NOT NULL AND m.project_id IS NOT NULL
      AND json_extract(m.attention_json, '$.generation') = a.generation
    ORDER BY a.ordinal ASC LIMIT ?`, input.after, through, input.limit + 1)
  const hasMore = rows.length > input.limit
  const events = rows.slice(0, input.limit).map(accountEvent)
  return { events, through, ...(hasMore ? { next: events[events.length - 1].cursor } : {}) }
}

function accountEvent(row: Record<string, unknown>): AccountSessionAttentionEvent {
  if (typeof row.ordinal !== "number" || typeof row.generation !== "number" || !Number.isSafeInteger(row.ordinal) || !Number.isSafeInteger(row.generation) || typeof row.event_json !== "string"
    || typeof row.session_id !== "string" || typeof row.workspace_id !== "string" || typeof row.project_id !== "string") {
    throw new Error("Invalid persisted session attention event")
  }
  return { cursor: row.ordinal, generation: row.generation,
    sessionId: row.session_id, workspaceId: row.workspace_id, projectId: row.project_id,
    ...(typeof row.title === "string" ? { title: row.title } : {}), event: sessionAttentionEventSchema.parse(JSON.parse(row.event_json)) }
}

export function deleteLocalSessionAttention(db: ClaxedoDB.Client, sessionRef: string) {
  db.delete(ClaxedoSessionAttentionTable).where(eq(ClaxedoSessionAttentionTable.session_ref, sessionRef)).run()
  db.delete(ClaxedoSessionAttentionScanTable).where(eq(ClaxedoSessionAttentionScanTable.session_ref, sessionRef)).run()
}

export function rekeyLocalSessionAttention(db: ClaxedoDB.Client, fromRef: string, toRef: string) {
  if (fromRef === toRef) return
  for (const event of db.select().from(ClaxedoSessionAttentionTable).where(eq(ClaxedoSessionAttentionTable.session_ref, fromRef)).all()) {
    const duplicate = db.select({ ordinal: ClaxedoSessionAttentionTable.ordinal, event_json: ClaxedoSessionAttentionTable.event_json }).from(ClaxedoSessionAttentionTable).where(and(
      eq(ClaxedoSessionAttentionTable.session_ref, toRef), eq(ClaxedoSessionAttentionTable.generation, event.generation),
      eq(ClaxedoSessionAttentionTable.sequence, event.sequence),
    )).get()
    if (duplicate && duplicate.event_json !== event.event_json) throw new Error("Canonical session attention conflicts during ref change")
    if (!duplicate) db.update(ClaxedoSessionAttentionTable).set({ session_ref: toRef })
      .where(eq(ClaxedoSessionAttentionTable.ordinal, event.ordinal)).run()
  }
  for (const position of db.select().from(ClaxedoSessionAttentionScanTable).where(eq(ClaxedoSessionAttentionScanTable.session_ref, fromRef)).all()) {
    db.insert(ClaxedoSessionAttentionScanTable).values({ ...position, session_ref: toRef })
      .onConflictDoUpdate({ target: [ClaxedoSessionAttentionScanTable.session_ref, ClaxedoSessionAttentionScanTable.generation],
        set: { through: sql`max(${ClaxedoSessionAttentionScanTable.through}, ${position.through})` } }).run()
  }
  deleteLocalSessionAttention(db, fromRef)
}
