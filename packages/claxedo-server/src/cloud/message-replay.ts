/**
 * Message Replay
 *
 * Persists message events (message.updated, message.part.updated) to claxedo DB
 * as they stream from the runner. Provides readSessionMessages() for replay.
 *
 * Messages are written per-event during streaming and read from claxedo DB
 * on GET /session/:id/message, not from the adapter.
 */

import { ClaxedoDB, eq } from "../storage/db"
import { ClaxedoCloudMessageTable } from "../storage/cloud-session.sql"

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
}

function txt(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

/**
 * Persist a streaming event to the message replay table.
 * Call this from publishGlobal for every compat event during streaming.
 * Only message.updated, message.part.updated, and message.part.delta are handled.
 */
export function persistMessageEvent(sessionId: string, event: { type: string; properties?: unknown }) {
  if (event.type === "message.updated") {
    const props = rec(event.properties)
    const info = rec(props?.info)
    if (!info) return
    const messageId = txt(info.id)
    if (!messageId) return

    const now = Date.now()
    const ordinal = messageOrdinal(sessionId, messageId)

    ClaxedoDB.transaction((db) => {
      db.insert(ClaxedoCloudMessageTable)
        .values({
          message_id: messageId,
          session_id: sessionId,
          workspace_id: sessionId, // placeholder — replay doesn't need workspace routing
          role: txt(info.role) ?? null,
          ordinal,
          data: JSON.stringify({ info, parts: [] }),
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: ClaxedoCloudMessageTable.message_id,
          set: {
            data: JSON.stringify({ info, parts: existingParts(messageId) }),
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
      ordinal: messageOrdinal(sessionId, messageId),
      info: parsed.info,
      parts,
      now,
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
      type: field === "text" ? "text" : "text",
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
      ordinal: messageOrdinal(sessionId, messageId),
      info: parsed.info,
      parts,
      now,
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
    return { info: parsed.info, parts: parsed.parts ?? [] }
  })
}

// ── Bus subscriber ──────────────────────────────────────────────────────────

/**
 * Subscribe to a globalBus and persist message events for all workspaces
 * (local AND cloud). This is the single convergence point — both local
 * events (from agent-session publishGlobal) and cloud events (from
 * workspace-supervisor streamGlobal) arrive on globalBus.
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
          ? txt((rec(props?.part) as Record<string, unknown> | undefined)?.sessionID)
          : txt(props?.sessionID)
    if (!sessionId) return

    persistMessageEvent(sessionId, { type, properties })
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
  ordinal: number
  info: unknown
  parts: unknown[]
  now: number
}) {
  ClaxedoDB.transaction((db) => {
    db.insert(ClaxedoCloudMessageTable)
      .values({
        message_id: input.messageId,
        session_id: input.sessionId,
        workspace_id: input.sessionId,
        role: input.role,
        ordinal: input.ordinal,
        data: JSON.stringify({ info: input.info, parts: input.parts }),
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoUpdate({
        target: ClaxedoCloudMessageTable.message_id,
        set: {
          data: JSON.stringify({ info: input.info, parts: input.parts }),
          updated_at: input.now,
        },
      })
      .run()
  })
}

function messageOrdinal(sessionId: string, messageId: string): number {
  // If message already exists, keep its ordinal
  const existing = loadMessage(messageId)
  if (existing) return existing.ordinal

  // Otherwise, next ordinal for this session
  const last = ClaxedoDB.use((db) =>
    db
      .select({ ordinal: ClaxedoCloudMessageTable.ordinal })
      .from(ClaxedoCloudMessageTable)
      .where(eq(ClaxedoCloudMessageTable.session_id, sessionId))
      .orderBy(ClaxedoCloudMessageTable.ordinal)
      .all(),
  )
  return last.length > 0 ? last[last.length - 1]!.ordinal + 1 : 0
}
