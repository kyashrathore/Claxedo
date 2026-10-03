import { ClaxedoDB, and, eq, inArray } from "../../platform/db"
import {
  ClaxedoSessionAttachmentTable,
  ClaxedoSessionMetaTable,
  ClaxedoSessionTagTable,
} from "../meta.sql"
import { GLOBAL_SHOW_TAG } from "./types"
import type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
} from "./types"
import {
  host,
  ids,
  laterHumanTurnAt,
  now,
  root,
  sessionMetaSyncRow,
  storedSessionRef,
  txt,
} from "./shape"
import {
  safeMetaRead,
  sessionMetaMapByRef,
  sessionMetaMapBySessionId,
} from "./read"
import { resolveWorkspace, type SessionProjectionWorkspace, type Workspace } from "../../workspace/store"
import { controlBus } from "../../platform/runtime/lib/bus"
import { asRecord } from "@claxedo/helpers/guards"
import { reportSessionMetaChanges, type SessionMetaChange } from "./changes"
import { storedSessionAttention, storedSessionReader } from "../reader-contract"
import { ClaxedoSessionReaderTable } from "../reader.sql"
import { deleteLocalSessionAttention, rekeyLocalSessionAttention } from "../attention-ledger"

export { GLOBAL_TAG, GLOBAL_SHOW_TAG } from "./types"
export { onSessionMetaChange, type SessionMetaChange } from "./changes"
export type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
} from "./types"
export { parseSessionMeta } from "./shape"
export { sessionMetaInWorkspace, sessionMetaLocations } from "./read"

/**
 * Reconcile one workspace's session metadata against a snapshot of that
 * workspace's own engine sessions.
 *
 * The only production callers are the embedded runtime's `onSessionMetaSnapshot`
 * hooks, whose snapshot is the reply to `GET /session?directory=<workspace dir>`
 * on that workspace's embedded engine. That makes the snapshot authoritative for
 * exactly one population — the engine's own sessions — so the stale sweep is
 * scoped to it and refuses to act on a snapshot that carries no evidence.
 */
export async function syncSessionMetas(ws: SessionProjectionWorkspace | undefined, input: unknown[]) {
  const rows = input.map((item) => sessionMetaSyncRow(item, ws))
  const writes = await upsertRows(rows)
  await announceInventoryChange(writes.inserted, ws)
  if (!ws?.id) {
    reportSessionMetaChanges(writes.changed)
    return
  }
  const incoming = ids(rows.flatMap((item) => item?.session_ref ? [item.session_ref] : []))
  const owned = ClaxedoDB.use((db) => db
    .select({
      session_ref: ClaxedoSessionMetaTable.session_ref,
      host: ClaxedoSessionMetaTable.host,
    })
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.workspace_id, ws.id))
    .all()
    .filter((item) => host(item.host) === "workspace")
    .map((item) => item.session_ref))
  // An empty snapshot is indistinguishable from "this engine has not listed its
  // sessions yet" — a restart, a race with the runtime's first apply, or a body
  // that merely parsed as `[]`. It is absence of evidence, not evidence of
  // absence, so it upserts nothing and must delete nothing.
  if (!incoming.length && owned.length) {
    console.warn("[session-meta] empty session snapshot ignored", {
      workspaceID: ws.id,
      retained: owned.length,
    })
    return
  }
  const stale = owned.filter((session_ref) => !incoming.includes(session_ref))
  deleteSessionMetaRefs(stale)
  if (stale.length) await announceInventoryChange([ws.id], ws)
  if (writes.changed.length || stale.length) reportSessionMetaChanges([{ kind: "workspace", workspaceId: ws.id }])
}

export async function syncSessionMeta(ws: SessionProjectionWorkspace | undefined, input: unknown) {
  const row = sessionMetaSyncRow(input, ws)
  const writes = await upsertRows([row])
  await announceInventoryChange(writes.inserted, ws)
  reportSessionMetaChanges(writes.changed)
}

