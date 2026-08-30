import { v } from "convex/values"
import { MASTER_SESSION_PREFIX, RUN_SESSION_PREFIX } from "@claxedo/workgraph/contracts"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspace,
  authorizeWorkspaceForUser,
  orgAdminForUser,
  orgMembership,
  projectByPublicId,
  readUser,
  serviceMutation,
  serviceQuery,
  upsertServiceUser,
  upsertUser,
  userByTokenIdentifier,
  workspaceByPublicId,
} from "./model"
import { recordLlmTurnFact } from "./usageMetering"
import { enqueueIndependentSessionIntake } from "./workgraphBackground"
import { requireTrustedWorkGraphTenantSubject } from "./workgraphModel"
import { sessionRoleForUser } from "./sessionAccess"
import type { Doc, Id } from "./_generated/dataModel"

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

export function createUserLookupCache(get: (userId: Id<"users">) => Promise<Doc<"users"> | null>) {
  const users = new Map<Id<"users">, Promise<Doc<"users"> | null>>()
  return (userId: Id<"users">) => {
    const cached = users.get(userId)
    if (cached) return cached
    const lookup = get(userId)
    users.set(userId, lookup)
    return lookup
  }
}

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

async function requireSessionParticipantAdmin(ctx: any, args: { session_id: string; workspace_id: string }) {
  const actor = await readUser(ctx)
  const [workspace, session] = await Promise.all([
    workspaceByPublicId(ctx.db, args.workspace_id),
    ctx.db
      .query("session_history")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .unique(),
  ])
  if (!workspace || !session || session.workspace_id !== workspace._id || session.deleted_at) {
    throw new Error("Session not found")
  }
  if (!(await authorizeWorkspaceForUser(ctx, workspace, actor, "read"))) {
    throw new Error("session_participant_admin_required")
  }
  if (session.created_by_user_id !== actor._id && !(await orgAdminForUser(ctx.db, actor._id, workspace.org_id))) {
    throw new Error("session_participant_admin_required")
  }
  return { actor, workspace, session }
}

async function upsertVisibilityRows(
  ctx: any,
  input: {
    user: Record<string, unknown> & { _id: unknown }
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
    if (
      existing &&
      existing.created_by_user_id !== input.user._id &&
      !(await sessionRoleForUser(ctx, {
        user: input.user,
        workspace: input.workspace,
        session: existing,
        action: "write",
      }))
    )
      throw new Error("Session not found")
    const hint = directoryHint(session.directory_hint)
    const projectId = await sessionProjectId(ctx, input.workspace, session.project_id)
    const patch = {
      org_id: input.workspace.org_id,
      project_id: projectId,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(hint === undefined ? {} : { directory_hint: hint }),
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
      org_id: input.workspace.org_id,
      project_id: projectId,
      created_by_user_id: input.user._id,
      title: session.title,
      directory_hint: hint,
      created_at: session.created_at ?? now,
      updated_at: session.updated_at ?? now,
    })
    await ctx.db.insert("session_participants", {
      session_id: session.session_id,
      workspace_id: input.workspace._id,
      user_id: input.user._id,
      added_by_user_id: input.user._id,
      created_at: now,
    })
  }
}

async function sessionProjectId(ctx: any, workspace: Record<string, unknown>, projectId: string | undefined) {
  const workspaceProjectId = typeof workspace.project_id === "string" ? workspace.project_id : undefined
  if (projectId && workspaceProjectId && projectId !== workspaceProjectId) {
    throw new Error("Session project must match workspace project")
  }
  const publicProjectId = workspaceProjectId ?? projectId
  if (!publicProjectId) return undefined
  const project = await projectByPublicId(ctx.db, publicProjectId, workspace.org_id)
  if (!project) throw new Error("Workspace project not found")
  return project.project_id
}

