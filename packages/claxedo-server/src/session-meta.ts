import { and, ClaxedoDB, eq, inArray } from "./storage/db"
import {
  ClaxedoSessionAttachmentTable,
  ClaxedoSessionMetaTable,
  ClaxedoSessionTagTable,
} from "./storage/session-meta.sql"
import type { Workspace } from "./workspace-store"

const KINDS = new Set(["review", "page", "planner"])
export const GLOBAL_TAG = "global"
export const GLOBAL_SHOW_TAG = "global:default"

function safeMetaRead<T>(label: string, fallback: T, read: () => T): T {
  try {
    return read()
  } catch (error) {
    console.warn(`[session-meta] ${label} unavailable`, error)
    return fallback
  }
}

export type SessionAttachment = {
  kind: "review" | "page" | "planner"
  targetID: string
}

export type SessionMeta = {
  sessionID: string
  workspaceID?: string
  projectID?: string
  directory: string
  title?: string
  parentID?: string
  rootID?: string
  archived?: number
  createdAt: number
  updatedAt: number
  tags: string[]
  attachments: SessionAttachment[]
}

function now() {
  return Date.now()
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function uniq(input: string[]) {
  return [...new Set(input)]
}

function stamp(input: unknown) {
  const row = rec(input)
  const time = rec(row?.time)
  const created = num(time?.created) ?? num(row?.created_at) ?? now()
  const updated = num(time?.updated) ?? num(row?.updated_at) ?? created
  const archived = num(time?.archived) ?? num(row?.archived_at)
  return { created, updated, archived }
}

function row(input: unknown, ws?: Workspace) {
  const item = rec(input)
  const session_id = txt(item?.id)
  if (!session_id) return
  const time = stamp(item)
  return {
    session_id,
    workspace_id: ws?.id ?? txt(item?.workspaceID) ?? null,
    project_id: ws?.project_id ?? txt(item?.projectID) ?? null,
    directory: txt(item?.directory) ?? ws?.directory ?? "",
    title: txt(item?.title) ?? txt(item?.slug) ?? null,
    parent_session_id: txt(item?.parentID),
    archived_at: time.archived ?? null,
    created_at: time.created,
    updated_at: time.updated,
  }
}

function ids(input: string[]) {
  return uniq(input.map((item) => item.trim()).filter(Boolean))
}

function tags(input: unknown) {
  if (!Array.isArray(input)) return undefined
  return ids(input.filter((item): item is string => typeof item === "string"))
}

function attachments(input: unknown) {
  if (!Array.isArray(input)) return undefined
  return uniq(input.flatMap((item) => {
    const row = rec(item)
    const kind = txt(row?.kind)
    const targetID = txt(row?.targetID) ?? txt(row?.target_id)
    if (!kind || !targetID || !KINDS.has(kind)) return []
    return [{ kind: kind as SessionAttachment["kind"], targetID }]
  }).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as SessionAttachment)
}

function root(input: string, by: Map<string, { parentID?: string }>, seen = new Set<string>()): string {
  if (seen.has(input)) return input
  seen.add(input)
  const parentID = by.get(input)?.parentID
  if (!parentID) return input
  if (!by.has(parentID)) return parentID
  return root(parentID, by, seen)
}

async function upsertRows(rows: Array<ReturnType<typeof row>>) {
  const all = rows.filter((item): item is Exclude<typeof item, undefined> => !!item)
  if (!all.length) return
  const hit = ids(all.map((item) => item.session_id))
  ClaxedoDB.transaction((db) => {
    const old = new Map(
      (hit.length
        ? db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, hit)).all()
        : [])
        .map((item) => [item.session_id, item]),
    )
    for (const item of all) {
      const prev = old.get(item.session_id)
      db.insert(ClaxedoSessionMetaTable).values({
        session_id: item.session_id,
        workspace_id: item.workspace_id ?? prev?.workspace_id ?? null,
        project_id: item.project_id ?? prev?.project_id ?? null,
        directory: item.directory || prev?.directory || "",
        title: item.title ?? prev?.title ?? null,
        parent_session_id: item.parent_session_id ?? prev?.parent_session_id ?? null,
        archived_at: item.archived_at,
        created_at: prev?.created_at ?? item.created_at,
        updated_at: Math.max(item.updated_at, prev?.updated_at ?? 0),
      }).onConflictDoUpdate({
        target: ClaxedoSessionMetaTable.session_id,
        set: {
          workspace_id: item.workspace_id ?? prev?.workspace_id ?? null,
          project_id: item.project_id ?? prev?.project_id ?? null,
          directory: item.directory || prev?.directory || "",
          title: item.title ?? prev?.title ?? null,
          parent_session_id: item.parent_session_id ?? prev?.parent_session_id ?? null,
          archived_at: item.archived_at,
          updated_at: Math.max(item.updated_at, prev?.updated_at ?? 0),
        },
      }).run()
    }
  })
}