export async function deleteSessionMeta(sessionID: string) {
  const removed = ClaxedoDB.transaction((db) => {
    const rows = db.select({
      session_ref: ClaxedoSessionMetaTable.session_ref,
      session_id: ClaxedoSessionMetaTable.session_id,
      parent_session_id: ClaxedoSessionMetaTable.parent_session_id,
      workspace_id: ClaxedoSessionMetaTable.workspace_id,
    }).from(ClaxedoSessionMetaTable).all()
    const sessionIDs = sessionTreeIDs(rows, sessionID)
    const refs = rows.filter((row) => sessionIDs.includes(row.session_id)).map((row) => row.session_ref)
    for (const sessionRef of refs) deleteLocalSessionAttention(db, sessionRef)
    if (refs.length) db.delete(ClaxedoSessionReaderTable).where(inArray(ClaxedoSessionReaderTable.session_ref, refs)).run()
    db.delete(ClaxedoSessionAttachmentTable).where(inArray(ClaxedoSessionAttachmentTable.session_id, sessionIDs)).run()
    db.delete(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.session_id, sessionIDs)).run()
    db.delete(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, sessionIDs)).run()
    return rows.flatMap((row): SessionMetaChange[] =>
      sessionIDs.includes(row.session_id) && row.workspace_id
        ? [{ kind: "removed", workspaceId: row.workspace_id, sessionId: row.session_id }]
        : [])
  })
  await announceInventoryChange(removed.map((change) => change.workspaceId))
  reportSessionMetaChanges(removed)
}

/**
 * Rings `cp/events` once per workspace whose inventory gained or lost a row.
 * After the write has committed, so the read the notice provokes sees the row.
 */
async function announceInventoryChange(workspaceIDs: Array<string | null | undefined>, ws?: SessionProjectionWorkspace) {
  const ts = Date.now()
  for (const workspaceId of new Set(workspaceIDs.flatMap((id) => (id ? [id] : [])))) {
    const workspace = ws?.id === workspaceId ? ws : await resolveWorkspace({ workspaceId }).catch(() => undefined)
    controlBus.publish({
      type: "session.inventory.changed",
      workspaceId,
      ...(workspace?.org_id ? { orgId: workspace.org_id } : {}),
      ts,
    })
  }
}

function sessionTreeIDs(
  rows: Array<{ session_id: string; parent_session_id: string | null }>,
  rootID: string,
) {
  const children = Map.groupBy(rows, (row) => row.parent_session_id)
  const seen = new Set<string>()
  const visit = (sessionID: string): string[] => {
    if (seen.has(sessionID)) return []
    seen.add(sessionID)
    return [sessionID, ...(children.get(sessionID) ?? []).flatMap((row) => visit(row.session_id))]
  }
  return visit(rootID)
}