function publicProjectId(projectId: unknown) {
  return typeof projectId === "string" ? projectId : undefined
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

function producerAuthorId(input: unknown, user: { _id: unknown; public_id?: unknown }) {
  const row = rec(input)
  const info = rec(row?.info)
  const claxedo = rec(info?.claxedo)
  const author = rec(claxedo?.author)
  const publicId = txt(author?.id)
  return publicId && publicId === user.public_id ? user._id : undefined
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

function messageWithPublicAuthor(input: unknown, user?: Record<string, unknown> | null) {
  const row = rec(input)
  const info = rec(row?.info)
  if (!row || !info || info.role !== "user") return input
  const publicId = txt(user?.public_id)
  const name = txt(user?.name) ?? txt(user?.email) ?? (user?.kind === "agent" ? "Agent" : "User")
  const claxedo = rec(info.claxedo) ?? {}
  const { author: _untrustedAuthor, ...safeClaxedo } = claxedo
  const { claxedo: _untrustedClaxedo, ...safeInfo } = info
  const canonicalClaxedo = publicId
    ? {
        ...safeClaxedo,
        author: {
          id: publicId,
          name,
          kind: user?.kind === "agent" ? "agent" : "human",
          ...(txt(user?.image_url) ? { avatarUrl: txt(user?.image_url) } : {}),
        },
      }
    : safeClaxedo
  return {
    ...row,
    info: {
      ...safeInfo,
      ...(Object.keys(canonicalClaxedo).length > 0 ? { claxedo: canonicalClaxedo } : {}),
    },
  }
}

async function ensureSessionHistoryRow(
  ctx: any,
  input: {
    user: Record<string, unknown> & { _id: unknown }
    workspace: Record<string, unknown>
    session_id: string
    existing?: Record<string, any> | null
  },
) {
  const existing = input.existing
  if (existing) {
    if (
      (existing.org_id && input.workspace.org_id && existing.org_id !== input.workspace.org_id) ||
      (existing.project_id && input.workspace.project_id && existing.project_id !== input.workspace.project_id)
    ) {
      throw new Error("Session tenant identity conflicts with workspace")
    }
    if (
      existing.deleted_at ||
      (!existing.org_id && input.workspace.org_id) ||
      (!existing.project_id && input.workspace.project_id)
    ) {
      await ctx.db.patch(existing._id, {
        ...(existing.deleted_at ? { deleted_at: undefined } : {}),
        ...(!existing.org_id && input.workspace.org_id ? { org_id: input.workspace.org_id } : {}),
        ...(!existing.project_id && input.workspace.project_id ? { project_id: input.workspace.project_id } : {}),
      })
    }
    return
  }
  const now = Date.now()
  await ctx.db.insert("session_history", {
    session_id: input.session_id,
    workspace_id: input.workspace._id,
    org_id: input.workspace.org_id,
    project_id: input.workspace.project_id,
    created_by_user_id: input.user._id,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("session_participants", {
    session_id: input.session_id,
    workspace_id: input.workspace._id,
    user_id: input.user._id,
    added_by_user_id: input.user._id,
    created_at: now,
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

/**
 * Meter the WorkGraph turns a transcript sync carries. Hosted Runs execute in
 * sandbox workspace-runtimes behind the relay — no central session runtime
 * observes their `message.updated` events — so the transcript pull that lands
 * here is the one place the authority sees their completed assistant turns.
 * Each is recorded through the same dedup-keyed writer as the signed metering
 * boundary, so repeated snapshot pulls of the same transcript never
 * double-count a message.
 */
async function meterWorkGraphTranscriptTurns(
  ctx: any,
  input: {
    user: Record<string, unknown>
    workspace: Record<string, unknown>
    session_id: string
    messages: unknown[]
  },
) {
  const isRun = input.session_id.startsWith(RUN_SESSION_PREFIX)
  if (!isRun && !input.session_id.startsWith(MASTER_SESSION_PREFIX)) return
  const organization = input.workspace.org_id ? await ctx.db.get(input.workspace.org_id) : undefined
  if (!organization) return
  // `llm_usage_events.org_id` is the W5 metering id space: the Clerk org id
  // string, falling back to the document id for personal orgs (which have no
  // Clerk id).
  const meteringOrgId = txt(organization.clerk_org_id) ?? String(input.workspace.org_id)
  const meteringUserId = txt(input.user.clerk_subject) ?? txt(input.user.token_identifier)
  if (!meteringUserId) return
  const attribution = isRun
    ? await (async () => {
        const runId = input.session_id.slice(RUN_SESSION_PREFIX.length)
        const run = await ctx.db
          .query("workgraph_runs")
          .withIndex("by_tenant_id", (query: any) =>
            query
              .eq("organization_id", input.workspace.org_id)
              .eq("owner_user_id", input.workspace.owner_user_id)
              .eq("id", runId),
          )
          .unique()
        return run
          ? { stream_id: run.stream_id as string, run_id: run.id as string, work_item_id: run.work_item_id as string }
          : undefined
      })()
    : { stream_id: input.session_id.slice(MASTER_SESSION_PREFIX.length) }
  if (!attribution) return
  for (const message of input.messages) {
    const info = rec(rec(message)?.info)
    if (!info || info.role !== "assistant") continue
    const messageId = txt(info.id)
    const time = rec(info.time)
    const completed = typeof time?.completed === "number" ? time.completed : undefined
    if (!messageId || completed === undefined) continue
    const created = typeof time?.created === "number" ? time.created : completed
    const tokens = rec(info.tokens)
    const cache = rec(tokens?.cache)
    const known = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
    const providerId = txt(info.providerID)
    const modelId = txt(info.modelID)
    const workspaceId = txt(input.workspace.workspace_id)
    if (!providerId || !modelId || !workspaceId) continue
    const access = txt(input.workspace.access)
    const location =
      access === "user-hosted"
        ? ("user-hosted" as const)
        : access === "local"
          ? ("local" as const)
          : ("cloud-workspace" as const)
    await recordLlmTurnFact(
      ctx,
      {
        org_id: meteringOrgId,
        user_id: meteringUserId,
        message_id: messageId,
        session_id: input.session_id,
        session_ref: `workspace:${workspaceId}:session:${input.session_id}`,
        workspace_id: workspaceId,
        location,
        ...attribution,
        harness: "workgraph",
        provider_id: providerId,
        model_id: modelId,
        input_tokens: known(tokens?.input),
        output_tokens: known(tokens?.output),
        reasoning_tokens: known(tokens?.reasoning),
        cache_read_tokens: known(cache?.read),
        cache_write_tokens: known(cache?.write),
        turn_status: info.error ? "error" : "ok",
        latency_ms: Math.max(0, completed - created),
      },
      completed,
    )
  }
}

async function syncMessageRows(
  ctx: any,
  input: {
    user: Record<string, unknown> & { _id: unknown }
    workspace: Record<string, unknown>
    session_id: string
    messages: unknown[]
    intakeReady: boolean
    maxEventOrdinal?: number
  },
) {
  const existingSession = await ctx.db
    .query("session_history")
    .withIndex("by_session_id", (query: any) => query.eq("session_id", input.session_id))
    .unique()
  if (existingSession && existingSession.workspace_id !== input.workspace._id) throw new Error("Session not found")
  if (
    existingSession &&
    !(await sessionRoleForUser(ctx, {
      user: input.user,
      workspace: input.workspace,
      session: existingSession,
      action: "write",
    }))
  )
    throw new Error("Session not found")
  if (input.maxEventOrdinal !== undefined && input.maxEventOrdinal < (existingSession?.max_event_ordinal ?? 0)) {
    return { applied: false, maxEventOrdinal: existingSession?.max_event_ordinal ?? 0 }
  }
  await ensureSessionHistoryRow(ctx, {
    user: input.user,
    workspace: input.workspace,
    session_id: input.session_id,
    existing: existingSession,
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
  const preserveCanonicalRows =
    input.maxEventOrdinal !== undefined &&
    input.maxEventOrdinal === (existingSession?.max_event_ordinal ?? 0) &&
    existingRows.length > 0 &&
    input.messages.length <= existingRows.length
  if (!preserveCanonicalRows) {
    if (input.maxEventOrdinal !== undefined) {
      const session =
        existingSession ??
        (await ctx.db
          .query("session_history")
          .withIndex("by_session_id", (query: any) => query.eq("session_id", input.session_id))
          .unique())
      if (session) await ctx.db.patch(session._id, { max_event_ordinal: input.maxEventOrdinal })
    }
    for (let ordinal = 0; ordinal < input.messages.length; ordinal += 1) {
      const message = input.messages[ordinal]
      const id = messageId(message, input.session_id, ordinal)
      const role = messageRole(message)
      const data = jsonValue(message)
      const producerAuthor = role === "user" ? producerAuthorId(message, input.user) : undefined
      incomingIds.add(id)
      const existing = existingRows.find((row: any) => row.message_id === id && !usedRows.has(row._id))
      if (existing) {
        usedRows.add(existing._id)
        const missingAuthor = !existing.author_actor_id && producerAuthor !== undefined
        if (
          existing.ordinal !== ordinal ||
          existing.role !== role ||
          jsonText(existing.data) !== jsonText(data) ||
          missingAuthor
        ) {
          await ctx.db.patch(existing._id, {
            role,
            ordinal,
            data,
            ...(missingAuthor ? { author_actor_id: producerAuthor } : {}),
            updated_at: now,
          })
        }
        continue
      }
      await ctx.db.insert("session_messages", {
        session_id: input.session_id,
        workspace_id: input.workspace._id,
        message_id: id,
        ...(producerAuthor === undefined ? {} : { author_actor_id: producerAuthor }),
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
  }
  const canonicalMessages = preserveCanonicalRows
    ? [...existingRows].sort((a: any, b: any) => a.ordinal - b.ordinal).map((row: any) => row.data)
    : input.messages
  const summary = [...canonicalMessages].reverse().find((message) => messageRole(message) === "assistant")
  const summaryText = messageText(summary)
  const meaningful =
    canonicalMessages.some((message) => messageRole(message) === "user" && messageText(message)) && summaryText
  if (input.intakeReady && meaningful && typeof input.user._id === "string") {
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (query: any) => query.eq("session_id", input.session_id))
      .unique()
    if (!session?.org_id) throw new Error("Session organization is required for WorkGraph intake")
    await enqueueIndependentSessionIntake(ctx, {
      organizationId: session.org_id,
      ownerUserId: input.user._id as Id<"users">,
      sessionId: input.session_id,
      title: typeof session?.title === "string" && session.title.trim() ? session.title.trim() : "AI work session",
      summary: summaryText.slice(0, 8_000),
      observedAt: now,
      ...(typeof input.workspace.git_remote === "string" && input.workspace.git_remote.trim()
        ? {
            execution: {
              environment: {
                kind: "hosted_workspace",
                repositoryUrl: input.workspace.git_remote.trim(),
              },
              repository: { baseRevision: "HEAD" },
            },
          }
        : typeof input.workspace.repo_url === "string" && input.workspace.repo_url.trim()
          ? {
              execution: {
                environment: {
                  kind: "hosted_workspace",
                  repositoryUrl: input.workspace.repo_url.trim(),
                },
                repository: { baseRevision: "HEAD" },
              },
            }
          : {}),
    })
  }
  return {
    applied: !preserveCanonicalRows,
    maxEventOrdinal: input.maxEventOrdinal ?? existingSession?.max_event_ordinal ?? 0,
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

async function authorizeSession(
  ctx: any,
  args: {
    session_id: string
    workspace_id: string
  },
  action: "read" | "write",
) {
  const user = await readUser(ctx)
  const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
  if (!workspace) return { allowed: false } as const
  const session = await ctx.db
    .query("session_history")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
    .unique()
  if (!session || session.workspace_id !== workspace._id || session.deleted_at) return { allowed: false } as const
  const role = await sessionRoleForUser(ctx, { user, workspace, session, action })
  if (!role) return { allowed: false } as const
  return { allowed: true, role, workspace, session, user } as const
}

export const authorizeRead = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    return await authorizeSession(ctx, args, "read")
  },
})

export const authorizeWrite = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await authorizeSession(ctx, args, "write")
    return result.allowed ? { allowed: true, role: result.role } : { allowed: false }
  },
})

export const authorizeRuntime = serviceQuery({
  args: {
    actor_id: v.string(),
    actor_kind: v.union(v.literal("human"), v.literal("agent")),
    session_id: v.string(),
    workspace_id: v.string(),
    action: v.union(v.literal("read"), v.literal("write")),
  },
  handler: async (ctx, args) => {
    const actorId = ctx.db.normalizeId("users", args.actor_id)
    if (!actorId) return { allowed: false }
    const user = await ctx.db.get(actorId)
    if (!user || user.kind !== args.actor_kind) return { allowed: false }
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) return { allowed: false }
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .unique()
    if (!session || session.deleted_at) return { allowed: false }
    const role = await sessionRoleForUser(ctx, {
      user,
      workspace,
      session,
      action: args.action,
    })
    return role ? { allowed: true, role } : { allowed: false }
  },
})

export const registerRuntime = serviceMutation({
  args: {
    actor_id: v.string(),
    actor_kind: v.union(v.literal("human"), v.literal("agent")),
    session_id: v.string(),
    workspace_id: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actorId = ctx.db.normalizeId("users", args.actor_id)
    if (!actorId) throw new Error("Session actor not found")
    const user = await ctx.db.get(actorId)
    if (!user || user.kind !== args.actor_kind) throw new Error("Session actor not found")
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspaceForUser(ctx, workspace, user, "write"))) {
      throw new Error("Workspace not found")
    }
    const existing = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (query: any) => query.eq("session_id", args.session_id))
      .unique()
    if (existing && (existing.workspace_id !== workspace._id || existing.created_by_user_id !== user._id))
      throw new Error("Session not found")
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(args.title === undefined ? {} : { title: args.title }),
        updated_at: now,
        deleted_at: undefined,
      })
    } else {
      await ctx.db.insert("session_history", {
        session_id: args.session_id,
        workspace_id: workspace._id,
        org_id: workspace.org_id,
        project_id: workspace.project_id,
        created_by_user_id: user._id,
        ...(args.title ? { title: args.title } : {}),
        created_at: now,
        updated_at: now,
      })
    }
    const participant = await ctx.db
      .query("session_participants")
      .withIndex("by_session_user", (query: any) => query.eq("session_id", args.session_id).eq("user_id", user._id))
      .unique()
    if (participant) {
      await ctx.db.patch(participant._id, { revoked_at: undefined, added_by_user_id: user._id })
    } else {
      await ctx.db.insert("session_participants", {
        session_id: args.session_id,
        workspace_id: workspace._id,
        user_id: user._id,
        added_by_user_id: user._id,
        created_at: now,
      })
    }
    return { registered: !existing }
  },
})

