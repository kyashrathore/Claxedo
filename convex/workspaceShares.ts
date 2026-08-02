import { v } from "convex/values"
import {
  authedMutation,
  authorizeWorkspace,
  orgByClerkOrgId,
  upsertUser,
  userByClerkSubject,
  userByTokenIdentifier,
  workspaceByPublicId,
} from "./model"

const shareRole = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"))

async function grantedUser(ctx: any, args: {
  granted_to_token_identifier?: string
  granted_to_clerk_subject?: string
}) {
  if (args.granted_to_token_identifier) return await userByTokenIdentifier(ctx.db, args.granted_to_token_identifier)
  if (args.granted_to_clerk_subject) return await userByClerkSubject(ctx.db, args.granted_to_clerk_subject)
  return undefined
}

async function grantedOrg(ctx: any, clerkOrgId: string | undefined) {
  if (!clerkOrgId) return undefined
  // W5: was a whole-`orgs` scan plus a JS `.find()` on `clerk_org_id` — the
  // exact lookup `orgByClerkOrgId` performs through `by_clerk_org_id`.
  // `?? undefined` because that helper returns `null` for "no such org" and
  // every caller here tests the result for undefined.
  return await orgByClerkOrgId(ctx.db, clerkOrgId) ?? undefined
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
    granted_to_token_identifier: v.optional(v.string()),
    granted_to_clerk_subject: v.optional(v.string()),
    granted_to_clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id)
    if (!user && !org) throw new Error("Share target not found")
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
    granted_to_token_identifier: v.optional(v.string()),
    granted_to_clerk_subject: v.optional(v.string()),
    granted_to_clerk_org_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id)
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
