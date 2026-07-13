import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  authorizeWorkspaceForUser,
  projectByPublicId,
  serviceMutation,
  upsertServiceUser,
  upsertUser,
  workspaceByPublicId,
} from "./model"
import { enqueueIndependentSessionIntake } from "./workgraphBackground"
import type { Id } from "./_generated/dataModel"

const sessionVisibility = v.object({
  session_id: v.string(),
  project_id: v.optional(v.string()),
  title: v.optional(v.string()),
  directory_hint: v.optional(v.string()),
  created_at: v.optional(v.number()),
  updated_at: v.optional(v.number()),
})
const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function directoryHint(input: string | undefined) {
  const hint = input?.trim()
  if (!hint) return undefined
  if (
    hint === "." ||
    hint === ".." ||
    hint.startsWith("~") ||
    hint.includes("/") ||
    hint.includes("\\") ||
    hint.includes(":")
  ) {
    throw new Error("Invalid directory hint")
  }
  return hint.slice(0, 120)
}

async function writableWorkspace(ctx: any, workspaceId: string) {
  const user = await upsertUser(ctx)
  const workspace = await workspaceByPublicId(ctx.db, workspaceId)
  if (!workspace || !(await authorizeWorkspace(ctx, workspace, "write"))) throw new Error("Workspace not found")
  return { user, workspace }
}

async function writableWorkspaceForUser(ctx: any, user: { _id: unknown }, workspaceId: string) {
  const workspace = await workspaceByPublicId(ctx.db, workspaceId)
  if (!workspace || !(await authorizeWorkspaceForUser(ctx, workspace, user, "write")))
    throw new Error("Workspace not found")
  return { user, workspace }
}

async function upsertVisibilityRows(
  ctx: any,
  input: {
    user: Record<string, unknown>
    workspace: Record<string, unknown>
    sessions: Array<{
      session_id: string
      project_id?: string
      title?: string
      directory_hint?: string
      created_at?: number
      updated_at?: number
    }>
  },
) {
  for (const session of input.sessions) {
    const now = Date.now()
    const existing = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", session.session_id))
      .unique()
    if (existing && existing.workspace_id !== input.workspace._id) throw new Error("Session not found")
    const hint = directoryHint(session.directory_hint)
    const projectId = await sessionProjectId(ctx, input.workspace, session.project_id)
    const patch = {
      project_id: projectId,
      title: session.title,
      directory_hint: hint,
      updated_at: session.updated_at ?? now,
      deleted_at: undefined,
    }
    if (existing) {
      await ctx.db.patch(existing._id, patch)
      continue
    }
    await ctx.db.insert("session_history", {
      session_id: session.session_id,
      workspace_id: input.workspace._id,
      project_id: projectId,
      created_by_user_id: input.user._id,
      title: session.title,
      directory_hint: hint,
      created_at: session.created_at ?? now,
      updated_at: session.updated_at ?? now,
    })
  }
}

async function sessionProjectId(ctx: any, workspace: Record<string, unknown>, projectId: string | undefined) {
  const publicProjectId = projectId ?? (typeof workspace.project_id === "string" ? workspace.project_id : undefined)
  if (!publicProjectId) return undefined
  return (await projectByPublicId(ctx.db, publicProjectId))?._id
}

async function publicProjectId(ctx: any, projectId: unknown) {
  if (!projectId) return undefined
  const project = await ctx.db.get(projectId as never)
  return typeof project?.project_id === "string" ? project.project_id : undefined
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function messageId(input: unknown, sessionId: string, ordinal: number) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.id) ?? txt(info?.id) ?? `${sessionId}:${ordinal}`
}

function messageRole(input: unknown) {
  const row = rec(input)
  const info = rec(row?.info)
  return txt(row?.role) ?? txt(info?.role)
}

function jsonValue(input: unknown) {
  try {
    return JSON.parse(JSON.stringify(input))
  } catch {
    return { info: { id: "invalid", role: "unknown" }, parts: [] }
  }
}

function jsonText(input: unknown) {
  try {
    return JSON.stringify(input) ?? "null"
  } catch {
    return "null"
  }
}

async function ensureSessionHistoryRow(
  ctx: any,
  input: {
    user: Record<string, unknown>
    workspace: Record<string, unknown>
    session_id: string
  },
) {
  const existing = await ctx.db
    .query("session_history")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", input.session_id))
    .unique()
  if (existing && existing.workspace_id !== input.workspace._id) throw new Error("Session not found")
  if (existing) {
    if (existing.deleted_at) await ctx.db.patch(existing._id, { deleted_at: undefined })
    return
  }
  const now = Date.now()
  await ctx.db.insert("session_history", {
    session_id: input.session_id,
    workspace_id: input.workspace._id,
    created_by_user_id: input.user._id,
    created_at: now,
    updated_at: now,
  })
}