export const addParticipant = authedMutation({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    participant_token_identifier: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireSessionParticipantAdmin(ctx, args)
    const participant = await userByTokenIdentifier(ctx.db, args.participant_token_identifier)
    if (!participant || !(await authorizeWorkspaceForUser(ctx, access.workspace, participant, "read"))) {
      throw new Error("session_participant_workspace_access_required")
    }
    const existing = await ctx.db
      .query("session_participants")
      .withIndex("by_session_user", (q: any) => q.eq("session_id", args.session_id).eq("user_id", participant._id))
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { revoked_at: undefined, added_by_user_id: access.actor._id, created_at: now })
      return { participant_id: existing._id }
    }
    return {
      participant_id: await ctx.db.insert("session_participants", {
        session_id: args.session_id,
        workspace_id: access.workspace._id,
        user_id: participant._id,
        added_by_user_id: access.actor._id,
        created_at: now,
      }),
    }
  },
})

export const removeParticipant = authedMutation({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    participant_token_identifier: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireSessionParticipantAdmin(ctx, args)
    const participant = await userByTokenIdentifier(ctx.db, args.participant_token_identifier)
    if (!participant || participant._id === access.session.created_by_user_id) return { removed: false }
    const existing = await ctx.db
      .query("session_participants")
      .withIndex("by_session_user", (q: any) => q.eq("session_id", args.session_id).eq("user_id", participant._id))
      .unique()
    if (!existing || existing.revoked_at) return { removed: false }
    await ctx.db.patch(existing._id, { revoked_at: Date.now() })
    return { removed: true }
  },
})

