/**
 * Message Replay
 *
 * Persists message events (message.updated, message.part.updated) to claxedo DB
 * as they stream from the runner. Provides readSessionMessages() for replay.
 *
 * Messages are written per-event during streaming and read from claxedo DB
 * on GET /session/:id/message, not from the adapter.
 */

import { ClaxedoDB, and, desc, eq, gt } from "../platform/db"
import { ClaxedoCloudMessageEventTable, ClaxedoCloudMessageTable, ClaxedoCloudSessionTable } from "./cloud.sql"
import { ClaxedoSessionMetaTable } from "@claxedo/server-core/session/meta.sql"
import { asRecord, asString, isRecord } from "@claxedo/helpers/guards"

function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}

export type ReplayMessage = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

function staleToolError(message?: string) {
  if (message?.includes("ACP process restarted")) return "Tool execution interrupted by ACP restart"
  return "Tool execution interrupted"
}

function terminalizedPart(part: Record<string, unknown>, ts: number, message?: string) {
  if (part.type !== "tool") return part
  const state = asRecord(part.state)
  const status = asString(state?.status)
  if (status !== "pending" && status !== "running") return part
  const time = asRecord(state?.time)
  return {
    ...part,
    state: {
      ...state,
      status: "error",
      error: staleToolError(message),
      time: {
        start: num(time?.start) ?? ts,
        end: ts,
      },
    },
  }
}

export function terminalizeReplayMessages(
  messages: ReplayMessage[],
  options: { interrupted?: boolean; message?: string } = {},
) {
  return messages.map((message) => {
    const time = asRecord(message.info.time)
    const err = asRecord(message.info.error)
    const data = asRecord(err?.data)
    const errorMessage = options.message ?? asString(data?.message) ?? asString(err?.message)
    const terminal =
      options.interrupted ||
      (message.info.role === "assistant" && (typeof time?.completed === "number" || !!message.info.error))
    const ts = num(time?.completed) ?? num(time?.created) ?? Date.now()
    return {
      info: message.info,
      parts: terminal ? message.parts.map((part) => terminalizedPart(part, ts, errorMessage)) : message.parts,
    }
  })
}

export type PersistedEvent = {
  event_ordinal: number
  type: string
  directory?: string
  properties?: Record<string, unknown>
}

/**
 * Persist a streaming event to the message replay table.
 * Call this from publishGlobal for every compat event during streaming.
 * Only message.updated, message.part.updated, and message.part.delta are handled.
 */
export function persistMessageEvent(
  sessionId: string,
  event: { type: string; properties?: unknown },
  directory?: string,
) {
  if (event.type === "message.updated") {
    const props = asRecord(event.properties)
    const info = asRecord(props?.info)
    if (!info) return
    const messageId = asString(info.id)
    if (!messageId) return
    const existing = loadMessage(sessionId, messageId)
    if (existing === FOREIGN) return

    const now = Date.now()

    ClaxedoDB.transaction((db) => {
      const ordinal = messageOrdinal(db, sessionId, messageId)
      const event_ordinal = nextEventOrdinal(db, sessionId)
      const workspace_id = workspaceIdForSession(db, sessionId)
      appendEvent(db, sessionId, directory, event_ordinal, now, event)
      db.insert(ClaxedoCloudMessageTable)
        .values({
          message_id: messageId,
          session_id: sessionId,
          workspace_id,
          role: asString(info.role) ?? null,
          ordinal,
          event_ordinal,
          data: JSON.stringify({ info, parts: [] }),
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: ClaxedoCloudMessageTable.message_id,
          set: {
            workspace_id,
            role: asString(info.role) ?? null,
            data: JSON.stringify({ info, parts: existing ? readStoredMessage(existing.data).parts : [] }),
            event_ordinal,
            updated_at: now,
          },
        })
        .run()
    })
    return
  }

  if (event.type === "message.part.updated") {
    const props = asRecord(event.properties)
    const part = asRecord(props?.part)
    if (!part) return
    const messageId = asString(part.messageID)
    if (!messageId) return

    const now = Date.now()
    const existing = loadMessage(sessionId, messageId)
    if (existing === FOREIGN) return
    const parsed = existing
      ? readStoredMessage(existing.data)
      : { info: { id: messageId, sessionID: asString(part.sessionID) ?? sessionId }, parts: [] }
    const parts = parsed.parts.slice()
    const index = parts.findIndex((item) => asString(asRecord(item)?.id) === asString(part.id))
    if (index >= 0) parts[index] = part
    else parts.push(part)

    writeMessage({
      messageId,
      sessionId,
      role: asString(asRecord(parsed.info)?.role) ?? null,
      info: parsed.info,
      parts,
      now,
      event,
      directory,
    })
    return
  }

  if (event.type === "message.part.delta") {
    const props = asRecord(event.properties)
    const messageId = asString(props?.messageID)
    const partId = asString(props?.partID)
    const field = asString(props?.field)
    const delta = asString(props?.delta)
    if (!messageId || !partId || !field || delta === undefined) return

    const now = Date.now()
    const existing = loadMessage(sessionId, messageId)
    if (existing === FOREIGN) return
    const parsed = existing
      ? readStoredMessage(existing.data)
      : { info: { id: messageId, sessionID: asString(props?.sessionID) ?? sessionId }, parts: [] }
    const parts = parsed.parts.slice()
    const idx = parts.findIndex((item) => asString(asRecord(item)?.id) === partId)
    const prev =
      idx >= 0 && asRecord(parts[idx])
        ? asRecord(parts[idx])!
        : {
            id: partId,
            sessionID: asString(props?.sessionID) ?? sessionId,
            messageID: messageId,
            type: "text",
            text: "",
          }
    const next = {
      ...prev,
      [field]: `${asString(prev[field]) ?? ""}${delta}`,
    }
    if (idx >= 0) parts[idx] = next
    if (idx < 0) parts.push(next)

    writeMessage({
      messageId,
      sessionId,
      role: asString(asRecord(parsed.info)?.role) ?? null,
      info: parsed.info,
      parts,
      now,
      event,
      directory,
    })
    return
  }
}