export async function putSessionMeta(
  sessionID: string,
  input: {
    ws?: Workspace
    workspaceID?: string | null
    directory?: string | null
    host?: "workspace"
    model?: { providerID: string; modelID: string } | null
    title?: string | null
    parentID?: string | null
    archived?: number | null
    tags?: string[]
    attachments?: SessionAttachment[]
    /** The runtime's times; a put that would create the row is refused without both. */
    createdAt?: number
    updatedAt?: number
    lastHumanTurnAt?: number
  },
) {
  const stamp = now()
  const inserted = ClaxedoDB.transaction((db) => {
    const prevByID = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionID)).get()
    if (prevByID && !host(prevByID.host)) throw new Error("Unsupported session metadata scope")
    if (input.updatedAt !== undefined && prevByID?.runtime_updated_at != null && input.updatedAt < prevByID.runtime_updated_at) {
      return { inserted: [], workspaceID: undefined }
    }
    const workspaceID = input.workspaceID === undefined
      ? input.ws?.id ?? prevByID?.workspace_id ?? null
      : input.workspaceID
    if (input.host !== undefined && input.host !== "workspace") throw new Error("Unsupported session metadata scope")
    const hostValue = input.host ?? host(prevByID?.host) ?? "workspace"
    const directory = input.directory ?? input.ws?.directory ?? prevByID?.directory ?? null
    // Preserve the registered workspace kind when changing title or tags.
    const workspaceKind = input.ws?.kind ?? (prevByID?.session_ref.startsWith("local:") ? "local" : undefined)
    const sessionRef = storedSessionRef({
      session_id: sessionID,
      workspace_id: workspaceID,
      workspace_kind: workspaceKind,
      directory,
      host: hostValue,
    })
    rekeySessionRef(db, { session_id: sessionID, workspace_id: workspaceID, session_ref: sessionRef })
    const prev = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_ref, sessionRef)).get() ?? prevByID

    const modelProviderID = input.model === undefined ? prev?.model_provider_id ?? null : input.model?.providerID ?? null
    const modelID = input.model === undefined ? prev?.model_id ?? null : input.model?.modelID ?? null
    const title = input.title === undefined ? prev?.title ?? null : input.title
    const parentSessionID = input.parentID === undefined ? prev?.parent_session_id ?? null : input.parentID
    const archivedAt = input.archived === undefined ? prev?.archived_at ?? null : input.archived
    const projectID = input.ws?.project_id ?? prev?.project_id ?? null
    const contentChanged = !prev
      || prev.workspace_id !== workspaceID
      || prev.project_id !== projectID
      || prev.host !== hostValue
      || prev.directory !== directory
      || prev.model_provider_id !== modelProviderID
      || prev.model_id !== modelID
      || prev.title !== title
      || prev.parent_session_id !== parentSessionID
      || prev.archived_at !== archivedAt
      || input.tags !== undefined
      || input.attachments !== undefined
    const createdAt = prev?.created_at ?? input.createdAt
    if (createdAt === undefined || (!prev && input.updatedAt === undefined)) {
      throw new Error(`Session ${sessionID} has no runtime time.created and time.updated`)
    }
    const updatedAt = input.updatedAt !== undefined
      ? Math.max(input.updatedAt, prev?.updated_at ?? 0)
      : contentChanged
        ? stamp
        : prev?.updated_at ?? stamp
    const lastHumanTurnAt = laterHumanTurnAt(input.lastHumanTurnAt, prev?.last_human_turn_at)
    const runtimeUpdatedAt = input.updatedAt === undefined
      ? prev?.runtime_updated_at ?? null
      : Math.max(input.updatedAt, prev?.runtime_updated_at ?? 0)
    const update = {
      session_id: sessionID,
      workspace_id: workspaceID,
      project_id: projectID,
      host: hostValue,
      directory,
      model_provider_id: modelProviderID,
      model_id: modelID,
      title,
      parent_session_id: parentSessionID,
      archived_at: archivedAt,
      updated_at: updatedAt,
      last_human_turn_at: lastHumanTurnAt,
      runtime_updated_at: runtimeUpdatedAt,
    }
    db.insert(ClaxedoSessionMetaTable).values({
      ...update,
      session_ref: sessionRef,
      created_at: createdAt,
    }).onConflictDoUpdate({
      target: ClaxedoSessionMetaTable.session_ref,
      set: update,
    }).run()

    if (input.tags) {
      db.delete(ClaxedoSessionTagTable).where(eq(ClaxedoSessionTagTable.session_ref, sessionRef)).run()
      for (const tag of input.tags) {
        db.insert(ClaxedoSessionTagTable).values({
          session_ref: sessionRef,
          session_id: sessionID,
          tag,
          created_at: stamp,
          updated_at: stamp,
        }).run()
      }
    }

    if (input.attachments) {
      db.delete(ClaxedoSessionAttachmentTable).where(eq(ClaxedoSessionAttachmentTable.session_ref, sessionRef)).run()
      for (const item of input.attachments) {
        db.insert(ClaxedoSessionAttachmentTable).values({
          session_ref: sessionRef,
          session_id: sessionID,
          kind: item.kind,
          target_id: item.targetID,
          created_at: stamp,
          updated_at: stamp,
        }).run()
      }
    }
    return { inserted: prev ? [] : [workspaceID], workspaceID }
  })
  await announceInventoryChange(inserted.inserted, input.ws)
  if (inserted.workspaceID) reportSessionMetaChanges([{ kind: "changed", workspaceId: inserted.workspaceID, sessionId: sessionID }])
}

export async function sessionMetas(input: string[]) {
  return sessionMetaMapBySessionId(input)
}

export async function sessionMeta(sessionID: string) {
  return (await sessionMetas([sessionID])).get(sessionID)
}

