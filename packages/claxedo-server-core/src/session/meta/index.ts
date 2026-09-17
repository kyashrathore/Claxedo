import { isJsonRecord } from "../../platform/runtime/lib/json"
import { ClaxedoDB, and, eq, inArray, textColumns } from "../../platform/db"
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
  laterHumanTurn,
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
import { resolveWorkspace, type Workspace } from "../../workspace/store"
import { controlBus } from "../../platform/runtime/lib/bus"
import { asRecord } from "@claxedo/helpers/guards"

export { GLOBAL_TAG, GLOBAL_SHOW_TAG } from "./types"
export type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
} from "./types"
export { parseSessionMeta } from "./shape"

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
export async function syncSessionMetas(ws: Workspace | undefined, input: unknown[]) {
  const rows = input.map((item) => sessionMetaSyncRow(item, ws))
  const inserted = await upsertRows(rows)
  await announceInventoryChange(inserted, ws)
  if (!ws?.id) return
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
}

export async function syncSessionMeta(ws: Workspace | undefined, input: unknown) {
  const inserted = await upsertRows([sessionMetaSyncRow(input, ws)])
  await announceInventoryChange(inserted, ws)
}

export async function deleteSessionMeta(sessionID: string) {
  const removed = ClaxedoDB.transaction((db) => {
    const rows = db.select({
      session_id: ClaxedoSessionMetaTable.session_id,
      parent_session_id: ClaxedoSessionMetaTable.parent_session_id,
      workspace_id: ClaxedoSessionMetaTable.workspace_id,
    }).from(ClaxedoSessionMetaTable).all()
    const sessionIDs = sessionTreeIDs(rows, sessionID)
    db.delete(ClaxedoSessionAttachmentTable).where(inArray(ClaxedoSessionAttachmentTable.session_id, sessionIDs)).run()
    db.delete(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.session_id, sessionIDs)).run()
    db.delete(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, sessionIDs)).run()
    return rows.filter((row) => sessionIDs.includes(row.session_id)).flatMap((row) => row.workspace_id ? [row.workspace_id] : [])
  })
  await announceInventoryChange(removed)
}

/**
 * Rings `cp/events` once per workspace whose inventory gained or lost a row.
 * After the write has committed, so the read the notice provokes sees the row.
 */
async function announceInventoryChange(workspaceIDs: Array<string | null | undefined>, ws?: Workspace) {
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
    /** Preserve corpus/import stamps; do not invent "now" for seeds. */
    createdAt?: number
    updatedAt?: number
    lastHumanTurnAt?: number
  },
) {
  const stamp = now()
  const inserted = ClaxedoDB.transaction((db) => {
    const prevByID = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionID)).get()
    if (prevByID && !host(prevByID.host)) throw new Error("Unsupported session metadata scope")
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
    const createdAt = prev?.created_at ?? input.createdAt ?? stamp
    const updatedAt = input.updatedAt !== undefined
      ? Math.max(input.updatedAt, prev?.updated_at ?? 0)
      : contentChanged
        ? stamp
        : prev?.updated_at ?? stamp
    const lastHumanTurnAt = laterHumanTurn(input.lastHumanTurnAt, prev?.last_human_turn_at)
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
    return prev ? [] : [workspaceID]
  })
  await announceInventoryChange(inserted, input.ws)
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

/**
 * One bounded page of a workspace's root sessions, ordered as the rail reads
 * them.
 *
 * Children are excluded in SQL rather than by the caller: this query hands back
 * `limit + 1` rows for the page window, so a child dropped afterwards would take
 * a root's slot, shorten the page and — because the window would then be no
 * longer than the limit — retire the cursor with roots still unread.
 */
