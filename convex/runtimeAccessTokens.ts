import { v } from "convex/values"
import { authedMutation, authorizeWorkspace, authorizeWorkspaceForUser, serviceMutation, serviceQuery, upsertUser, workspaceByPublicId } from "./model"

const actorKind = v.union(v.literal("human"), v.literal("agent"))
const principalKind = v.union(v.literal("user"), v.literal("service"))
const role = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"), v.literal("owner"))

export const recordMint = authedMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
    actor_id: v.string(),
    actor_kind: actorKind,
    role,
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, roleAction(args.role))) throw new Error("Workspace not found")
    if (args.actor_id !== String(user._id) || args.actor_kind !== "human") throw new Error("Runtime actor mismatch")
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
    actor_kind: actorKind,
    principal_kind: principalKind,
    role,
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
    await ctx.db.insert("runtime_access_tokens", {
      jti: args.jti,
      workspace_public_id: args.workspace_id,
      host_id: args.host_id,
      principal_kind: "service",
      actor_id: args.actor_id,
      actor_kind: "agent",
      role: "owner",
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
    if (token.principal_kind === "service") {
      if (token.actor_id !== "control-plane" || token.actor_kind !== "agent" || token.role !== "owner" || token.minted_for_user_id) {
        return { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token service authority has been revoked" }
      }
    } else {
      const workspace = token.workspace_id ? await ctx.db.get(token.workspace_id) : undefined
      const user = token.minted_for_user_id ? await ctx.db.get(token.minted_for_user_id) : undefined
      if (!workspace || !user || token.actor_id !== String(user._id) || token.actor_kind !== "human" || !await authorizeWorkspaceForUser(ctx, workspace, user, roleAction(token.role))) {
        return { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token authority has been revoked" }
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
    const now = Date.now()
    const rows = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_workspace_user", (q: any) =>
        q.eq("workspace_id", workspace._id).eq("minted_for_user_id", user._id))
      .collect()
    for (const token of rows.filter((token: any) => !token.revoked_at)) {
      await ctx.db.patch(token._id, {
        revoked_at: now,
      })
    }
    return { revoked: rows.filter((token: any) => !token.revoked_at).length }
  },
})
