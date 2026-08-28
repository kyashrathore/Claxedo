import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspaceForUser,
  orgAdminForUser,
  readUser,
  serviceMutation,
  serviceQuery,
  upsertUser,
  workspaceByPublicId,
} from "./model"

const runtimePrincipal = {
  principal_kind: v.union(v.literal("user"), v.literal("service")),
  actor_id: v.string(),
  actor_kind: v.union(v.literal("human"), v.literal("agent")),
}
const visibility = v.object({
  session_id: v.string(),
  title: v.optional(v.string()),
  created_at: v.optional(v.number()),
  updated_at: v.optional(v.number()),
})

async function registration(ctx: any, operationId: string) {
  return await ctx.db.query("private_session_registrations")
    .withIndex("by_operation_id", (q: any) => q.eq("operation_id", operationId))
    .unique()
}

async function privateSession(ctx: any, sessionId: string) {
  return await ctx.db.query("private_sessions")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
    .unique()
}

async function requireWorkspace(ctx: any, user: any, publicId: string, action: "read" | "write") {
  const workspace = await workspaceByPublicId(ctx.db, required(publicId, "workspace_id"))
  if (!workspace || workspace.deleted_at || !await authorizeWorkspaceForUser(ctx, workspace, user, action)) deny()
  return workspace
}

async function hasPrivateAccess(ctx: any, user: any, workspace: any, session: any) {
  if (session.creator_actor_id === user._id) return true
  const participant = await ctx.db.query("private_session_participants")
    .withIndex("by_session_actor", (q: any) => q.eq("session_id", session.session_id).eq("participant_actor_id", user._id))
    .unique()
  if (participant && !participant.revoked_at) return true
  return workspace.org_id ? await orgAdminForUser(ctx.db, user._id, workspace.org_id) : false
}

async function requireSessionAccess(
  ctx: any,
  user: any,
  sessionId: string,
  workspacePublicId: string,
  action: "read" | "write",
) {
  const [workspace, session] = await Promise.all([
    requireWorkspace(ctx, user, workspacePublicId, action),
    privateSession(ctx, required(sessionId, "session_id")),
  ])
  if (
    !session
    || session.workspace_id !== workspace._id
    || session.workspace_public_id !== workspacePublicId
    || session.deleted_at
    || !await hasPrivateAccess(ctx, user, workspace, session)
  ) deny()
  return { workspace, session }
}

async function runtimeActor(ctx: any, args: { principal_kind: string; actor_id: string; actor_kind: string }) {
  if (
    (args.principal_kind === "user" && args.actor_kind !== "human")
    || (args.principal_kind === "service" && args.actor_kind !== "agent")
    || !["user", "service"].includes(args.principal_kind)
  ) throw new Error("actor_authorization_denied")
  const actor = await ctx.db.get(required(args.actor_id, "actor_id") as never)
  const kind = actor?.kind ?? "human"
  if (!actor || kind !== args.actor_kind) throw new Error("actor_authorization_denied")
  return actor
}

async function participantAdministrator(ctx: any, actor: any, sessionId: string, workspaceId: string) {
  const current = await requireSessionAccess(ctx, actor, sessionId, workspaceId, "read")
  const admin = current.workspace.org_id
    ? await orgAdminForUser(ctx.db, actor._id, current.workspace.org_id)
    : false
  if (current.session.creator_actor_id !== actor._id && !admin) throw new Error("session_participant_admin_required")
  return current
}

function registrationResult(row: any, changed: boolean) {
  return {
    changed,
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_public_id,
    state: row.state,
  }
}

function sameRegistration(row: any, input: {
  operationId: string
  sessionId: string
  workspaceId: string
  creatorActorId: unknown
  kind: "create" | "fork"
  parentSessionId?: string
  title?: string
}) {
  if (
    row.operation_id !== input.operationId
    || row.session_id !== input.sessionId
    || row.workspace_public_id !== input.workspaceId
    || row.creator_actor_id !== input.creatorActorId
    || row.operation_kind !== input.kind
    || row.parent_session_id !== input.parentSessionId
    || row.requested_title !== input.title
  ) throw new Error("resource_conflict")
}