export async function taggedSessionMetas(tags: string[], input?: { includeHidden?: boolean }) {
  const all = ids(tags)
  if (!all.length) return []
  const hit = safeMetaRead("tagged sessions", [], () =>
    ClaxedoDB.use((db) =>
      db.select().from(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.tag, all)).all(),
    ),
  )
  const grouped = new Map<string, Set<string>>()
  for (const item of hit) {
    const set = grouped.get(item.session_ref) ?? new Set<string>()
    set.add(item.tag)
    grouped.set(item.session_ref, set)
  }
  const rows = [...grouped.entries()]
    .filter(([, set]) => all.every((tag) => set.has(tag)))
    .map(([sessionRef]) => sessionRef)
  const meta = await sessionMetaMapByRef(rows)
  return rows
    .map((sessionRef) => meta.get(sessionRef))
    .filter((item): item is SessionMeta => !!item)
    .filter((item) => input?.includeHidden || item.tags.includes(GLOBAL_SHOW_TAG))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function sourceChannelSessionCountsByWeek(input?: {
  channel?: string
  includeHidden?: boolean
}) {
  const channels = input?.channel
    ? [input.channel]
    : ["github", "slack", "telegram", "discord", "whatsapp"]
  const counts = new Map<string, { channel: string; week: string; count: number }>()
  for (const channel of channels) {
    const sessions = await taggedSessionMetas([`source-channel:${channel}`], {
      includeHidden: input?.includeHidden ?? true,
    })
    for (const session of sessions) {
      const week = weekKey(session.createdAt)
      const key = `${channel}:${week}`
      const current = counts.get(key)
      counts.set(key, {
        channel,
        week,
        count: (current?.count ?? 0) + 1,
      })
    }
  }
  return [...counts.values()].sort((a, b) => a.week.localeCompare(b.week) || a.channel.localeCompare(b.channel))
}

export async function listSessionMetas(input?: {
  workspaceID?: string
  directory?: string
  includeArchived?: boolean
}) {
  const rows = safeMetaRead("session list", [], () => ClaxedoDB.use((db) => db.select().from(ClaxedoSessionMetaTable).all()))
  const hit = rows
    .filter((item) => !input?.workspaceID || item.workspace_id === input.workspaceID)
    .filter((item) => !input?.directory || item.directory === input.directory)
    .filter((item) => input?.includeArchived || !item.archived_at)
    .map((item) => item.session_ref)
  const meta = await sessionMetaMapByRef(hit)
  return hit
    .map((item) => meta.get(item))
    .filter((item): item is SessionMeta => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export { listSessionNavigationMetas, countSessionNavigation } from "./navigation"

export function applySessionMeta(input: Array<Record<string, unknown>>) {
  const sessionIDs = input.map((item) => txt(item.id)).filter((item): item is string => !!item)
  return sessionMetas(sessionIDs).then((meta) => {
    const links = new Map([
      ...[...meta.values()].map((item) => [
        item.sessionID,
        {
          parentID: item.parentID,
        },
      ] as const),
      ...input.map((item) => [
        txt(item.id) ?? "",
        {
          parentID: txt(item.parentID) ?? meta.get(txt(item.id) ?? "")?.parentID,
        },
      ] as const),
    ])
    return input.map((item) => {
      const id = txt(item.id)
      if (!id) return item
      const hit = meta.get(id)
      const parentID = txt(item.parentID) ?? hit?.parentID
      const archived = asRecord(item.time)?.archived ?? hit?.archived
      return {
        ...item,
        ...(hit?.projectID ? { projectID: hit.projectID } : {}),
        ...(parentID ? { parentID } : {}),
        rootID: root(id, links),
        ...(archived !== undefined ? { time: { ...asRecord(item.time), archived } } : {}),
        tags: hit?.tags ?? [],
        attachments: hit?.attachments ?? [],
      }
    })
  })
}

/** Writes the rows; returns the workspace of every row that did not exist before. */
async function upsertRows(rows: Array<ReturnType<typeof sessionMetaSyncRow>>): Promise<{ inserted: Array<string | null>; changed: SessionMetaChange[] }> {
  const all = rows.filter((item): item is Exclude<typeof item, undefined> => !!item)
  if (!all.length) return { inserted: [], changed: [] }
  const hit = ids(all.map((item) => item.session_ref))
  return ClaxedoDB.transaction((db) => {
    const changed: SessionMetaChange[] = []
    const inserted: Array<string | null> = []
    // Before anything is written, so the row read as `prev` below is the
    // re-keyed row and keeps its `created_at`.
    for (const item of all) rekeySessionRef(db, item)
    const old = new Map(
      (hit.length
        ? db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_ref, hit)).all()
        : [])
        .map((item) => [item.session_ref, item]),
    )
    for (const item of all) {
      const prev = old.get(item.session_ref)
      // Two pulls of one session can finish in either order; the runtime's
      // `time.updated` orders their snapshots, and the older one writes nothing.
      const incomingAttention = storedSessionAttention(item.attention_json)
      const previousAttention = storedSessionAttention(prev?.attention_json)
      if (previousAttention && !incomingAttention) throw new Error(`Session ${item.session_id} snapshot omitted canonical activity facts`)
      if (incomingAttention && previousAttention && incomingAttention.sequence < previousAttention.sequence) continue
      if (!incomingAttention && prev?.runtime_updated_at != null && item.updated_at < prev.runtime_updated_at) continue
      const update = {
        session_id: item.session_id,
        workspace_id: item.workspace_id ?? prev?.workspace_id ?? null,
        project_id: item.project_id ?? prev?.project_id ?? null,
        host: item.host ?? host(prev?.host) ?? "workspace",
        directory: item.directory ?? prev?.directory ?? null,
        model_provider_id: item.model_provider_id ?? prev?.model_provider_id ?? null,
        model_id: item.model_id ?? prev?.model_id ?? null,
        title: item.title ?? prev?.title ?? null,
        parent_session_id: item.parent_session_id ?? prev?.parent_session_id ?? null,
        archived_at: item.archived_at,
        updated_at: Math.max(item.updated_at, prev?.updated_at ?? 0),
        last_human_turn_at: laterHumanTurnAt(item.last_human_turn_at, prev?.last_human_turn_at),
        runtime_updated_at: item.updated_at,
        attention_json: item.attention_json,
        last_turn_json: item.last_turn_json,
      }
      if (prev && Object.entries(update).every(([key, value]) => value === Reflect.get(prev, key))) continue
      db.insert(ClaxedoSessionMetaTable).values({
        ...update,
        session_ref: item.session_ref,
        created_at: prev?.created_at ?? item.created_at,
      }).onConflictDoUpdate({
        target: ClaxedoSessionMetaTable.session_ref,
        set: update,
      }).run()
      if (!prev) inserted.push(item.workspace_id ?? null)
      if (update.workspace_id) changed.push({ kind: "changed", workspaceId: update.workspace_id, sessionId: item.session_id })
    }
    return { inserted, changed }
  })
}

