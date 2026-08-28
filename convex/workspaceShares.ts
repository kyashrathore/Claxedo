import { v } from "convex/values"
import {
  authedMutation,
  authorizeWorkspace,
  orgMembership,
  upsertUser,
  workspaceByPublicId,
} from "./model"

const shareRole = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"))

async function grantedUser(ctx: any, args: {
  target_actor_id?: unknown
  target_user_id?: unknown
}) {
  const id = args.target_actor_id ?? args.target_user_id
  return id ? await ctx.db.get(id) : undefined
}

async function grantedOrg(ctx: any, orgId: unknown) {
  return orgId ? await ctx.db.get(orgId) : undefined
}

function requireOneTarget(args: Record<string, unknown>, allowGrantId = false) {
  const count = [args.target_actor_id, args.target_user_id, args.target_org_id, allowGrantId ? args.grant_id : undefined]
    .filter(Boolean).length
  if (count !== 1) throw new Error("Workspace share requires exactly one canonical target")
}

async function requireTargetInWorkspaceOrganization(
  ctx: any,
  workspace: { org_id?: unknown },
  user: { _id: unknown } | null | undefined,
  org: { _id: unknown; deleted_at?: unknown } | null | undefined,
) {
  if (!workspace.org_id) throw new Error("Workspace has no canonical organization")
  if (org && (org._id !== workspace.org_id || org.deleted_at)) {
    throw new Error("Workspace share target belongs to another organization")
  }
  if (user && !await orgMembership(ctx.db, workspace.org_id, user._id)) {
    throw new Error("Workspace share target belongs to another organization")
  }
}

async function revokeRuntimeTokensForUsers(ctx: any, workspaceId: unknown, userIds: unknown[]) {
  const now = Date.now()
  const rows = (await Promise.all(userIds.map(async (userId) =>
    await ctx.db
      .query("runtime_access_tokens")
      .withIndex("by_workspace_user", (q: any) => q.eq("workspace_id", workspaceId).eq("minted_for_user_id", userId))
      .collect(),
  ))).flat()
  await Promise.all(rows
    .filter((token: any) => !token.revoked_at)
    .map(async (token: any) =>
      await ctx.db.patch(token._id, {
        revoked_at: now,
      }),
    ))
  return rows.filter((token: any) => !token.revoked_at).length
}

async function orgUserIds(ctx: any, orgId: unknown) {
  return (await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", orgId))
    .collect())
    .map((membership: any) => membership.user_id)
}

export const grant = authedMutation({
  args: {
    workspace_id: v.string(),
    role: shareRole,
    target_actor_id: v.optional(v.id("users")),
    target_user_id: v.optional(v.id("users")),
    target_org_id: v.optional(v.id("orgs")),
  },
  handler: async (ctx, args) => {
    requireOneTarget(args)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.target_org_id)
    if (!user && !org) throw new Error("Share target not found")
    await requireTargetInWorkspaceOrganization(ctx, workspace, user, org)
    const actor = await upsertUser(ctx)
    return await ctx.db.insert("workspace_share_grants", {
      workspace_id: workspace._id,
      granted_to_user_id: user?._id,
      granted_to_org_id: org?._id,
      role: args.role,
      created_by_user_id: actor._id,
      created_at: Date.now(),
    })
  },
})

export const revoke = authedMutation({
  args: {
    workspace_id: v.string(),
    grant_id: v.optional(v.id("workspace_share_grants")),
    target_actor_id: v.optional(v.id("users")),
    target_user_id: v.optional(v.id("users")),
    target_org_id: v.optional(v.id("orgs")),
  },
  handler: async (ctx, args) => {
    requireOneTarget(args, true)
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.target_org_id)
    const grants = await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_workspace", (q) => q.eq("workspace_id", workspace._id))
      .collect()
    const grant = grants.find((item) => {
      if (args.grant_id) return item._id === args.grant_id
      if (user) return item.granted_to_user_id === user._id
      if (org) return item.granted_to_org_id === org._id
      return false
    })
    if (!grant || grant.revoked_at) return { revoked: false }
    await ctx.db.patch(grant._id, { revoked_at: Date.now() })
    const userIds = grant.granted_to_user_id
      ? [grant.granted_to_user_id]
      : grant.granted_to_org_id
        ? await orgUserIds(ctx, grant.granted_to_org_id)
        : []
    return {
      revoked: true,
      runtime_tokens_revoked: await revokeRuntimeTokensForUsers(ctx, workspace._id, userIds),
    }
  },
})