export const reserve = authedMutation({
  args: {
    operation_id: v.string(),
    session_id: v.string(),
    workspace_id: v.string(),
    kind: v.union(v.literal("create"), v.literal("fork")),
    parent_session_id: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const operationId = required(args.operation_id, "operation_id")
    const sessionId = required(args.session_id, "session_id")
    const workspaceId = required(args.workspace_id, "workspace_id")
    const title = optional(args.title)
    const parentSessionId = optional(args.parent_session_id)
    if (args.kind === "fork" && !parentSessionId) throw new Error("parent_session_id_required")
    if (args.kind === "create" && parentSessionId) throw new Error("parent_session_id_forbidden")
    const workspace = await requireWorkspace(ctx, actor, workspaceId, "write")
    if (parentSessionId) await requireSessionAccess(ctx, actor, parentSessionId, workspaceId, "read")
    const existing = await registration(ctx, operationId)
    const intent = { operationId, sessionId, workspaceId, creatorActorId: actor._id, kind: args.kind, parentSessionId, title }
    if (existing) {
      sameRegistration(existing, intent)
      return registrationResult(existing, false)
    }
    if (await privateSession(ctx, sessionId)) throw new Error("resource_conflict")
    const collision = await ctx.db.query("private_session_registrations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
      .unique()
    if (collision) throw new Error("resource_conflict")
    const now = Date.now()
    const id = await ctx.db.insert("private_session_registrations", {
      operation_id: operationId,
      session_id: sessionId,
      workspace_id: workspace._id,
      workspace_public_id: workspaceId,
      creator_actor_id: actor._id,
      operation_kind: args.kind,
      parent_session_id: parentSessionId,
      requested_title: title,
      state: "reserved",
      created_at: now,
      updated_at: now,
    })
    return registrationResult(await ctx.db.get(id), true)
  },
})

export const registerRuntime = serviceMutation({
  args: {
    ...runtimePrincipal,
    operation_id: v.string(),
    session_id: v.string(),
    workspace_id: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await runtimeActor(ctx, args)
    const row = await registration(ctx, required(args.operation_id, "operation_id"))
    if (!row) throw new Error("registration_transition_denied")
    sameRegistration(row, {
      operationId: args.operation_id,
      sessionId: required(args.session_id, "session_id"),
      workspaceId: required(args.workspace_id, "workspace_id"),
      creatorActorId: actor._id,
      kind: row.operation_kind,
      parentSessionId: row.parent_session_id,
      title: optional(args.title),
    })
    if (row.state === "registered") return registrationResult(row, false)
    if (row.state !== "reserved" && row.state !== "reconciliation_required") throw new Error("registration_transition_denied")
    const workspace = await requireWorkspace(ctx, actor, args.workspace_id, "write")
    const now = Date.now()
    await ctx.db.insert("private_sessions", {
      session_id: row.session_id,
      workspace_id: workspace._id,
      workspace_public_id: args.workspace_id,
      org_id: workspace.org_id,
      project_id: workspace.project_id,
      creator_actor_id: actor._id,
      operation_id: row.operation_id,
      title: row.requested_title,
      created_at: now,
      updated_at: now,
      max_event_ordinal: 0,
    })
    await ctx.db.insert("private_session_participants", {
      session_id: row.session_id,
      workspace_id: workspace._id,
      participant_actor_id: actor._id,
      added_by_actor_id: actor._id,
      created_at: now,
    })
    await ctx.db.patch(row._id, { state: "registered", state_reason: undefined, updated_at: now })
    return registrationResult({ ...row, state: "registered" }, true)
  },
})

function transition(
  to: "reconciliation_required" | "compensation_pending" | "compensated",
  from: readonly string[],
) {
  return serviceMutation({
    args: {
      ...runtimePrincipal,
      operation_id: v.string(),
      session_id: v.string(),
      workspace_id: v.string(),
      reason: v.string(),
    },
    handler: async (ctx, args) => {
      const actor = await runtimeActor(ctx, args)
      const row = await registration(ctx, required(args.operation_id, "operation_id"))
      if (
        !row
        || row.creator_actor_id !== actor._id
        || row.session_id !== required(args.session_id, "session_id")
        || row.workspace_public_id !== required(args.workspace_id, "workspace_id")
      ) throw new Error("actor_authorization_denied")
      if (row.state === to) return registrationResult(row, false)
      if (!from.includes(row.state)) throw new Error("registration_transition_denied")
      await ctx.db.patch(row._id, {
        state: to,
        state_reason: required(args.reason, "reason"),
        updated_at: Date.now(),
      })
      return registrationResult({ ...row, state: to }, true)
    },
  })
}

export const markRegistrationAmbiguous = transition("reconciliation_required", ["reserved"])
export const beginCompensation = transition("compensation_pending", ["reserved", "reconciliation_required"])
export const completeCompensation = transition("compensated", ["compensation_pending"])

export const authorizeRead = authedQuery({
  args: { session_id: v.string(), workspace_id: v.string() },
  handler: async (ctx, args) => {
    await requireSessionAccess(ctx, await readUser(ctx), args.session_id, args.workspace_id, "read")
    return { allowed: true as const }
  },
})

export const authorizeWrite = authedQuery({
  args: { session_id: v.string(), workspace_id: v.string() },
  handler: async (ctx, args) => {
    await requireSessionAccess(ctx, await readUser(ctx), args.session_id, args.workspace_id, "write")
    return { allowed: true as const }
  },
})

export const authorizeRuntime = serviceQuery({
  args: {
    ...runtimePrincipal,
    session_id: v.string(),
    workspace_id: v.string(),
    action: v.union(v.literal("read"), v.literal("write")),
  },
  handler: async (ctx, args) => {
    await requireSessionAccess(ctx, await runtimeActor(ctx, args), args.session_id, args.workspace_id, args.action)
    return { allowed: true as const }
  },
})

export const grantParticipant = authedMutation({
  args: { session_id: v.string(), workspace_id: v.string(), participant_actor_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const current = await participantAdministrator(ctx, actor, args.session_id, args.workspace_id)
    const participant = await ctx.db.get(required(args.participant_actor_id, "participant_actor_id") as never)
    if (!participant) throw new Error("participant_actor_not_found")
    const existing = await ctx.db.query("private_session_participants")
      .withIndex("by_session_actor", (q: any) => q.eq("session_id", args.session_id).eq("participant_actor_id", participant._id))
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { workspace_id: current.workspace._id, added_by_actor_id: actor._id, created_at: now, revoked_at: undefined })
    } else {
      await ctx.db.insert("private_session_participants", {
        session_id: args.session_id,
        workspace_id: current.workspace._id,
        participant_actor_id: participant._id,
        added_by_actor_id: actor._id,
        created_at: now,
      })
    }
    return { participant_id: String(participant._id) }
  },
})

