import { ClaxedoDB, and, eq, inArray } from "../../platform/db"
import {
  ClaxedoSessionAttachmentTable,
  ClaxedoSessionMetaTable,
  ClaxedoSessionTagTable,
} from "../meta.sql"
import { isOneOf } from "../../platform/runtime/lib/json"
import { SESSION_ATTACHMENT_KINDS, type SessionMeta } from "./types"
import { host, ids, root } from "./shape"
import { storedSessionAttention } from "../reader-contract"
import { storedSessionTurnOutcome } from "../turn-outcome-contract"

type StoredSessionMeta = typeof ClaxedoSessionMetaTable.$inferSelect

export function safeMetaRead<T>(label: string, fallback: T, read: () => T): T {
  try {
    return read()
  } catch (error) {
    console.warn(`[session-meta] ${label} unavailable`, error)
    return fallback
  }
}

export async function sessionMetaMapBySessionId(input: string[]) {
  const hit = ids(input)
  if (!hit.length) return new Map<string, SessionMeta>()
  return hydrateSessionRows(readSessionRowsBySessionId(hit), (item) => item.session_id)
}

export async function sessionMetaMapByRef(input: string[]) {
  const hit = ids(input)
  if (!hit.length) return new Map<string, SessionMeta>()
  return hydrateSessionRows(readSessionRowsByRef(hit), (item) => item.session_ref)
}

/** Mutation callers name the runtime workspace as well as the session id. */
export async function sessionMetaInWorkspace(sessionId: string, workspaceId: string) {
  const row = ClaxedoDB.use((db) => db.select({ session_ref: ClaxedoSessionMetaTable.session_ref })
    .from(ClaxedoSessionMetaTable).where(and(eq(ClaxedoSessionMetaTable.session_id, sessionId), eq(ClaxedoSessionMetaTable.workspace_id, workspaceId))).get())
  return row ? (await sessionMetaMapByRef([row.session_ref])).get(row.session_ref) : undefined
}

export function sessionMetaLocations(sessionId: string) {
  return ClaxedoDB.use((db) => db.select({
    sessionId: ClaxedoSessionMetaTable.session_id,
    workspaceId: ClaxedoSessionMetaTable.workspace_id,
  }).from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionId)).all())
}

function readSessionRowsBySessionId(hit: string[]) {
  return safeMetaRead("session metadata", [], () =>
    ClaxedoDB.use((db) =>
      includeParentRows(
        db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, hit)).all(),
        (queue) =>
          db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, queue)).all(),
      )
    ),
  )
}

function readSessionRowsByRef(hit: string[]) {
  return ClaxedoDB.use((db) => includeParentRows(
    db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_ref, hit)).all(),
    (queue) => db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, queue)).all(),
  ))
}

function includeParentRows(
  initial: StoredSessionMeta[],
  loadParents: (sessionIDs: string[]) => StoredSessionMeta[],
) {
  const all = [...initial]
  const seen = new Set(all.map((item) => item.session_ref))
  const seenIDs = new Set(all.map((item) => item.session_id))
  let queue = ids(all.map((item) => item.parent_session_id ?? ""))
  while (queue.length) {
    const extra = loadParents(queue)
    if (!extra.length) break
    all.push(...extra.filter((item) => {
      if (seen.has(item.session_ref)) return false
      seen.add(item.session_ref)
      return true
    }))
    for (const item of extra) seenIDs.add(item.session_id)
    queue = ids(extra.map((item) => item.parent_session_id ?? "").filter((item) => !seenIDs.has(item)))
  }
  return all
}

function hydrateSessionRows(
  meta: StoredSessionMeta[],
  key: (item: StoredSessionMeta) => string,
) {
  meta = meta.filter(item => host(item.host) === "workspace")
  const corrupt = meta.find((item) => Boolean(item.model_provider_id) !== Boolean(item.model_id))
  if (corrupt) throw new Error(`Session ${corrupt.session_id} has incomplete model configuration`)
  const refs = ids(meta.map((item) => item.session_ref))
  const tags = ClaxedoDB.use((db) =>
      refs.length ? db.select().from(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.session_ref, refs)).all() : [],
  )
  const attachments = ClaxedoDB.use((db) =>
      refs.length
        ? db.select().from(ClaxedoSessionAttachmentTable).where(inArray(ClaxedoSessionAttachmentTable.session_ref, refs)).all()
        : [],
  )
  const by = new Map<string, SessionMeta>(
    meta.map((item) => [
      key(item),
      {
        sessionRef: item.session_ref,
        sessionID: item.session_id,
        ...(item.workspace_id ? { workspaceID: item.workspace_id } : {}),
        ...(item.project_id ? { projectID: item.project_id } : {}),
        host: "workspace" as const,
        ...(item.directory ? { directory: item.directory } : {}),
        ...(item.model_provider_id && item.model_id
          ? { model: { providerID: item.model_provider_id, modelID: item.model_id } }
          : {}),
        ...(item.title ? { title: item.title } : {}),
        ...(item.parent_session_id ? { parentID: item.parent_session_id } : {}),
        ...(item.archived_at ? { archived: item.archived_at } : {}),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        attention: storedSessionAttention(item.attention_json),
        lastTurn: storedSessionTurnOutcome(item.last_turn_json),
        ...(item.last_human_turn_at !== null && item.last_human_turn_at !== undefined
          ? { lastHumanTurnAt: item.last_human_turn_at }
          : {}),
        tags: [],
        attachments: [],
      },
    ]),
  )
  const byRef = new Map([...by.values()].map((item) => [item.sessionRef, item]))
  for (const item of tags) {
    const row = byRef.get(item.session_ref)
    if (!row) continue
    row.tags.push(item.tag)
  }
  for (const item of attachments) {
    const row = byRef.get(item.session_ref)
    if (!row) continue
    if (!isOneOf(item.kind, SESSION_ATTACHMENT_KINDS)) continue
    row.attachments.push({ kind: item.kind, targetID: item.target_id })
  }
  const links = new Map<string, { parentID?: string }>(
    [...by.values()].map((item) => [item.sessionID, (item.parentID ? { parentID: item.parentID } : {})]),
  )
  for (const item of by.values()) {
    item.rootID = root(item.sessionID, links)
    item.tags.sort()
    item.attachments.sort((a, b) => `${a.kind}:${a.targetID}`.localeCompare(`${b.kind}:${b.targetID}`))
  }
  return by
}