export async function syncSessionMetas(ws: Workspace | undefined, input: unknown[]) {
  const rows = input.map((item) => row(item, ws))
  await upsertRows(rows)
  if (!ws?.id) return
  const incoming = ids(rows.flatMap((item) => item?.session_id ? [item.session_id] : []))
  const stale = ClaxedoDB.use((db) => db
    .select({ session_id: ClaxedoSessionMetaTable.session_id })
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.workspace_id, ws.id))
    .all()
    .map((item) => item.session_id)
    .filter((session_id) => !incoming.includes(session_id)))
  for (const sessionID of stale) await deleteSessionMeta(sessionID)
}

export async function syncSessionMeta(ws: Workspace | undefined, input: unknown) {
  await upsertRows([row(input, ws)])
}

export async function deleteSessionMeta(sessionID: string) {
  ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoSessionAttachmentTable).where(eq(ClaxedoSessionAttachmentTable.session_id, sessionID)).run()
    db.delete(ClaxedoSessionTagTable).where(eq(ClaxedoSessionTagTable.session_id, sessionID)).run()
    db.delete(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionID)).run()
  })
}

export async function putSessionMeta(
  sessionID: string,
  input: {
    ws?: Workspace
    directory?: string | null
    title?: string | null
    parentID?: string | null
    archived?: number | null
    tags?: string[]
    attachments?: SessionAttachment[]
  },
) {
  const stamp = now()
  ClaxedoDB.transaction((db) => {
    const prev = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionID)).get()
    db.insert(ClaxedoSessionMetaTable).values({
      session_id: sessionID,
      workspace_id: input.ws?.id ?? prev?.workspace_id ?? null,
      project_id: input.ws?.project_id ?? prev?.project_id ?? null,
      directory: input.directory ?? input.ws?.directory ?? prev?.directory ?? "",
      title: input.title === undefined ? prev?.title ?? null : input.title,
      parent_session_id: input.parentID === undefined ? prev?.parent_session_id ?? null : input.parentID,
      archived_at: input.archived === undefined ? prev?.archived_at ?? null : input.archived,
      created_at: prev?.created_at ?? stamp,
      updated_at: stamp,
    }).onConflictDoUpdate({
      target: ClaxedoSessionMetaTable.session_id,
      set: {
        workspace_id: input.ws?.id ?? prev?.workspace_id ?? null,
        project_id: input.ws?.project_id ?? prev?.project_id ?? null,
        directory: input.directory ?? input.ws?.directory ?? prev?.directory ?? "",
        title: input.title === undefined ? prev?.title ?? null : input.title,
        parent_session_id: input.parentID === undefined ? prev?.parent_session_id ?? null : input.parentID,
        archived_at: input.archived === undefined ? prev?.archived_at ?? null : input.archived,
        updated_at: stamp,
      },
    }).run()

    if (input.tags) {
      db.delete(ClaxedoSessionTagTable).where(eq(ClaxedoSessionTagTable.session_id, sessionID)).run()
      for (const tag of input.tags) {
        db.insert(ClaxedoSessionTagTable).values({
          session_id: sessionID,
          tag,
          created_at: stamp,
          updated_at: stamp,
        }).run()
      }
    }

    if (input.attachments) {
      db.delete(ClaxedoSessionAttachmentTable).where(eq(ClaxedoSessionAttachmentTable.session_id, sessionID)).run()
      for (const item of input.attachments) {
        db.insert(ClaxedoSessionAttachmentTable).values({
          session_id: sessionID,
          kind: item.kind,
          target_id: item.targetID,
          created_at: stamp,
          updated_at: stamp,
        }).run()
      }
    }
  })
}