/**
 * Read all messages for a session from claxedo DB, ordered by insertion order.
 */
export function readSessionMessages(sessionId: string): ReplayMessage[] {
  const rows = ClaxedoDB.use((db) =>
    db
      .select({ data: ClaxedoCloudMessageTable.data })
      .from(ClaxedoCloudMessageTable)
      .where(eq(ClaxedoCloudMessageTable.session_id, sessionId))
      .orderBy(ClaxedoCloudMessageTable.ordinal)
      .all(),
  )
  return hydrateReplayMessages(rows)
}

/**
 * Read persisted SSE-compatible events after a session-local event ordinal.
 */
export function readSessionEventsAfter(sessionId: string, afterOrdinal: number): PersistedEvent[] {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoCloudMessageEventTable)
      .where(
        and(
          eq(ClaxedoCloudMessageEventTable.session_id, sessionId),
          gt(ClaxedoCloudMessageEventTable.event_ordinal, afterOrdinal),
        ),
      )
      .orderBy(ClaxedoCloudMessageEventTable.event_ordinal)
      .all(),
  ).map((row) => {
    const parsed = asRecord(JSON.parse(row.data))
    const properties = asRecord(parsed?.properties)
    return {
      event_ordinal: row.event_ordinal,
      type: asString(parsed?.type) ?? row.type,
      ...(row.directory ? { directory: row.directory } : {}),
      ...(properties ? { properties } : {}),
    }
  })
}

export function readSessionMaxEventOrdinal(sessionId: string): number {
  return ClaxedoDB.use((db) => maxStoredEventOrdinal(db, sessionId))
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function hydrateReplayMessages(rows: Array<{ data: string }>): ReplayMessage[] {
  return terminalizeReplayMessages(rows.map((row) => readStoredMessage(row.data)))
}

const FOREIGN = Symbol("foreign message")

/**
 * The session's own row for a message id. Message ids are the table's primary
 * key across every session, so a row another session holds is `FOREIGN`: an
 * event naming it is dropped instead of overwriting that session's message.
 */
function loadMessage(sessionId: string, messageId: string) {
  const row = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.message_id, messageId)).get(),
  )
  return row && row.session_id !== sessionId ? FOREIGN : row
}

/**
 * A persisted cloud-message envelope.
 *
 * `writeMessage` is the only writer, so a well-formed row round-trips exactly;
 * a corrupt or foreign blob reads as an empty message rather than throwing
 * inside a replay that has nothing to do with it.
 */