export const revokeParticipant = authedMutation({
  args: { session_id: v.string(), workspace_id: v.string(), participant_actor_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const current = await participantAdministrator(ctx, actor, args.session_id, args.workspace_id)
    if (String(current.session.creator_actor_id) === args.participant_actor_id) throw new Error("session_creator_cannot_be_revoked")
    const participant = await ctx.db.query("private_session_participants")
      .withIndex("by_session_actor", (q: any) => q.eq("session_id", args.session_id).eq("participant_actor_id", args.participant_actor_id as never))
      .unique()
    if (!participant || participant.revoked_at) return { removed: false }
    const now = Date.now()
    await ctx.db.patch(participant._id, { revoked_at: now })
    const tokens = await ctx.db.query("runtime_access_tokens")
      .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", current.workspace._id).eq("minted_for_user_id", args.participant_actor_id as never))
      .collect()
    for (const token of tokens.filter((item: any) => !item.revoked_at)) await ctx.db.patch(token._id, { revoked_at: now })
    return { removed: true }
  },
})

export const list = authedQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await readUser(ctx)
    const workspace = await requireWorkspace(ctx, actor, args.workspace_id, "read")
    const rows = await ctx.db.query("private_sessions")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace_id", workspace._id))
      .order("desc")
      .collect()
    const visible = []
    for (const row of rows) {
      if (!row.deleted_at && await hasPrivateAccess(ctx, actor, workspace, row)) visible.push(publicSession(row))
    }
    return visible
  },
})