export async function listSessionNavigationMetas(input: SessionMetaNavigationListInput) {
  const where: string[] = ["m.parent_session_id IS NULL"]
  const params: Array<string | number | null> = []
  if (input.workspaceID) {
    where.push("m.workspace_id = ?")
    params.push(input.workspaceID)
  }
  if (input.directory) {
    where.push("m.directory = ?")
    params.push(input.directory)
  }
  if (input.projectID) {
    where.push("m.project_id = ?")
    params.push(input.projectID)
  }
  if (input.global) {
    where.push(`(
      m.directory = 'global'
      OR EXISTS (
        SELECT 1 FROM claxedo_session_tag gt
        WHERE gt.session_ref = m.session_ref
        AND gt.tag IN ('global', 'global:default')
      )
    )`)
  }
  if (input.archived === "archived") where.push("m.archived_at IS NOT NULL")
  if (input.archived !== "all" && input.archived !== "archived") where.push("m.archived_at IS NULL")
  if (input.search) {
    where.push("LOWER(COALESCE(m.title, '')) LIKE ?")
    params.push(`%${input.search.toLowerCase()}%`)
  }
  const status = ids(input.status ?? [])
  if (status.length) {
    where.push(`(${status.map(() => statusPredicate()).join(" OR ")})`)
    for (const item of status) {
      params.push(item, item, item, item)
    }
  }
  const order = navigationOrder(input)
  if (order.keyset) {
    where.push(order.keyset.sql)
    params.push(...order.keyset.params)
  }

  const rows = safeMetaRead("session navigation list", [], () =>
    ClaxedoDB.raw()
      .prepare(`
        SELECT m.session_ref
        FROM claxedo_session_meta m
        WHERE ${where.join(" AND ")}
        ORDER BY ${order.orderBy}
        LIMIT ?
      `)
      .all(...params, Math.max(0, input.limit))
      .filter(isJsonRecord),
  )
  const hit = textColumns(rows, "session_ref")
  const meta = await sessionMetaMapByRef(hit)
  return hit
    .map((item) => meta.get(item))
    .filter((item): item is SessionMeta => !!item)
}

/**
 * The ORDER BY and the matching keyset predicate, built from one description of
 * the sort so a page boundary cannot disagree with the order it pages through —
 * a mismatched cursor drops rows or repeats them, and neither shows up until the
 * reader scrolls.
 *
 * `human_turn_desc` is the session list's order: when the reader last spoke to
 * the session, then when it was created. A session nobody has ever prompted has
 * no human turn and sorts below every session that has one, which SQLite's DESC
 * already does — it orders NULL below every value. The cursor has to say that
 * explicitly instead, because `NULL < ?` is NULL rather than true, so a plain
 * comparison would end the listing at the first never-prompted row.
 */
function navigationOrder(input: SessionMetaNavigationListInput): {
  orderBy: string
  keyset?: { sql: string; params: Array<string | number | null> }
} {
  const cursor = input.cursor
  if (input.sort === "human_turn_desc") {
    const humanTurnAt = cursor?.lastHumanTurnAt ?? null
    const createdAt = cursor?.createdAt ?? cursor?.updatedAt ?? 0
    return {
      orderBy: "m.last_human_turn_at DESC, m.created_at DESC, m.session_ref DESC",
      ...(cursor ? {
        keyset: {
          sql: `(
            (? IS NOT NULL AND m.last_human_turn_at IS NULL)
            OR m.last_human_turn_at < ?
            OR (m.last_human_turn_at IS ? AND (
              m.created_at < ? OR (m.created_at = ? AND m.session_ref < ?)
            ))
          )`,
          params: [
            humanTurnAt,
            humanTurnAt,
            humanTurnAt,
            createdAt,
            createdAt,
            cursor.sessionRef ?? cursor.sessionID,
          ],
        },
      } : {}),
    }
  }
  const column = input.sort === "created_desc" ? "created_at" : "updated_at"
  const at = input.sort === "created_desc" ? (cursor?.createdAt ?? cursor?.updatedAt ?? 0) : cursor?.updatedAt ?? 0
  return {
    orderBy: `m.${column} DESC, m.session_ref DESC`,
    ...(cursor ? {
      keyset: {
        sql: `(m.${column} < ? OR (m.${column} = ? AND m.session_ref < ?))`,
        params: [at, at, cursor.sessionRef ?? cursor.sessionID],
      },
    } : {}),
  }
}

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
async function upsertRows(rows: Array<ReturnType<typeof sessionMetaSyncRow>>): Promise<Array<string | null>> {
  const all = rows.filter((item): item is Exclude<typeof item, undefined> => !!item)
  if (!all.length) return []
  const hit = ids(all.map((item) => item.session_ref))
  return ClaxedoDB.transaction((db) => {
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
        last_human_turn_at: laterHumanTurn(item.last_human_turn_at, prev?.last_human_turn_at),
      }
      db.insert(ClaxedoSessionMetaTable).values({
        ...update,
        session_ref: item.session_ref,
        created_at: prev?.created_at ?? item.created_at,
      }).onConflictDoUpdate({
        target: ClaxedoSessionMetaTable.session_ref,
        set: update,
      }).run()
    }
    return all.filter((item) => !old.has(item.session_ref)).map((item) => item.workspace_id ?? null)
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

function statusPredicate() {
  return `(
    (? = 'active' AND m.archived_at IS NULL)
    OR (? = 'archived' AND m.archived_at IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM claxedo_session_tag st
      WHERE st.session_ref = m.session_ref
      AND st.tag = ?
    )
    OR EXISTS (
      SELECT 1 FROM claxedo_session_attachment sa
      WHERE sa.session_ref = m.session_ref
      AND sa.kind = ?
    )
  )`
}
