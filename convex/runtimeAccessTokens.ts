import { v } from "convex/values"
import { authedMutation, authorizeWorkspace, serviceMutation, serviceQuery, upsertUser, userByClerkSubject, userByTokenIdentifier, workspaceByPublicId } from "./model"

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

export const recordMintForService = serviceMutation({
  args: {
    jti: v.string(),
    workspace_id: v.string(),
    host_id: v.string(),
    subject: v.string(),
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
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
    const user = await userByClerkSubject(ctx.db, args.subject)
      ?? await userByTokenIdentifier(ctx.db, args.subject)
    await ctx.db.insert("runtime_access_tokens", {
      jti: args.jti,
      workspace_public_id: args.workspace_id,
      ...(workspace ? { workspace_id: workspace._id } : {}),
      host_id: args.host_id,
      minted_for_subject: args.subject,
      ...(user ? { minted_for_user_id: user._id } : {}),
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