async function deleteMessageRows(ctx: any, sessionId: string, workspaceId: unknown) {
  const rows = await ctx.db
    .query("session_messages")
    .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", sessionId))
    .collect()
  for (const row of rows.filter((row: any) => row.workspace_id === workspaceId)) {
    await ctx.db.delete(row._id)
  }
}

async function syncMessageRows(
  ctx: any,
  input: {
    user: Record<string, unknown>
    workspace: Record<string, unknown>
    session_id: string
    messages: unknown[]
  },
) {
  await ensureSessionHistoryRow(ctx, {
    user: input.user,
    workspace: input.workspace,
    session_id: input.session_id,
  })
  const existingRows = (
    await ctx.db
      .query("session_messages")
      .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", input.session_id))
      .collect()
  ).filter((row: any) => row.workspace_id === input.workspace._id)
  const usedRows = new Set<string>()
  const incomingIds = new Set<string>()
  const now = Date.now()
  for (let ordinal = 0; ordinal < input.messages.length; ordinal += 1) {
    const message = input.messages[ordinal]
    const id = messageId(message, input.session_id, ordinal)
    const role = messageRole(message)
    const data = jsonValue(message)
    incomingIds.add(id)
    const existing = existingRows.find((row: any) => row.message_id === id && !usedRows.has(row._id))
    if (existing) {
      usedRows.add(existing._id)
      if (existing.ordinal !== ordinal || existing.role !== role || jsonText(existing.data) !== jsonText(data)) {
        await ctx.db.patch(existing._id, {
          role,
          ordinal,
          data,
          updated_at: now,
        })
      }
      continue
    }
    await ctx.db.insert("session_messages", {
      session_id: input.session_id,
      workspace_id: input.workspace._id,
      message_id: id,
      role,
      ordinal,
      data,
      created_at: now,
      updated_at: now,
    })
  }
  for (const row of existingRows.filter((row: any) => !incomingIds.has(row.message_id))) {
    await ctx.db.delete(row._id)
  }
  const summary = [...input.messages].reverse().find((message) => messageRole(message) === "assistant")
  const summaryText = messageText(summary)
  const meaningful =
    input.messages.some((message) => messageRole(message) === "user" && messageText(message)) && summaryText
  if (meaningful && typeof input.user._id === "string") {
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (query: any) => query.eq("session_id", input.session_id))
      .unique()
    await enqueueIndependentSessionIntake(ctx, {
      ownerUserId: input.user._id as Id<"users">,
      sessionId: input.session_id,
      title: typeof session?.title === "string" && session.title.trim() ? session.title.trim() : "AI work session",
      summary: summaryText.slice(0, 8_000),
      observedAt: now,
    })
  }
}

function messageText(input: unknown) {
  const row = rec(input)
  return (Array.isArray(row?.parts) ? row.parts : [])
    .flatMap((part) => {
      const value = rec(part)
      return value?.type === "text" && typeof value.text === "string" && !value.ignored ? [value.text.trim()] : []
    })
    .filter(Boolean)
    .join("\n")
}

async function authorizeReadSession(
  ctx: any,
  args: {
    session_id: string
    workspace_id: string
  },
) {
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace) return { allowed: false } as const
  const session = await ctx.db
    .query("session_history")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
    .unique()
  if (!session || session.workspace_id !== workspace._id || session.deleted_at) return { allowed: false } as const
  const role = await authorizeWorkspace(ctx, workspace, "read")
  return role ? ({ allowed: true, role, workspace } as const) : ({ allowed: false } as const)
}

export const authorizeRead = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    return await authorizeReadSession(ctx, args)
  },
})

export const list = authedQuery({
  args: {
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspace(ctx, workspace, "read"))) return []
    return await Promise.all(
      (
        await ctx.db
          .query("session_history")
          .withIndex("by_workspace_updated", (q) => q.eq("workspace_id", workspace._id))
          .collect()
      )
        .filter((session) => !session.deleted_at)
        .sort((a, b) => b.updated_at - a.updated_at)
        .map(async (session) => {
          const projectId = await publicProjectId(ctx, session.project_id)
          return {
            session_id: session.session_id,
            ...(projectId ? { project_id: projectId } : {}),
            title: session.title,
            directory_hint: session.directory_hint,
            created_at: session.created_at,
            updated_at: session.updated_at,
          }
        }),
    )
  },
})