function readStoredMessage(data: string): { info: Record<string, unknown>; parts: Record<string, unknown>[] } {
  // `JSON.parse` still throws on a corrupt blob: a row this reader was asked
  // for and cannot read is a data error, and message-replay.test.ts uses
  // exactly that to prove the bounded page reader never touches rows outside
  // its selection.
  const row = asRecord(JSON.parse(data))
  const parts = row?.parts
  return {
    info: asRecord(row?.info) ?? {},
    parts: Array.isArray(parts) ? parts.filter(isRecord) : [],
  }
}

function writeMessage(input: {
  messageId: string
  sessionId: string
  role: string | null
  info: unknown
  parts: unknown[]
  now: number
  event: { type: string; properties?: unknown }
  directory?: string
}) {
  ClaxedoDB.transaction((db) => {
    const ordinal = messageOrdinal(db, input.sessionId, input.messageId)
    const event_ordinal = nextEventOrdinal(db, input.sessionId)
    const workspace_id = workspaceIdForSession(db, input.sessionId)
    appendEvent(db, input.sessionId, input.directory, event_ordinal, input.now, input.event)
    db.insert(ClaxedoCloudMessageTable)
      .values({
        message_id: input.messageId,
        session_id: input.sessionId,
        workspace_id,
        role: input.role,
        ordinal,
        event_ordinal,
        data: JSON.stringify({ info: input.info, parts: input.parts }),
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoUpdate({
        target: ClaxedoCloudMessageTable.message_id,
        set: {
          workspace_id,
          data: JSON.stringify({ info: input.info, parts: input.parts }),
          event_ordinal,
          updated_at: input.now,
        },
      })
      .run()
  })
}

function workspaceIdForSession(db: ClaxedoDB.Client, sessionId: string): string {
  const cloud = db
    .select({ workspace_id: ClaxedoCloudSessionTable.workspace_id })
    .from(ClaxedoCloudSessionTable)
    .where(eq(ClaxedoCloudSessionTable.session_id, sessionId))
    .get()
  if (cloud?.workspace_id) return cloud.workspace_id

  const local = db
    .select({ workspace_id: ClaxedoSessionMetaTable.workspace_id })
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.session_id, sessionId))
    .get()
  return local?.workspace_id ?? sessionId
}

function messageOrdinal(db: ClaxedoDB.Client, sessionId: string, messageId: string): number {
  // If message already exists, keep its ordinal
  const existing = db
    .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
    .from(ClaxedoCloudMessageTable)
    .where(eq(ClaxedoCloudMessageTable.message_id, messageId))
    .get()
  if (existing) return existing.ordinal

  // Otherwise, next ordinal for this session
  const last = db
    .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
    .from(ClaxedoCloudMessageTable)
    .where(eq(ClaxedoCloudMessageTable.session_id, sessionId))
    .orderBy(desc(ClaxedoCloudMessageTable.ordinal))
    .get()
  return last ? last.ordinal + 1 : 0
}

function appendEvent(
  db: ClaxedoDB.Client,
  sessionId: string,
  directory: string | undefined,
  event_ordinal: number,
  now: number,
  event: { type: string; properties?: unknown },
) {
  db.insert(ClaxedoCloudMessageEventTable)
    .values({
      id: `${sessionId}:${event_ordinal}`,
      session_id: sessionId,
      directory: directory ?? null,
      event_ordinal,
      type: event.type,
      data: JSON.stringify(event),
      created_at: now,
    })
    .run()
}

function nextEventOrdinal(db: ClaxedoDB.Client, sessionId: string) {
  return maxStoredEventOrdinal(db, sessionId) + 1
}

function maxStoredEventOrdinal(db: ClaxedoDB.Client, sessionId: string) {
  const lastEvent = db
    .select({ event_ordinal: ClaxedoCloudMessageEventTable.event_ordinal })
    .from(ClaxedoCloudMessageEventTable)
    .where(eq(ClaxedoCloudMessageEventTable.session_id, sessionId))
    .orderBy(desc(ClaxedoCloudMessageEventTable.event_ordinal))
    .get()
  const lastMessage = db
    .select({ event_ordinal: ClaxedoCloudMessageTable.event_ordinal })
    .from(ClaxedoCloudMessageTable)
    .where(eq(ClaxedoCloudMessageTable.session_id, sessionId))
    .orderBy(desc(ClaxedoCloudMessageTable.event_ordinal))
    .get()
  return Math.max(lastEvent?.event_ordinal ?? 0, lastMessage?.event_ordinal ?? 0)
}