/**
 * Move a session's stored row — and everything joined to it — onto the ref the
 * caller is about to write.
 *
 * `session_ref` is the primary key of `claxedo_session_meta` and the join key of
 * `claxedo_session_tag` and `claxedo_session_attachment`, but it is a *derived*
 * identity: `storedSessionRef` composes it from host, workspace kind, workspace
 * id and directory. When one of those changes shape — a local workspace moving
 * from `workspace:<ws>:session:<id>` to `local:<dir>:session:<id>` once
 * `Workspace.kind` reached the ref — a plain insert leaves the previous row
 * behind, orphaning its pins (`global`/`global:default`), `source-channel:*`
 * tags and attachments, and offering the old ref to `syncSessionMetas` as
 * "stale" to delete. Re-key in place instead, inside the caller's transaction
 * and before the write, so no child row is ever orphaned and no ref is ever
 * both live and stale.
 *
 * Scoped to the owning workspace: session ids are unique only within one, so two
 * workspaces genuinely hold distinct sessions under the same id and must never
 * be collapsed into each other.
 */
function rekeySessionRef(
  db: ClaxedoDB.Client,
  input: { session_id: string; workspace_id: string | null; session_ref: string },
) {
  const stale = db
    .select()
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.session_id, input.session_id))
    .all()
    .filter((row) => row.session_ref !== input.session_ref)
    .filter((row) => (row.workspace_id ?? null) === (input.workspace_id ?? null))
  if (!stale.length) return
  // Normally empty: the re-key runs before the new ref is written. Occupied when
  // a build that inserted the new ref without moving the old row already ran, in
  // which case the surviving row wins and the stale one only contributes the
  // children it still owns.
  let occupied = !!db
    .select({ session_ref: ClaxedoSessionMetaTable.session_ref })
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.session_ref, input.session_ref))
    .get()
  for (const row of stale) {
    if (occupied) {
      db.delete(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_ref, row.session_ref)).run()
    } else {
      db.update(ClaxedoSessionMetaTable)
        .set({ session_ref: input.session_ref })
        .where(eq(ClaxedoSessionMetaTable.session_ref, row.session_ref))
        .run()
      occupied = true
    }
    moveSessionMetaChildren(db, row.session_ref, input.session_ref)
  }
}

/**
 * Carry tag and attachment rows across a ref change by updating them in place.
 * A child whose composite key already exists under the destination ref cannot be
 * updated onto it, so drop that exact duplicate first — it carries no
 * information the destination does not already hold.
 */