export async function sessionMetas(input: string[]) {
  const hit = ids(input)
  if (!hit.length) return new Map<string, SessionMeta>()
  const meta = safeMetaRead("session metadata", [], () =>
    ClaxedoDB.use((db) => {
      const all = db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, hit)).all()
      const seen = new Set(all.map((item) => item.session_id))
      let queue = ids(all.map((item) => item.parent_session_id ?? ""))
      while (queue.length) {
        const extra = db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_id, queue)).all()
        if (!extra.length) break
        all.push(...extra.filter((item) => {
          if (seen.has(item.session_id)) return false
          seen.add(item.session_id)
          return true
        }))
        queue = ids(extra.map((item) => item.parent_session_id ?? "").filter((item) => !seen.has(item)))
      }
      return all
    }),
  )
  const tags = safeMetaRead("session tags", [], () =>
    ClaxedoDB.use((db) => db.select().from(ClaxedoSessionTagTable).where(inArray(ClaxedoSessionTagTable.session_id, hit)).all()),
  )
  const attachments = safeMetaRead("session attachments", [], () =>
    ClaxedoDB.use((db) => db.select().from(ClaxedoSessionAttachmentTable).where(inArray(ClaxedoSessionAttachmentTable.session_id, hit)).all()),
  )
  const by = new Map<string, SessionMeta>(
    meta.map((item) => [
      item.session_id,
      {
        sessionID: item.session_id,
        ...(item.workspace_id ? { workspaceID: item.workspace_id } : {}),
        ...(item.project_id ? { projectID: item.project_id } : {}),
        directory: item.directory,
        ...(item.title ? { title: item.title } : {}),
        ...(item.parent_session_id ? { parentID: item.parent_session_id } : {}),
        ...(item.archived_at ? { archived: item.archived_at } : {}),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        tags: [],
        attachments: [],
      },
    ]),
  )
  for (const item of tags) {
    const row = by.get(item.session_id)
    if (!row) continue
    row.tags.push(item.tag)
  }
  for (const item of attachments) {
    const row = by.get(item.session_id)
    if (!row) continue
    row.attachments.push({
      kind: item.kind as SessionAttachment["kind"],
      targetID: item.target_id,
    })
  }
  const links = new Map<string, { parentID?: string }>(
    [...by.values()].map((item) => [item.sessionID, { ...(item.parentID ? { parentID: item.parentID } : {}) }]),
  )
  for (const item of by.values()) {
    item.rootID = root(item.sessionID, links)
    item.tags.sort()
    item.attachments.sort((a, b) => `${a.kind}:${a.targetID}`.localeCompare(`${b.kind}:${b.targetID}`))
  }
  return by
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
    const set = grouped.get(item.session_id) ?? new Set<string>()
    set.add(item.tag)
    grouped.set(item.session_id, set)
  }
  const rows = [...grouped.entries()]
    .filter(([, set]) => all.every((tag) => set.has(tag)))
    .map(([sessionID]) => sessionID)
  const meta = await sessionMetas(rows)
  return rows
    .map((sessionID) => meta.get(sessionID))
    .filter((item): item is SessionMeta => !!item)
    .filter((item) => input?.includeHidden || item.tags.includes(GLOBAL_SHOW_TAG))
    .sort((a, b) => b.updatedAt - a.updatedAt)
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
    .map((item) => item.session_id)
  const meta = await sessionMetas(hit)
  return hit
    .map((item) => meta.get(item))
    .filter((item): item is SessionMeta => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function parseSessionMeta(input: unknown) {
  const row = rec(input)
  const next = {
    ...(row && "title" in row ? { title: txt(row.title) ?? null } : {}),
    ...(row && "parentID" in row ? { parentID: txt(row.parentID) ?? null } : {}),
    ...(row && "tags" in row ? { tags: tags(row.tags) ?? [] } : {}),
    ...(row && "attachments" in row ? { attachments: attachments(row.attachments) ?? [] } : {}),
  }
  return next
}

export function applySessionMeta(input: Array<Record<string, unknown>>) {
  const ids = input.map((item) => txt(item.id)).filter((item): item is string => !!item)
  return sessionMetas(ids).then((meta) => {
    const links = new Map(
      [
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
      ],
    )
    return input.map((item) => {
      const id = txt(item.id)
      if (!id) return item
      const hit = meta.get(id)
      const parentID = txt(item.parentID) ?? hit?.parentID
      const archived = rec(item.time)?.archived ?? hit?.archived
      return {
        ...item,
        ...(hit?.projectID ? { projectID: hit.projectID } : {}),
        ...(parentID ? { parentID } : {}),
        rootID: root(id, links),
        ...(archived !== undefined ? { time: { ...(rec(item.time) ?? {}), archived } } : {}),
        tags: hit?.tags ?? [],
        attachments: hit?.attachments ?? [],
      }
    })
  })
}
