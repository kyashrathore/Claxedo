import { ClaxedoDB, eq, inArray } from "../../adapters/storage/db"
import {
  ClaxedoSessionAttachmentTable,
  ClaxedoSessionMetaTable,
  ClaxedoSessionTagTable,
} from "../../adapters/storage/session-meta.sql"
import { GLOBAL_SHOW_TAG } from "./types"
import type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
  SessionToolSandbox,
} from "./types"
import {
  host,
  ids,
  now,
  rec,
  root,
  serializeToolSandbox,
  sessionMetaSyncRow,
  storedSessionRef,
  txt,
} from "./shape"
import {
  safeMetaRead,
  sessionMetaMapByRef,
  sessionMetaMapBySessionId,
} from "./read"
import type { Workspace } from "../../workspace/store"

export { GLOBAL_TAG, GLOBAL_SHOW_TAG } from "./types"
export type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
  SessionToolSandbox,
} from "./types"
export { parseSessionMeta } from "./shape"

export async function syncSessionMetas(ws: Workspace | undefined, input: unknown[]) {
  const rows = input.map((item) => sessionMetaSyncRow(item, ws))
  await upsertRows(rows)
  if (!ws?.id) return
  const incoming = ids(rows.flatMap((item) => item?.session_ref ? [item.session_ref] : []))
  const stale = ClaxedoDB.use((db) => db
    .select({ session_ref: ClaxedoSessionMetaTable.session_ref })
    .from(ClaxedoSessionMetaTable)
    .where(eq(ClaxedoSessionMetaTable.workspace_id, ws.id))
    .all()
    .map((item) => item.session_ref)
    .filter((session_ref) => !incoming.includes(session_ref)))
  for (const sessionRef of stale) await deleteSessionMetaRef(sessionRef)
}

export async function syncSessionMeta(ws: Workspace | undefined, input: unknown) {
  await upsertRows([sessionMetaSyncRow(input, ws)])
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
    workspaceID?: string | null
    directory?: string | null
    host?: "central" | "workspace"
    toolSandbox?: SessionToolSandbox | null
    model?: { providerID: string; modelID: string } | null
    title?: string | null
    parentID?: string | null
    archived?: number | null
    tags?: string[]
    attachments?: SessionAttachment[]
  },
) {
  const stamp = now()
  ClaxedoDB.transaction((db) => {
    const prevByID = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_id, sessionID)).get()
    const workspaceID = input.workspaceID === undefined
      ? input.ws?.id ?? prevByID?.workspace_id ?? null
      : input.workspaceID
    const hostValue = input.host ?? host(prevByID?.host) ?? "workspace"
    const directory = input.directory ?? input.ws?.directory ?? prevByID?.directory ?? null
    const sessionRef = storedSessionRef({
      session_id: sessionID,
      workspace_id: workspaceID,
      directory,
      host: hostValue,
    })
    const prev = db.select().from(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_ref, sessionRef)).get() ?? prevByID
    const toolSandbox = input.toolSandbox === undefined
      ? prev?.tool_sandbox ?? null
      : serializeToolSandbox(input.toolSandbox)
    const modelProviderID = input.model === undefined ? prev?.model_provider_id ?? null : input.model?.providerID ?? null
    const modelID = input.model === undefined ? prev?.model_id ?? null : input.model?.modelID ?? null
    db.insert(ClaxedoSessionMetaTable).values({
      session_ref: sessionRef,
      session_id: sessionID,
      workspace_id: workspaceID,
      project_id: input.ws?.project_id ?? prev?.project_id ?? null,
      host: hostValue,
      directory,
      tool_sandbox: toolSandbox,
      model_provider_id: modelProviderID,
      model_id: modelID,
      title: input.title === undefined ? prev?.title ?? null : input.title,
      parent_session_id: input.parentID === undefined ? prev?.parent_session_id ?? null : input.parentID,
      archived_at: input.archived === undefined ? prev?.archived_at ?? null : input.archived,
      created_at: prev?.created_at ?? stamp,
      updated_at: stamp,
    }).onConflictDoUpdate({
      target: ClaxedoSessionMetaTable.session_ref,
      set: {
        session_id: sessionID,
        workspace_id: workspaceID,
        project_id: input.ws?.project_id ?? prev?.project_id ?? null,
        host: hostValue,
        directory,
        tool_sandbox: toolSandbox,
        model_provider_id: modelProviderID,
        model_id: modelID,
        title: input.title === undefined ? prev?.title ?? null : input.title,
        parent_session_id: input.parentID === undefined ? prev?.parent_session_id ?? null : input.parentID,
        archived_at: input.archived === undefined ? prev?.archived_at ?? null : input.archived,
        updated_at: stamp,
      },
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
  })
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