function moveSessionMetaChildren(db: ClaxedoDB.Client, from: string, to: string) {
  rekeyLocalSessionAttention(db, from, to)
  for (const reader of db.select().from(ClaxedoSessionReaderTable).where(eq(ClaxedoSessionReaderTable.session_ref, from)).all()) {
    const existing = db.select().from(ClaxedoSessionReaderTable).where(and(
      eq(ClaxedoSessionReaderTable.session_ref, to),
      eq(ClaxedoSessionReaderTable.reader_id, reader.reader_id),
    )).get()
    const incomingState = storedSessionReader(reader.state_json)!
    const existingState = storedSessionReader(existing?.state_json)
    if (existingState && (existingState.generation > incomingState.generation
      || existingState.generation === incomingState.generation && existingState.revision > incomingState.revision)) continue
    if (existingState && existingState.generation === incomingState.generation && existingState.revision === incomingState.revision
      && existing!.state_json !== reader.state_json) throw new Error("Conflicting session reader state at the same revision")
    db.insert(ClaxedoSessionReaderTable).values({ ...reader, session_ref: to }).onConflictDoUpdate({
      target: [ClaxedoSessionReaderTable.session_ref, ClaxedoSessionReaderTable.reader_id],
      set: { state_json: reader.state_json },
    }).run()
  }
  db.delete(ClaxedoSessionReaderTable).where(eq(ClaxedoSessionReaderTable.session_ref, from)).run()
  const heldTags = new Set(
    db.select({ tag: ClaxedoSessionTagTable.tag })
      .from(ClaxedoSessionTagTable)
      .where(eq(ClaxedoSessionTagTable.session_ref, to))
      .all()
      .map((item) => item.tag),
  )
  const duplicateTags = db
    .select({ tag: ClaxedoSessionTagTable.tag })
    .from(ClaxedoSessionTagTable)
    .where(eq(ClaxedoSessionTagTable.session_ref, from))
    .all()
    .map((item) => item.tag)
    .filter((tag) => heldTags.has(tag))
  if (duplicateTags.length) {
    db.delete(ClaxedoSessionTagTable)
      .where(and(eq(ClaxedoSessionTagTable.session_ref, from), inArray(ClaxedoSessionTagTable.tag, duplicateTags)))
      .run()
  }
  db.update(ClaxedoSessionTagTable)
    .set({ session_ref: to })
    .where(eq(ClaxedoSessionTagTable.session_ref, from))
    .run()

  const attachmentKey = (item: { kind: string; target_id: string }) => `${item.kind}:${item.target_id}`
  const heldAttachments = new Set(
    db.select().from(ClaxedoSessionAttachmentTable)
      .where(eq(ClaxedoSessionAttachmentTable.session_ref, to))
      .all()
      .map(attachmentKey),
  )
  const duplicateAttachments = db
    .select()
    .from(ClaxedoSessionAttachmentTable)
    .where(eq(ClaxedoSessionAttachmentTable.session_ref, from))
    .all()
    .filter((item) => heldAttachments.has(attachmentKey(item)))
  for (const item of duplicateAttachments) {
    db.delete(ClaxedoSessionAttachmentTable)
      .where(and(
        eq(ClaxedoSessionAttachmentTable.session_ref, from),
        eq(ClaxedoSessionAttachmentTable.kind, item.kind),
        eq(ClaxedoSessionAttachmentTable.target_id, item.target_id),
      ))
      .run()
  }
  db.update(ClaxedoSessionAttachmentTable)
    .set({ session_ref: to })
    .where(eq(ClaxedoSessionAttachmentTable.session_ref, from))
    .run()
}

function deleteSessionMetaRefs(sessionRefs: string[]) {
  if (sessionRefs.length === 0) return
  ClaxedoDB.transaction((db) => {
    for (const sessionRef of sessionRefs) deleteLocalSessionAttention(db, sessionRef)
    db.delete(ClaxedoSessionReaderTable).where(inArray(ClaxedoSessionReaderTable.session_ref, sessionRefs)).run()
    db.delete(ClaxedoSessionAttachmentTable).where(inArray(ClaxedoSessionAttachmentTable.session_ref, sessionRefs)).run()
    db.delete(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.session_ref, sessionRefs)).run()
    db.delete(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_ref, sessionRefs)).run()
  })
}

function weekKey(input: number) {
  const date = new Date(input)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() - day + 1)
  date.setUTCHours(0, 0, 0, 0)
  return date.toISOString().slice(0, 10)
}