export const list = authedQuery({
  args: {
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await readUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !(await authorizeWorkspaceForUser(ctx, workspace, user, "read"))) return []
    const canAdminSessions = await orgAdminForUser(ctx.db, user._id, workspace.org_id)
    const participantSessions = canAdminSessions
      ? new Set<string>()
      : new Set(
          (
            await ctx.db
              .query("session_participants")
              .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", workspace._id).eq("user_id", user._id))
              .collect()
          )
            .filter((participant) => !participant.revoked_at)
            .map((participant) => participant.session_id),
        )
    const sharedSessions = canAdminSessions
      ? new Set<string>()
      : await sessionIdsSharedWithUser(ctx, user._id, workspace._id)
    const sessions = await ctx.db
      .query("session_history")
      .withIndex("by_workspace_updated", (q) => q.eq("workspace_id", workspace._id))
      .order("desc")
      .collect()
    // A workspace can contain many sessions from the same collaborator. Keep
    // the promise (rather than just its resolved value) so concurrent mapping
    // work shares the first lookup as well.
    const creatorFor = createUserLookupCache((creatorId) => ctx.db.get(creatorId))
    return await Promise.all(
      sessions
        .filter(
          (session) =>
            !session.deleted_at &&
            (session.created_by_user_id === user._id ||
              canAdminSessions ||
              participantSessions.has(session.session_id) ||
              sharedSessions.has(session.session_id)),
        )
        .map(async (session) => {
          const projectId = publicProjectId(session.project_id)
          // Owner favicon is for shared/other-user rows only — creators don't need
          // their own face on sessions they already own.
          const creatorId = session.created_by_user_id as Id<"users"> | undefined
          const creator = creatorId && creatorId !== user._id ? await creatorFor(creatorId) : null
          return {
            session_id: session.session_id,
            ...(projectId ? { project_id: projectId } : {}),
            title: session.title,
            directory_hint: session.directory_hint,
            created_at: session.created_at,
            updated_at: session.updated_at,
            ...(typeof creator?.name === "string" && creator.name ? { owner_name: creator.name } : {}),
            ...(typeof creator?.image_url === "string" && creator.image_url
              ? { owner_avatar_url: creator.image_url }
              : {}),
            ...(typeof creator?.public_id === "string" && creator.public_id
              ? { owner_public_id: creator.public_id }
              : {}),
          }
        }),
    )
  },
})

