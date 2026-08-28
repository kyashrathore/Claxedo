import { v } from "convex/values"
import { authedMutation, authorizeWorkspace, roleAtLeast, serviceMutation, serviceQuery, upsertUser, workspaceByPublicId, workspaceRoleForUser } from "./model"

const workspaceRole = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"), v.literal("owner"))

export const recordMint = authedMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
    actor_id: v.string(),
    actor_kind: v.union(v.literal("human"), v.literal("agent")),
    role: workspaceRole,
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    if (String(user._id) !== args.actor_id || user.kind !== args.actor_kind) throw new Error("Workspace not found")
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    const currentRole = workspace ? await authorizeWorkspace(ctx, workspace, "read") : undefined
    if (!workspace || !currentRole || !roleAtLeast(currentRole, args.role)) throw new Error("Workspace not found")
    const existing = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_jti", (q: any) => q.eq("jti", args.jti))
      .unique()
    if (existing) throw new Error("Runtime Access Token already recorded")
    await ctx.db.insert("runtime_access_tokens", {
      jti: args.jti,
      workspace_id: workspace._id,
      host_id: args.host_id,
      principal_kind: "user",
      actor_id: args.actor_id,
      actor_kind: "human",
      role: args.role,
      minted_for_user_id: user._id,
      principal_kind: "user",
      minted_for_actor_id: args.actor_id,
      minted_for_actor_kind: args.actor_kind,
      workspace_role: args.role,
      expires_at: args.expires_at,
      created_at: Date.now(),
    })
    return { ok: true }
  },
})

export const recordMintForService = serviceMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
    actor_id: v.string(),
    actor_kind: v.union(v.literal("human"), v.literal("agent")),
    principal_kind: v.union(v.literal("user"), v.literal("service")),
    role: workspaceRole,
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.principal_kind !== "service" || args.actor_id !== "control-plane" || args.actor_kind !== "agent" || args.role !== "owner") {
      throw new Error("Invalid runtime service actor")
    }
    const existing = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_jti", (q: any) => q.eq("jti", args.jti))
      .unique()
    if (existing) throw new Error("Runtime Access Token already recorded")
    // Resolve the doc-id keys as well as the public/subject strings so that
    // membership-change revocation (revokeWorkspaceUserTokens, keyed on the
    // by_workspace_user index over workspace_id + minted_for_user_id) can reach
    // service-minted tokens. Without this, a kicked/downgraded hosted user's RAT
    // stays live until expiry. The active-check still matches on
    // workspace_public_id, so its behaviour is unchanged.
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    const userId = args.principal_kind === "user" ? ctx.db.normalizeId("users", args.actor_id) : null
    const user = userId ? await ctx.db.get(userId) : undefined
    const currentRole = workspace && user ? await workspaceRoleForUser(ctx, workspace, user) : undefined
    const userAllowed = args.principal_kind === "user"
      && user
      && user.kind === args.actor_kind
      && currentRole
      && roleAtLeast(currentRole, args.role)
    const serviceAllowed = args.principal_kind === "service"
      && args.actor_kind === "agent"
      && !!args.actor_id.trim()
      && args.role === "owner"
    if (!workspace || workspace.deleted_at || (!userAllowed && !serviceAllowed)) {
      throw new Error("Workspace not found")
    }
    await ctx.db.insert("runtime_access_tokens", {
      jti: args.jti,
      workspace_public_id: args.workspace_id,
      ...(workspace ? { workspace_id: workspace._id } : {}),
      host_id: args.host_id,
      ...(user?.clerk_subject ? { minted_for_subject: user.clerk_subject } : {}),
      ...(user ? { minted_for_user_id: user._id } : {}),
      principal_kind: args.principal_kind,
      minted_for_actor_id: args.actor_id,
      minted_for_actor_kind: args.actor_kind,
      workspace_role: args.role,
      expires_at: args.expires_at,
      created_at: Date.now(),
    })
    return { ok: true }
  },
})

// Revocation-check for the relay/runtime service path. Before D8 this query
// was entirely unauthenticated (the executor called it with
// `allowUnsigned: true` and no credential); it now requires the control-plane
// service token like every other machine path.
export const active = serviceQuery({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
  },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_jti", (q: any) => q.eq("jti", args.jti))
      .unique()
    if (!token) {
      return {
        active: false,
        code: "runtime_access_token_unknown",
        reason: "Runtime Access Token has not been recorded",
      }
    }
    if (token.revoked_at) {
      return {
        active: false,
        code: "runtime_access_token_revoked",
        reason: "Runtime Access Token has been revoked",
      }
    }
    const workspaceMatches = token.workspace_public_id
      ? token.workspace_public_id === args.workspace_id
      : token.workspace_id === (await workspaceByPublicId(ctx.db, args.workspace_id))?._id
    if (!workspaceMatches || token.host_id !== args.host_id) {
      return {
        active: false,
        code: "runtime_access_token_mismatch",
        reason: "Runtime Access Token does not match workspace or host",
      }
    }
    if (token.expires_at <= Date.now()) {
      return {
        active: false,
        code: "runtime_access_token_expired",
        reason: "Runtime Access Token has expired",
      }
    }
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    const user = token.principal_kind === "user" && token.minted_for_user_id
      ? await ctx.db.get(token.minted_for_user_id)
      : undefined
    const currentRole = workspace && user ? await workspaceRoleForUser(ctx, workspace, user) : undefined
    const authorizationChanged = !workspace
      || !!workspace.deleted_at
      || !token.workspace_role
      || !token.principal_kind
      || (token.principal_kind === "user" && (
        !user
        || String(user._id) !== token.minted_for_actor_id
        || user.kind !== token.minted_for_actor_kind
        || !currentRole
        || !roleAtLeast(currentRole, token.workspace_role)
      ))
      || (token.principal_kind === "service" && (
        token.workspace_role !== "owner"
        || token.minted_for_actor_kind !== "agent"
        || !token.minted_for_actor_id?.trim()
      ))
    if (authorizationChanged) {
      return {
        active: false,
        code: "runtime_access_token_revoked",
        reason: "Runtime Access Token authorization has changed",
      }
    }
    return { active: true }
  },
})

function roleAction(value: "viewer" | "editor" | "admin" | "owner") {
  return value === "viewer" ? "read" as const : value === "editor" ? "write" as const : value
}

export const revoke = authedMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    await upsertUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) throw new Error("Workspace not found")
    const token = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_jti", (q: any) => q.eq("jti", args.jti))
      .unique()
    if (!token || token.workspace_id !== workspace._id || token.revoked_at) return { ok: true }
    await ctx.db.patch(token._id, {
      revoked_at: Date.now(),
    })
    return { ok: true }
  },
})

export const revokeForWorkspaceUser = authedMutation({
  args: {
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) throw new Error("Workspace not found")
    return await revokeWorkspaceUserTokens(ctx, workspace._id, user._id, Date.now())
  },
})

export async function revokeWorkspaceUserTokens(ctx: any, workspaceId: unknown, userId: unknown, now: number) {
    const rows = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_workspace_user", (q: any) =>
        q.eq("workspace_id", workspaceId).eq("minted_for_user_id", userId))
      .collect()
    const active = rows.filter((token: any) => !token.revoked_at)
    for (const token of active) {
      await ctx.db.patch(token._id, {
        revoked_at: now,
      })
    }
    return { revoked: active.length }
}