export const resolve = authedQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await readUser(ctx)
    const session = await privateSession(ctx, args.session_id)
    if (!session || session.deleted_at) return null
    try {
      await requireSessionAccess(ctx, actor, session.session_id, session.workspace_public_id, "read")
      return { ...publicSession(session), workspace_id: session.workspace_public_id }
    } catch {
      return null
    }
  },
})

export const readMessages = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    limit: v.optional(v.number()),
    before_ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await readUser(ctx)
    let current
    try {
      current = await requireSessionAccess(ctx, actor, args.session_id, args.workspace_id, "read")
    } catch {
      return { allowed: false, messages: [] }
    }
    const limit = args.limit
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("invalid_message_page_limit")
    let rows = await ctx.db.query("private_session_messages")
      .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    rows = rows.filter((row: any) => row.workspace_id === current.workspace._id && (args.before_ordinal === undefined || row.ordinal < args.before_ordinal))
      .sort((a: any, b: any) => a.ordinal - b.ordinal)
    const hasMore = limit !== undefined && rows.length > limit
    const selected = limit === undefined ? rows : rows.slice(-limit)
    const messages = []
    for (const row of selected) messages.push(await publicMessage(ctx, row))
    return {
      allowed: true,
      role: await authorizeWorkspaceForUser(ctx, current.workspace, actor, "read"),
      messages,
      ...(hasMore && selected[0] ? { next_ordinal: selected[0].ordinal } : {}),
    }
  },
})

export const syncMessages = authedMutation({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    messages: v.array(v.any()),
    intake_ready: v.optional(v.boolean()),
    max_event_ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const current = await requireSessionAccess(ctx, actor, args.session_id, args.workspace_id, "write")
    if (args.intake_ready) throw new Error("private_session_intake_not_supported")
    if (args.max_event_ordinal !== undefined && args.max_event_ordinal < current.session.max_event_ordinal) {
      return { ok: true, applied: false, maxEventOrdinal: current.session.max_event_ordinal }
    }
    const existing = await ctx.db.query("private_session_messages")
      .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    if (
      args.max_event_ordinal !== undefined
      && args.max_event_ordinal === current.session.max_event_ordinal
      && existing.length > 0
      && args.messages.length <= existing.length
    ) return { ok: true, applied: false, maxEventOrdinal: current.session.max_event_ordinal }
    const authors = new Map(existing.map((row: any) => [row.message_id, row.author_actor_id]))
    for (const row of existing) await ctx.db.delete(row._id)
    const now = Date.now()
    for (let ordinal = 0; ordinal < args.messages.length; ordinal += 1) {
      const data = jsonValue(args.messages[ordinal])
      const messageId = idOf(data, args.session_id, ordinal)
      const role = roleOf(data)
      const claimed = authorOf(data)
      const authorActorId = authors.get(messageId) ?? (role === "user" && claimed === String(actor._id) ? actor._id : undefined)
      await ctx.db.insert("private_session_messages", {
        session_id: args.session_id,
        workspace_id: current.workspace._id,
        message_id: messageId,
        author_actor_id: authorActorId,
        role,
        ordinal,
        data,
        created_at: now,
        updated_at: now,
      })
    }
    await ctx.db.patch(current.session._id, {
      ...(args.max_event_ordinal === undefined ? {} : { max_event_ordinal: args.max_event_ordinal }),
      updated_at: now,
    })
    return args.max_event_ordinal === undefined
      ? { ok: true }
      : { ok: true, applied: true, maxEventOrdinal: args.max_event_ordinal }
  },
})