export const readMessages = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await authorizeReadSession(ctx, args)
    if (!result.allowed) return { allowed: false, messages: [] }
    const messages = await ctx.db
      .query("session_messages")
      .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    return {
      allowed: true,
      role: result.role,
      messages: messages
        .filter((message: any) => message.workspace_id === result.workspace._id)
        .sort((a: any, b: any) => a.ordinal - b.ordinal)
        .map((message: any) => message.data),
    }
  },
})

export const syncMessages = authedMutation({
  args: {
    workspace_id: v.string(),
    session_id: v.string(),
    messages: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    await syncMessageRows(ctx, {
      ...(await writableWorkspace(ctx, args.workspace_id)),
      session_id: args.session_id,
      messages: args.messages,
    })
    return { ok: true }
  },
})

export const syncMessagesForService = serviceMutation({
  args: {
    user: serviceUser,
    workspace_id: v.string(),
    session_id: v.string(),
    messages: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    await syncMessageRows(ctx, {
      ...(await writableWorkspaceForUser(ctx, await upsertServiceUser(ctx, args.user), args.workspace_id)),
      session_id: args.session_id,
      messages: args.messages,
    })
    return { ok: true }
  },
})

export const upsertVisibility = authedMutation({
  args: {
    workspace_id: v.string(),
    sessions: v.array(sessionVisibility),
  },
  handler: async (ctx, args) => {
    const access = await writableWorkspace(ctx, args.workspace_id)
    await upsertVisibilityRows(ctx, {
      ...access,
      sessions: args.sessions,
    })
    return { ok: true }
  },
})

export const upsertVisibilityForService = serviceMutation({
  args: {
    user: serviceUser,
    workspace_id: v.string(),
    sessions: v.array(sessionVisibility),
  },
  handler: async (ctx, args) => {
    await upsertVisibilityRows(ctx, {
      ...(await writableWorkspaceForUser(ctx, await upsertServiceUser(ctx, args.user), args.workspace_id)),
      sessions: args.sessions,
    })
    return { ok: true }
  },
})

export const replaceVisibility = authedMutation({
  args: {
    workspace_id: v.string(),
    sessions: v.array(sessionVisibility),
  },
  handler: async (ctx, args) => {
    const access = await writableWorkspace(ctx, args.workspace_id)
    await upsertVisibilityRows(ctx, {
      ...access,
      sessions: args.sessions,
    })
    const incoming = new Set(args.sessions.map((session) => session.session_id))
    const now = Date.now()
    const rows = await ctx.db
      .query("session_history")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace_id", access.workspace._id))
      .collect()
    for (const row of rows.filter((row: any) => !incoming.has(row.session_id) && !row.deleted_at)) {
      await ctx.db.patch(row._id, {
        deleted_at: now,
        updated_at: now,
      })
      await deleteMessageRows(ctx, row.session_id, access.workspace._id)
    }
    return { ok: true }
  },
})

export const replaceVisibilityForService = serviceMutation({
  args: {
    user: serviceUser,
    workspace_id: v.string(),
    sessions: v.array(sessionVisibility),
  },
  handler: async (ctx, args) => {
    const access = await writableWorkspaceForUser(ctx, await upsertServiceUser(ctx, args.user), args.workspace_id)
    await upsertVisibilityRows(ctx, {
      ...access,
      sessions: args.sessions,
    })
    const incoming = new Set(args.sessions.map((session) => session.session_id))
    const now = Date.now()
    const rows = await ctx.db
      .query("session_history")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace_id", access.workspace._id))
      .collect()
    for (const row of rows.filter((row: any) => !incoming.has(row.session_id) && !row.deleted_at)) {
      await ctx.db.patch(row._id, {
        deleted_at: now,
        updated_at: now,
      })
      await deleteMessageRows(ctx, row.session_id, access.workspace._id)
    }
    return { ok: true }
  },
})

export const deleteVisibility = authedMutation({
  args: {
    workspace_id: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await writableWorkspace(ctx, args.workspace_id)
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .unique()
    if (!session || session.workspace_id !== access.workspace._id) return { ok: true }
    await ctx.db.patch(session._id, {
      deleted_at: Date.now(),
      updated_at: Date.now(),
    })
    await deleteMessageRows(ctx, args.session_id, access.workspace._id)
    return { ok: true }
  },
})

export const deleteVisibilityForService = serviceMutation({
  args: {
    user: serviceUser,
    workspace_id: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await writableWorkspaceForUser(ctx, await upsertServiceUser(ctx, args.user), args.workspace_id)
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .unique()
    if (!session || session.workspace_id !== access.workspace._id) return { ok: true }
    await ctx.db.patch(session._id, {
      deleted_at: Date.now(),
      updated_at: Date.now(),
    })
    await deleteMessageRows(ctx, args.session_id, access.workspace._id)
    return { ok: true }
  },
})