async function sessionIdsSharedWithUser(ctx: any, userId: unknown, workspaceDocId: unknown) {
  const grants = await ctx.db
    .query("session_share_grants")
    .withIndex("by_workspace", (q: any) => q.eq("workspace_id", workspaceDocId))
    .collect()
  const teamIds = new Set(
    (
      await ctx.db
        .query("team_memberships")
        .withIndex("by_user", (q: any) => q.eq("user_id", userId))
        .collect()
    ).map((row: any) => row.team_id),
  )
  const orgIds = new Set(
    (
      await ctx.db
        .query("org_memberships")
        .withIndex("by_user", (q: any) => q.eq("user_id", userId))
        .collect()
    ).map((row: any) => row.org_id),
  )
  const ids = new Set<string>()
  for (const grant of grants) {
    if (grant.revoked_at) continue
    if (grant.granted_to_user_id === userId) ids.add(grant.session_id)
    else if (grant.granted_to_team_id && teamIds.has(grant.granted_to_team_id)) ids.add(grant.session_id)
    else if (grant.granted_to_org_id && orgIds.has(grant.granted_to_org_id)) ids.add(grant.session_id)
  }
  return ids
}

export const readMessages = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    limit: v.optional(v.number()),
    before_ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await authorizeSession(ctx, args, "read")
    if (!result.allowed) return { allowed: false, messages: [] }
    const authors = new Map<Id<"users">, Promise<Doc<"users"> | null>>()
    const withAuthor = async (message: any) => {
      const authorId = message.author_actor_id as Id<"users"> | undefined
      const author = authorId ? (authors.get(authorId) ?? ctx.db.get(authorId)) : undefined
      if (authorId && author) authors.set(authorId, author)
      return messageWithPublicAuthor(message.data, author ? await author : undefined)
    }
    const query = ctx.db
      .query("session_messages")
      .withIndex("by_session_ordinal", (q: any) =>
        args.before_ordinal === undefined
          ? q.eq("session_id", args.session_id)
          : q.eq("session_id", args.session_id).lt("ordinal", args.before_ordinal),
      )
    if (args.limit === undefined) {
      const messages = await query.collect()
      return {
        allowed: true,
        role: result.role,
        messages: await Promise.all(
          messages
            .filter((message: any) => message.workspace_id === result.workspace._id)
            .sort((a: any, b: any) => a.ordinal - b.ordinal)
            .map(withAuthor),
        ),
      }
    }
    const rows = (await query.order("desc").take(args.limit + 1)).filter(
      (message: any) => message.workspace_id === result.workspace._id,
    )
    const hasMore = rows.length > args.limit
    const selected = rows.slice(0, args.limit).reverse()
    return {
      allowed: true,
      role: result.role,
      messages: await Promise.all(selected.map(withAuthor)),
      ...(hasMore && selected[0] ? { next_ordinal: selected[0].ordinal } : {}),
    }
  },
})