export async function listSessionNavigationMetas(input: SessionMetaNavigationListInput) {
  const where: string[] = []
  const params: Array<string | number> = []
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
  if (input.cursor) {
    where.push("(m.updated_at < ? OR (m.updated_at = ? AND m.session_ref < ?))")
    params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.sessionRef ?? input.cursor.sessionID)
  }

  const rows = safeMetaRead("session navigation list", [], () =>
    ClaxedoDB.raw()
      .prepare(`
        SELECT m.session_ref
        FROM claxedo_session_meta m
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY m.updated_at DESC, m.session_ref DESC
        LIMIT ?
      `)
      .all(...params, Math.max(0, input.limit)) as Array<{ session_ref: string }>,
  )
  const hit = rows.map((item) => item.session_ref)
  const meta = await sessionMetaMapByRef(hit)
  return hit
    .map((item) => meta.get(item))
    .filter((item): item is SessionMeta => !!item)
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

async function upsertRows(rows: Array<ReturnType<typeof sessionMetaSyncRow>>) {
  const all = rows.filter((item): item is Exclude<typeof item, undefined> => !!item)
  if (!all.length) return
  const hit = ids(all.map((item) => item.session_ref))
  ClaxedoDB.transaction((db) => {
    const old = new Map(
      (hit.length
        ? db.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_ref, hit)).all()
        : [])
        .map((item) => [item.session_ref, item]),
    )
    for (const item of all) {
      const prev = old.get(item.session_ref)
      db.insert(ClaxedoSessionMetaTable).values({
        session_ref: item.session_ref,
        session_id: item.session_id,
        workspace_id: item.workspace_id ?? prev?.workspace_id ?? null,
        project_id: item.project_id ?? prev?.project_id ?? null,
        host: item.host ?? host(prev?.host) ?? "workspace",
        directory: item.directory ?? prev?.directory ?? null,
        tool_sandbox: item.tool_sandbox ?? prev?.tool_sandbox ?? null,
        model_provider_id: item.model_provider_id ?? prev?.model_provider_id ?? null,
        model_id: item.model_id ?? prev?.model_id ?? null,
        title: item.title ?? prev?.title ?? null,
        parent_session_id: item.parent_session_id ?? prev?.parent_session_id ?? null,
        archived_at: item.archived_at,
        created_at: prev?.created_at ?? item.created_at,
        updated_at: Math.max(item.updated_at, prev?.updated_at ?? 0),
      }).onConflictDoUpdate({
        target: ClaxedoSessionMetaTable.session_ref,
        set: {
          session_id: item.session_id,
          workspace_id: item.workspace_id ?? prev?.workspace_id ?? null,
          project_id: item.project_id ?? prev?.project_id ?? null,
          host: item.host ?? host(prev?.host) ?? "workspace",
          directory: item.directory ?? prev?.directory ?? null,
          tool_sandbox: item.tool_sandbox ?? prev?.tool_sandbox ?? null,
          model_provider_id: item.model_provider_id ?? prev?.model_provider_id ?? null,
          model_id: item.model_id ?? prev?.model_id ?? null,
          title: item.title ?? prev?.title ?? null,
          parent_session_id: item.parent_session_id ?? prev?.parent_session_id ?? null,
          archived_at: item.archived_at,
          updated_at: Math.max(item.updated_at, prev?.updated_at ?? 0),
        },
      }).run()
    }
  })
}

async function deleteSessionMetaRef(sessionRef: string) {
  ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoSessionAttachmentTable).where(eq(ClaxedoSessionAttachmentTable.session_ref, sessionRef)).run()
    db.delete(ClaxedoSessionTagTable).where(eq(ClaxedoSessionTagTable.session_ref, sessionRef)).run()
    db.delete(ClaxedoSessionMetaTable).where(eq(ClaxedoSessionMetaTable.session_ref, sessionRef)).run()
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
