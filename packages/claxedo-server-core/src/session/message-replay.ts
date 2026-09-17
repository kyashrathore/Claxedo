/**
 * Message Replay
 *
 * Persists message events (message.updated, message.part.updated) to claxedo DB
 * as they stream from the runner. Provides readSessionMessages() for replay.
 *
 * Messages are written per-event during streaming and read from claxedo DB
 * on GET /session/:id/message, not from the adapter.
 */

import { readRecordedPart } from "@claxedo/agent-sdk-runtime/compat-events"
import { AgentMessagePageError, projectLatestSurfaceMessages, type AgentMessagePageInput } from "@claxedo/agent-sdk-runtime/message-page"
import { lt, or, sql } from "drizzle-orm"
import { ClaxedoDB, and, desc, eq, gt, numberColumn, textColumn } from "../platform/db"
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

export type SessionMessagePage = {
  messages: ReplayMessage[]
  nextCursor?: string
}

const MESSAGE_PAGE_CURSOR_PREFIX = "cspm1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

function encodeMessagePageCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const encoded = input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length)
    if (!encoded) throw new Error("missing cursor payload")
    const decoded = asRecord(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
    if (
      decoded?.sessionId !== sessionId ||
      typeof decoded.ordinal !== "number" ||
      !Number.isSafeInteger(decoded.ordinal) ||
      decoded.ordinal < 0
    )
      throw new Error("invalid cursor payload")
    return decoded.ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
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
            data: JSON.stringify({ info, parts: existingParts(messageId) }),
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
    const existing = loadMessage(messageId)
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
    const existing = loadMessage(messageId)
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
 * Read one bounded page of the newest projected messages.
 *
 * Cursors are owned by this SQLite projection and bind the next read to both
 * the session and its oldest returned ordinal. Rows are selected newest-first
 * with one look-ahead, then returned chronologically for transcript rendering.
 */
export function readSessionMessagePage(sessionId: string, input: AgentMessagePageInput): SessionMessagePage {
  if (input.view !== undefined) {
    const completeSemanticMessage = sql<boolean>`
      ${ClaxedoCloudMessageTable.role} IN ('user', 'assistant')
      AND json_extract(${ClaxedoCloudMessageTable.data}, '$.info.id') = ${ClaxedoCloudMessageTable.message_id}
      AND json_extract(${ClaxedoCloudMessageTable.data}, '$.info.role') = ${ClaxedoCloudMessageTable.role}
    `
    const boundary = ClaxedoDB.use((db) =>
      db
        .select({
          ordinal: ClaxedoCloudMessageTable.ordinal,
          messageId: ClaxedoCloudMessageTable.message_id,
        })
        .from(ClaxedoCloudMessageTable)
        .where(
          and(
            eq(ClaxedoCloudMessageTable.session_id, sessionId),
            completeSemanticMessage,
            eq(ClaxedoCloudMessageTable.role, "user"),
          ),
        )
        .orderBy(desc(ClaxedoCloudMessageTable.ordinal))
        .get(),
    )
    if (!boundary) return { messages: [] }
    const final = ClaxedoDB.use((db) =>
      db
        .select({
          ordinal: ClaxedoCloudMessageTable.ordinal,
        })
        .from(ClaxedoCloudMessageTable)
        .where(and(eq(ClaxedoCloudMessageTable.session_id, sessionId), completeSemanticMessage))
        .orderBy(desc(ClaxedoCloudMessageTable.ordinal))
        .get(),
    )
    if (!final) return { messages: [] }
    const invalidAssistant =
      boundary.ordinal === final.ordinal
        ? undefined
        : ClaxedoDB.use((db) =>
            db
              .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
              .from(ClaxedoCloudMessageTable)
              .where(
                and(
                  eq(ClaxedoCloudMessageTable.session_id, sessionId),
                  completeSemanticMessage,
                  gt(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
                  sql`(
                    ${ClaxedoCloudMessageTable.role} <> 'assistant'
                    OR json_extract(${ClaxedoCloudMessageTable.data}, '$.info.parentID') IS NOT ${boundary.messageId}
                  )`,
                ),
              )
              .limit(1)
              .get(),
          )
    if (invalidAssistant) {
      throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
    }
    if (input.view === "latest-surface") {
      const selectedOrdinals = boundary.ordinal === final.ordinal
        ? [boundary.ordinal]
        : [boundary.ordinal, final.ordinal]
      const ordinalPlaceholders = selectedOrdinals.map(() => "?").join(", ")
      const raw = ClaxedoDB.raw()
      const infoRows = raw
        .prepare(`
          SELECT ordinal, json_extract(data, '$.info') AS info_json
          FROM claxedo_cloud_message
          WHERE session_id = ? AND ordinal IN (${ordinalPlaceholders})
          ORDER BY ordinal ASC
        `)
        .all(sessionId, ...selectedOrdinals)
        .flatMap((row): Array<{ ordinal: number; info_json: string }> => {
          const item = asRecord(row)
          const ordinal = item && numberColumn(item, "ordinal")
          const info_json = item && textColumn(item, "info_json")
          return ordinal === undefined || info_json === undefined ? [] : [{ ordinal, info_json }]
        })
      const selectedParts = raw
        .prepare(`
          SELECT
            m.ordinal AS message_ordinal,
            part.value AS part_json
          FROM claxedo_cloud_message m, json_each(m.data, '$.parts') AS part
          WHERE m.session_id = ?
            AND m.ordinal IN (${ordinalPlaceholders})
            AND json_extract(part.value, '$.type') = 'text'
          ORDER BY m.ordinal ASC, CAST(part.key AS INTEGER) ASC
        `)
        .all(sessionId, ...selectedOrdinals)
        .flatMap((row): Array<{ message_ordinal: number; part_json: string }> => {
          const item = asRecord(row)
          const message_ordinal = item && numberColumn(item, "message_ordinal")
          const part_json = item && textColumn(item, "part_json")
          return message_ordinal === undefined || part_json === undefined
            ? []
            : [{ message_ordinal, part_json }]
        })
      const partsByOrdinal = new Map<number, Array<Record<string, unknown>>>()
      for (const part of selectedParts) {
        const parsed = asRecord(JSON.parse(part.part_json))
        if (!parsed) continue
        partsByOrdinal.set(part.message_ordinal, [...(partsByOrdinal.get(part.message_ordinal) ?? []), readRecordedPart(parsed)])
      }
      // The SQL above selects by the stored type; an attachment recorded as a
      // synthetic text reads back as a file part and leaves the surface here.
      const messages = projectLatestSurfaceMessages(infoRows.flatMap((row) => {
        const info = asRecord(JSON.parse(row.info_json))
        return info ? [{ info, parts: partsByOrdinal.get(row.ordinal) ?? [] }] : []
      }))
      const omittedIntermediate =
        boundary.ordinal === final.ordinal
          ? undefined
          : ClaxedoDB.use((db) =>
              db
                .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
                .from(ClaxedoCloudMessageTable)
                .where(
                  and(
                    eq(ClaxedoCloudMessageTable.session_id, sessionId),
                    completeSemanticMessage,
                    gt(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
                    lt(ClaxedoCloudMessageTable.ordinal, final.ordinal),
                  ),
                )
                .get(),
            )
      const older = ClaxedoDB.use((db) =>
        db
          .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
          .from(ClaxedoCloudMessageTable)
          .where(
            and(
              eq(ClaxedoCloudMessageTable.session_id, sessionId),
              completeSemanticMessage,
              lt(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
            ),
          )
          .get(),
      )
      return {
        messages,
        ...(older || omittedIntermediate ? { nextCursor: encodeMessagePageCursor(sessionId, final.ordinal) } : {}),
      }
    }
    const rows = ClaxedoDB.use((db) =>
      db
        .select({
          ordinal: ClaxedoCloudMessageTable.ordinal,
          data: ClaxedoCloudMessageTable.data,
        })
        .from(ClaxedoCloudMessageTable)
        .where(
          and(
            eq(ClaxedoCloudMessageTable.session_id, sessionId),
            completeSemanticMessage,
            or(
              eq(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
              gt(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
            ),
          ),
        )
        .orderBy(ClaxedoCloudMessageTable.ordinal)
        .all(),
    )
    const older = ClaxedoDB.use((db) =>
      db
        .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
        .from(ClaxedoCloudMessageTable)
        .where(
          and(
            eq(ClaxedoCloudMessageTable.session_id, sessionId),
            completeSemanticMessage,
            lt(ClaxedoCloudMessageTable.ordinal, boundary.ordinal),
          ),
        )
        .get(),
    )
    return {
      messages: hydrateReplayMessages(rows),
      ...(older ? { nextCursor: encodeMessagePageCursor(sessionId, boundary.ordinal) } : {}),
    }
  }
  const limit = input.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT) {
    throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
  const beforeOrdinal = input.before === undefined ? undefined : decodeMessagePageCursor(sessionId, input.before)
  const rows = ClaxedoDB.use((db) =>
    db
      .select({
        ordinal: ClaxedoCloudMessageTable.ordinal,
        data: ClaxedoCloudMessageTable.data,
      })
      .from(ClaxedoCloudMessageTable)
      .where(
        beforeOrdinal === undefined
          ? eq(ClaxedoCloudMessageTable.session_id, sessionId)
          : and(
              eq(ClaxedoCloudMessageTable.session_id, sessionId),
              lt(ClaxedoCloudMessageTable.ordinal, beforeOrdinal),
            ),
      )
      .orderBy(desc(ClaxedoCloudMessageTable.ordinal))
      .limit(limit + 1)
      .all(),
  )
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit).reverse()
  return {
    messages: hydrateReplayMessages(selected),
    ...(hasMore && selected[0] ? { nextCursor: encodeMessagePageCursor(sessionId, selected[0].ordinal) } : {}),
  }
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
  return terminalizeReplayMessages(
    rows.map((row) => {
      const message = readStoredMessage(row.data)
      return { ...message, parts: message.parts.map(readRecordedPart) }
    }),
  )
}

function loadMessage(messageId: string) {
  return ClaxedoDB.use((db) =>
    db.select().from(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.message_id, messageId)).get(),
  )
}

function existingParts(messageId: string): unknown[] {
  const row = loadMessage(messageId)
  return row ? readStoredMessage(row.data).parts : []
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