export const resolve = authedQuery({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("session_history")
      .withIndex("by_session_id", (query: any) => query.eq("session_id", args.session_id))
      .unique()
    if (!session || session.deleted_at) return null
    const workspace = await ctx.db.get(session.workspace_id)
    if (!workspace) return null
    const user = await readUser(ctx)
    if (!(await sessionRoleForUser(ctx, { user, workspace, session, action: "read" }))) return null
    return {
      session_id: session.session_id,
      workspace_id: workspace.workspace_id,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
    }
  },
})

export const syncMessages = authedMutation({
  args: {
    workspace_id: v.string(),
    session_id: v.string(),
    messages: v.array(v.any()),
    intake_ready: v.optional(v.boolean()),
    max_event_ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await syncMessageRows(ctx, {
      ...(await writableWorkspace(ctx, args.workspace_id)),
      session_id: args.session_id,
      messages: args.messages,
      intakeReady: args.intake_ready ?? false,
      maxEventOrdinal: args.max_event_ordinal,
    })
    return args.max_event_ordinal === undefined ? { ok: true } : { ok: true, ...result }
  },
})

export const syncMessagesForService = serviceMutation({
  args: {
    user: serviceUser,
    workspace_id: v.string(),
    session_id: v.string(),
    messages: v.array(v.any()),
    intake_ready: v.optional(v.boolean()),
    max_event_ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await syncMessageRows(ctx, {
      ...(await writableWorkspaceForUser(ctx, await upsertServiceUser(ctx, args.user), args.workspace_id)),
      session_id: args.session_id,
      messages: args.messages,
      intakeReady: args.intake_ready ?? false,
      maxEventOrdinal: args.max_event_ordinal,
    })
    return args.max_event_ordinal === undefined ? { ok: true } : { ok: true, ...result }
  },
})

