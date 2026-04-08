import { ClaxedoDB, eq } from "../storage/db"
import { ClaxedoCloudMessageTable, ClaxedoCloudSessionTable } from "../storage/cloud-session.sql"
import type { Workspace } from "../workspace-store"

function now() {
  return Date.now()
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function num(input: unknown, alt: number) {
  return typeof input === "number" && Number.isFinite(input) ? input : alt
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function time(input: unknown) {
  const row = rec(input)
  const val = rec(row?.time)
  const created = num(val?.created, now())
  const updated = num(val?.updated, created)
  return { created, updated }
}

function title(input: unknown) {
  const row = rec(input)
  return txt(row?.title) ?? txt(row?.slug) ?? null
}

function sessionId(input: unknown) {
  const row = rec(input)
  return txt(row?.id)
}

function role(input: unknown) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.role) ?? txt(info?.role) ?? null
}

function messageId(input: unknown, session_id: string, ordinal: number) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.id) ?? txt(info?.id) ?? `${session_id}:${ordinal}`
}

function cloud(ws: Workspace) {
  return ws.kind === "cloud"
}

export async function syncCloudSessions(ws: Workspace, sessions: unknown[]) {
  if (!cloud(ws)) return
  const stamp = now()
  const rows = sessions
    .map((item) => {
      const session_id = sessionId(item)
      if (!session_id) return
      const meta = time(item)
      return {
        session_id,
        workspace_id: ws.id,
        project_id: ws.project_id ?? null,
        directory: ws.directory,
        title: title(item),
        provider: ws.provider ?? null,
        repo_name: ws.repo_name ?? null,
        git_branch: ws.git_branch ?? null,
        git_remote: ws.git_remote ?? null,
        data: JSON.stringify(item),
        created_at: meta.created,
        updated_at: Math.max(meta.updated, stamp),
        deleted_at: null,
      }
    })
    .filter((item): item is Exclude<typeof item, undefined> => !!item)
  const seen = new Set(rows.map((item) => item.session_id))

  ClaxedoDB.transaction((db) => {
    const stale = db
      .select({ session_id: ClaxedoCloudSessionTable.session_id })
      .from(ClaxedoCloudSessionTable)
      .where(eq(ClaxedoCloudSessionTable.workspace_id, ws.id))
      .all()
      .map((item) => item.session_id)
      .filter((item) => !seen.has(item))

    for (const row of rows) {
      db.insert(ClaxedoCloudSessionTable).values(row).onConflictDoUpdate({
        target: ClaxedoCloudSessionTable.session_id,
        set: {
          workspace_id: row.workspace_id,
          project_id: row.project_id,
          directory: row.directory,
          title: row.title,
          provider: row.provider,
          repo_name: row.repo_name,
          git_branch: row.git_branch,
          git_remote: row.git_remote,
          data: row.data,
          updated_at: row.updated_at,
          deleted_at: null,
        },
      }).run()
    }

    if (stale.length === 0) return

    for (const session_id of stale) {
      db
        .update(ClaxedoCloudSessionTable)
        .set({
          deleted_at: stamp,
          updated_at: stamp,
        })
        .where(eq(ClaxedoCloudSessionTable.session_id, session_id))
        .run()
      db.delete(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.session_id, session_id)).run()
    }
  })
}

export async function syncCloudSession(ws: Workspace, session: unknown) {
  await syncCloudSessions(ws, [session])
}

export async function deleteCloudSession(ws: Workspace, session_id: string) {
  if (!cloud(ws)) return
  const stamp = now()
  ClaxedoDB.transaction((db) => {
    db
      .insert(ClaxedoCloudSessionTable)
      .values({
        session_id,
        workspace_id: ws.id,
        project_id: ws.project_id ?? null,
        directory: ws.directory,
        title: null,
        provider: ws.provider ?? null,
        repo_name: ws.repo_name ?? null,
        git_branch: ws.git_branch ?? null,
        git_remote: ws.git_remote ?? null,
        data: "{}",
        created_at: stamp,
        updated_at: stamp,
        deleted_at: stamp,
      })
      .onConflictDoUpdate({
        target: ClaxedoCloudSessionTable.session_id,
        set: {
          project_id: ws.project_id ?? null,
          repo_name: ws.repo_name ?? null,
          git_branch: ws.git_branch ?? null,
          git_remote: ws.git_remote ?? null,
          deleted_at: stamp,
          updated_at: stamp,
        },
      })
      .run()

    db.delete(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.session_id, session_id)).run()
  })
}

export async function syncCloudMessages(ws: Workspace, session_id: string, messages: unknown[]) {
  if (!cloud(ws)) return
  const stamp = now()
  const rows = messages.map((item, ordinal) => ({
    message_id: messageId(item, session_id, ordinal),
    session_id,
    workspace_id: ws.id,
    role: role(item),
    ordinal,
    data: JSON.stringify(item),
    created_at: stamp,
    updated_at: stamp,
  }))

  ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoCloudMessageTable).where(eq(ClaxedoCloudMessageTable.session_id, session_id)).run()
    for (const row of rows) {
      db.insert(ClaxedoCloudMessageTable).values(row).run()
    }
  })
}
