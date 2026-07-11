import { v } from "convex/values"
import { authedMutation, authorizeWorkspace, serviceQuery, upsertUser, workspaceByPublicId } from "./model"

export const recordMint = authedMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await upsertUser(ctx)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) throw new Error("Workspace not found")
    const existing = await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_jti", (q: any) => q.eq("jti", args.jti))
      .unique()
    if (existing) throw new Error("Runtime Access Token already recorded")
    await ctx.db.insert("runtime_access_tokens", {
      jti: args.jti,
      workspace_id: workspace._id,
      host_id: args.host_id,
      minted_for_user_id: user._id,
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
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace) {
      return {
        active: false,
        code: "runtime_access_token_mismatch",
        reason: "Runtime Access Token workspace is unavailable",
      }
    }
    if (token.workspace_id !== workspace._id || token.host_id !== args.host_id) {
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
    return { active: true }
  },
})

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