export const syncWorkGraphSession = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    workspace_id: v.string(),
    session_id: v.string(),
    title: v.optional(v.string()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    messages: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const [user, workspace] = await Promise.all([
      ctx.db.get(args.owner_user_id),
      workspaceByPublicId(ctx.db, args.workspace_id),
    ])
    if (
      !user ||
      !workspace ||
      workspace.deleted_at ||
      workspace.owner_user_id !== args.owner_user_id ||
      workspace.org_id !== args.organization_id
    ) {
      throw new Error("WorkGraph Session workspace not found")
    }
    // Verify the owner is still a member of the org, matching the guarantee the
    // sibling retainWorkGraphSessionTranscript gets from
    // requireTrustedWorkGraphTenantSubject. Without this, a workspace owner who
    // was removed from the org could still have transcript synced under a stale
    // ownership row.
    if (!(await orgMembership(ctx.db, args.organization_id, args.owner_user_id))) {
      throw new Error("WorkGraph organization membership is required")
    }
    await upsertVisibilityRows(ctx, {
      user,
      workspace,
      sessions: [
        {
          session_id: args.session_id,
          title: args.title,
          created_at: args.created_at,
          updated_at: args.updated_at,
        },
      ],
    })
    await syncMessageRows(ctx, {
      user,
      workspace,
      session_id: args.session_id,
      messages: args.messages,
      intakeReady: false,
    })
    await meterWorkGraphTranscriptTurns(ctx, {
      user,
      workspace,
      session_id: args.session_id,
      messages: args.messages,
    })
    return { ok: true }
  },
})

