/**
 * Message Replay
 *
 * Persists message events (message.updated, message.part.updated) to claxedo DB
 * as they stream from the runner. Provides readSessionMessages() for replay.
 *
 * Messages are written per-event during streaming and read from claxedo DB
 * on GET /session/:id/message, not from the adapter.
 */

import { ClaxedoDB, and, desc, eq, gt } from "../storage/db"
import { ClaxedoCloudMessageEventTable, ClaxedoCloudMessageTable, ClaxedoCloudSessionTable } from "../storage/cloud-session.sql"
import { ClaxedoSessionMetaTable } from "../storage/session-meta.sql"

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
}

function txt(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}

function staleToolError(message?: string) {
  if (message?.includes("ACP process restarted")) return "Tool execution interrupted by ACP restart"
  return "Tool execution interrupted"
}

function terminalizedPart(part: Record<string, unknown>, ts: number, message?: string) {
  if (part.type !== "tool") return part
  const state = rec(part.state)
  const status = txt(state?.status)
  if (status !== "pending" && status !== "running") return part
  const time = rec(state?.time)
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
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
  options: { interrupted?: boolean; message?: string } = {},
) {
  return messages.map((message) => {
    const time = rec(message.info.time)
    const err = rec(message.info.error)
    const data = rec(err?.data)
    const errorMessage = options.message ?? txt(data?.message) ?? txt(err?.message)
    const terminal = options.interrupted || (message.info.role === "assistant" && (typeof time?.completed === "number" || !!message.info.error))
    const ts = num(time?.completed) ?? num(time?.created) ?? Date.now()
    return {
      info: message.info,
      parts: terminal
        ? message.parts.map((part) => terminalizedPart(part, ts, errorMessage))
        : message.parts,
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
export function persistMessageEvent(sessionId: string, event: { type: string; properties?: unknown }, directory?: string) {
  if (event.type === "message.updated") {
    const props = rec(event.properties)
    const info = rec(props?.info)
    if (!info) return
    const messageId = txt(info.id)
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
          role: txt(info.role) ?? null,
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
    const props = rec(event.properties)
    const part = rec(props?.part)
    if (!part) return
    const messageId = txt(part.messageID)
    if (!messageId) return

    const now = Date.now()
    const existing = loadMessage(messageId)
    const parsed = existing
      ? JSON.parse(existing.data) as { info: unknown; parts: unknown[] }
      : { info: { id: messageId, sessionID: txt(part.sessionID) ?? sessionId }, parts: [] }
    const parts = parsed.parts.filter(
      (p) => rec(p) && txt(rec(p)!.id) !== txt(part.id),
    )
    parts.push(part)

    writeMessage({
      messageId,
      sessionId,
      role: txt(rec(parsed.info)?.role) ?? null,
      info: parsed.info,
      parts,
      now,
      event,
      directory,
    })
    return
  }

  if (event.type === "message.part.delta") {
    const props = rec(event.properties)
    const messageId = txt(props?.messageID)
    const partId = txt(props?.partID)
    const field = txt(props?.field)
    const delta = txt(props?.delta)
    if (!messageId || !partId || !field || delta === undefined) return

    const now = Date.now()
    const existing = loadMessage(messageId)
    const parsed = existing
      ? JSON.parse(existing.data) as { info: unknown; parts: unknown[] }
      : { info: { id: messageId, sessionID: txt(props?.sessionID) ?? sessionId }, parts: [] }
    const parts = parsed.parts.slice()
    const idx = parts.findIndex((item) => txt(rec(item)?.id) === partId)
    const prev = idx >= 0 && rec(parts[idx]) ? rec(parts[idx])! : {
      id: partId,
      sessionID: txt(props?.sessionID) ?? sessionId,
      messageID: messageId,
      type: "text",
      text: "",
    }
    const next = {
      ...prev,
      [field]: `${txt(prev[field]) ?? ""}${delta}`,
    }
    if (idx >= 0) parts[idx] = next
    if (idx < 0) parts.push(next)

    writeMessage({
      messageId,
      sessionId,
      role: txt(rec(parsed.info)?.role) ?? null,
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
export function readSessionMessages(sessionId: string): Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoCloudMessageTable)
      .where(eq(ClaxedoCloudMessageTable.session_id, sessionId))
      .orderBy(ClaxedoCloudMessageTable.ordinal)
      .all(),
  ).map((row) => {
    const parsed = JSON.parse(row.data) as { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }
    return terminalizeReplayMessages([{ info: parsed.info, parts: parsed.parts ?? [] }])[0]
  }).filter((message): message is { info: Record<string, unknown>; parts: Array<Record<string, unknown>> } => !!message)
}

/**
 * Read persisted SSE-compatible events after a session-local event ordinal.
 */
export function readSessionEventsAfter(sessionId: string, afterOrdinal: number): PersistedEvent[] {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoCloudMessageEventTable)
      .where(and(
        eq(ClaxedoCloudMessageEventTable.session_id, sessionId),
        gt(ClaxedoCloudMessageEventTable.event_ordinal, afterOrdinal),
      ))
      .orderBy(ClaxedoCloudMessageEventTable.event_ordinal)
      .all(),
  ).map((row) => {
    const parsed = JSON.parse(row.data) as { type?: unknown; properties?: unknown }
    const properties = rec(parsed.properties)
    return {
      event_ordinal: row.event_ordinal,
      type: txt(parsed.type) ?? row.type,
      ...(row.directory ? { directory: row.directory } : {}),
      ...(properties ? { properties } : {}),
    }
  })
}

export function readSessionMaxEventOrdinal(sessionId: string): number {
  return ClaxedoDB.use((db) => maxStoredEventOrdinal(db, sessionId))
}

// ── Bus subscriber ──────────────────────────────────────────────────────────

/**
 * Subscribe to a globalBus and persist message events for all sources that
 * publish OpenCode-shaped compatibility events into this process. This is the
 * convergence point for events already on the central bus; workspace-runtime
 * canonical events remain per-workspace unless an explicit publisher bridges
 * them here.
 *
 * Returns an unsubscribe function.
 */
export function subscribeMessageReplay(bus: {
  subscribe: (fn: (event: { directory?: string; payload: { type: string; properties?: Record<string, unknown> } }) => void) => () => void
}) {
  return bus.subscribe((event) => {
    const { type, properties } = event.payload
    if (type !== "message.updated" && type !== "message.part.updated" && type !== "message.part.delta") return

    const props = rec(properties)
    const sessionId =
      type === "message.updated"
        ? txt((rec(props?.info) as Record<string, unknown> | undefined)?.sessionID)
        : type === "message.part.updated"
          ? txt(props?.sessionID) ?? txt((rec(props?.part) as Record<string, unknown> | undefined)?.sessionID)
          : txt(props?.sessionID)
    if (!sessionId) return

    persistMessageEvent(sessionId, { type, properties }, event.directory)
  })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function loadMessage(messageId: string) {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoCloudMessageTable)
      .where(eq(ClaxedoCloudMessageTable.message_id, messageId))
      .get(),
  )
}

function existingParts(messageId: string): unknown[] {
  const row = loadMessage(messageId)
  if (!row) return []
  const parsed = JSON.parse(row.data) as { parts?: unknown[] }
  return parsed.parts ?? []
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