function visibilityMutation(replace: boolean) {
  return authedMutation({
    args: { workspace_id: v.string(), sessions: v.array(visibility) },
    handler: async (ctx, args) => {
      const actor = await upsertUser(ctx)
      const workspace = await requireWorkspace(ctx, actor, args.workspace_id, "write")
      const incoming = new Set<string>()
      for (const value of args.sessions) {
        const current = await requireSessionAccess(ctx, actor, value.session_id, args.workspace_id, "write")
        if (value.created_at !== undefined && value.created_at !== current.session.created_at) throw new Error("resource_conflict")
        incoming.add(value.session_id)
        await ctx.db.patch(current.session._id, {
          ...(value.title === undefined ? {} : { title: value.title }),
          updated_at: Math.max(current.session.updated_at, value.updated_at ?? Date.now()),
        })
      }
      if (replace) {
        const owned = await ctx.db.query("private_sessions")
          .withIndex("by_workspace_creator_updated", (q: any) => q.eq("workspace_id", workspace._id).eq("creator_actor_id", actor._id))
          .collect()
        const now = Date.now()
        for (const row of owned) {
          if (row.deleted_at || incoming.has(row.session_id)) continue
          await ctx.db.patch(row._id, { deleted_at: now, updated_at: now })
          const messages = await ctx.db.query("private_session_messages")
            .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", row.session_id))
            .collect()
          for (const message of messages) await ctx.db.delete(message._id)
        }
      }
      return { ok: true }
    },
  })
}

export const upsertVisibility = visibilityMutation(false)
export const replaceVisibility = visibilityMutation(true)

export const deleteVisibility = authedMutation({
  args: { session_id: v.string(), workspace_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const current = await requireSessionAccess(ctx, actor, args.session_id, args.workspace_id, "write")
    const now = Date.now()
    await ctx.db.patch(current.session._id, { deleted_at: now, updated_at: now })
    const messages = await ctx.db.query("private_session_messages")
      .withIndex("by_session_ordinal", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    for (const row of messages) await ctx.db.delete(row._id)
    return { ok: true }
  },
})

function publicSession(row: any) {
  return {
    session_id: row.session_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function publicMessage(ctx: any, row: any) {
  const value = rec(row.data)
  if (!value) return row.data
  const info = rec(value.info) ?? {}
  const claxedo = rec(info.claxedo) ?? {}
  const { author: _author, ...safeClaxedo } = claxedo
  const { claxedo: _claxedo, ...safeInfo } = info
  const actor = row.author_actor_id ? await ctx.db.get(row.author_actor_id) : undefined
  const canonical = actor
    ? { ...safeClaxedo, author: { id: String(actor._id), kind: actor.kind === "agent" ? "agent" : "human" } }
    : safeClaxedo
  return { ...value, info: { ...safeInfo, ...(Object.keys(canonical).length ? { claxedo: canonical } : {}) } }
}

function idOf(value: unknown, sessionId: string, ordinal: number) {
  const row = rec(value)
  return optional(row?.id) ?? optional(rec(row?.info)?.id) ?? `${sessionId}:${ordinal}`
}

function roleOf(value: unknown) {
  const row = rec(value)
  return optional(row?.role) ?? optional(rec(row?.info)?.role)
}

function authorOf(value: unknown) {
  const info = rec(rec(value)?.info)
  const claxedo = rec(info?.claxedo)
  return optional(rec(claxedo?.author)?.id)
}

function jsonValue(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error("invalid_session_message")
  }
}

function rec(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function required(value: unknown, name: string) {
  const text = optional(value)
  if (!text) throw new Error(`${name}_required`)
  return text
}

function deny(): never {
  throw new Error("workspace_authorization_denied")
}