// Completion-time transcript retention for hosted WorkGraph Runs. The
// caller (the run-operation broker) only holds the runtime token's
// Clerk subject, so the durable owner is resolved through the same trusted
// tenant-subject path the WorkGraph command executor uses. The workspace must
// already exist (the launch sync created it) — an absent workspace fails the
// retention rather than fabricating one at completion time.
export const retainWorkGraphSessionTranscript = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    workspace_id: v.string(),
    session_id: v.string(),
    updated_at: v.optional(v.number()),
    messages: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (
      !workspace ||
      workspace.deleted_at ||
      workspace.owner_user_id !== tenant.owner_user_id ||
      workspace.org_id !== args.organization_id
    ) {
      throw new Error("WorkGraph Session workspace not found")
    }
    await upsertVisibilityRows(ctx, {
      user: tenant.user,
      workspace,
      sessions: [
        {
          session_id: args.session_id,
          updated_at: args.updated_at,
        },
      ],
    })
    await syncMessageRows(ctx, {
      user: tenant.user,
      workspace,
      session_id: args.session_id,
      messages: args.messages,
      intakeReady: false,
    })
    await meterWorkGraphTranscriptTurns(ctx, {
      user: tenant.user,
      workspace,
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
      .withIndex("by_workspace_creator_updated", (q: any) =>
        q.eq("workspace_id", access.workspace._id).eq("created_by_user_id", access.user._id),
      )
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
      .withIndex("by_workspace_creator_updated", (q: any) =>
        q.eq("workspace_id", access.workspace._id).eq("created_by_user_id", access.user._id),
      )
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
    if (
      !(await sessionRoleForUser(ctx, { user: access.user, workspace: access.workspace, session, action: "write" }))
    ) {
      throw new Error("Session not found")
    }
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
    if (
      !(await sessionRoleForUser(ctx, { user: access.user, workspace: access.workspace, session, action: "write" }))
    ) {
      throw new Error("Session not found")
    }
    await ctx.db.patch(session._id, {
      deleted_at: Date.now(),
      updated_at: Date.now(),
    })
    await deleteMessageRows(ctx, args.session_id, access.workspace._id)
    return { ok: true }
  },
})
