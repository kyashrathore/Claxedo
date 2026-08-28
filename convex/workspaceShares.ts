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

function targetSelectorCount(args: {
  grant_id?: unknown
  granted_to_token_identifier?: string
  granted_to_clerk_subject?: string
  granted_to_clerk_org_id?: string
  granted_to_team_public_id?: string
  granted_to_team_id?: string
}) {
  return [
    args.grant_id,
    args.granted_to_token_identifier,
    args.granted_to_clerk_subject,
    args.granted_to_clerk_org_id,
    args.granted_to_team_public_id,
    args.granted_to_team_id,
  ].filter(Boolean).length
}

async function grantsForTarget(ctx: any, workspaceId: unknown, target: {
  user?: { _id: unknown }
  org?: { _id: unknown }
  team?: { _id: unknown }
}) {
  if (target.user) {
    return await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_workspace_user", (q: any) =>
        q.eq("workspace_id", workspaceId).eq("granted_to_user_id", target.user!._id))
      .collect()
  }
  if (target.org) {
    return await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_workspace_org", (q: any) =>
        q.eq("workspace_id", workspaceId).eq("granted_to_org_id", target.org!._id))
      .collect()
  }
  if (target.team) {
    return await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_workspace_team", (q: any) =>
        q.eq("workspace_id", workspaceId).eq("granted_to_team_id", target.team!._id))
      .collect()
  }
  return []
}

async function teamUserIds(ctx: any, teamId: unknown) {
  return (await ctx.db
    .query("team_memberships")
    .withIndex("by_team", (q: any) => q.eq("team_id", teamId))
    .collect())
    .map((membership: any) => membership.user_id)
}

async function orgUserIds(ctx: any, orgId: unknown) {
  return (await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", orgId))
    .collect())
    .map((membership: any) => membership.user_id)
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

async function grantedTeam(ctx: any, teamPublicId: string | undefined, teamDocId: string | undefined) {
  if (teamDocId) {
    try {
      const team = await ctx.db.get(teamDocId as never)
      if (team && !(team as any).deleted_at) return team
    } catch {
      /* fall through */
    }
  }
  if (!teamPublicId) return undefined
  const team = await ctx.db
    .query("teams")
    .withIndex("by_public_id", (q: any) => q.eq("public_id", teamPublicId))
    .unique()
  return team && !team.deleted_at ? team : undefined
}

export const grant = authedMutation({
  args: {
    workspace_id: v.string(),
    role: shareRole,
    granted_to_token_identifier: v.optional(v.string()),
    granted_to_clerk_subject: v.optional(v.string()),
    granted_to_clerk_org_id: v.optional(v.string()),
    granted_to_team_public_id: v.optional(v.string()),
    granted_to_team_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (targetSelectorCount(args) !== 1) throw new Error("Share target must be exactly one user, org, or team")
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id)
    const team = await grantedTeam(ctx, args.granted_to_team_public_id, args.granted_to_team_id)
    if (!user && !org && !team) throw new Error("Share target not found")
    const actor = await upsertUser(ctx)
    const active = (await grantsForTarget(ctx, workspace._id, { user, org, team }))
      .filter((item: any) => !item.revoked_at)
    if (active.length === 1 && active[0].role === args.role) return active[0]._id
    const now = Date.now()
    for (const item of active) await ctx.db.patch(item._id, { revoked_at: now })
    if (active.length > 0) {
      const userIds = user
        ? [user._id]
        : org
          ? await orgUserIds(ctx, org._id)
          : team
            ? await teamUserIds(ctx, team._id)
            : []
      await revokeRuntimeTokensForUsers(ctx, workspace._id, userIds)
    }
    return await ctx.db.insert("workspace_share_grants", {
      workspace_id: workspace._id,
      granted_to_user_id: user?._id,
      granted_to_org_id: org?._id,
      granted_to_team_id: team?._id,
      role: args.role,
      created_by_user_id: actor._id,
      created_at: now,
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
    granted_to_team_public_id: v.optional(v.string()),
    granted_to_team_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (targetSelectorCount(args) !== 1) {
      throw new Error("Share revoke target must be exactly one grant, user, org, or team")
    }
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id)
    const team = await grantedTeam(ctx, args.granted_to_team_public_id, args.granted_to_team_id)
    const grants = args.grant_id
      ? [await ctx.db.get(args.grant_id)].filter((item: any) => item?.workspace_id === workspace._id)
      : await grantsForTarget(ctx, workspace._id, { user, org, team })
    const active = grants.filter((item: any) => item && !item.revoked_at)
    if (active.length === 0) return { revoked: false }
    const now = Date.now()
    for (const grant of active) await ctx.db.patch(grant._id, { revoked_at: now })
    const userIds = new Set<unknown>()
    for (const grant of active) {
      if (grant.granted_to_user_id) userIds.add(grant.granted_to_user_id)
      if (grant.granted_to_org_id) {
        for (const userId of await orgUserIds(ctx, grant.granted_to_org_id)) userIds.add(userId)
      }
      if (grant.granted_to_team_id) {
        for (const userId of await teamUserIds(ctx, grant.granted_to_team_id)) userIds.add(userId)
      }
    }
    return {
      revoked: true,
      runtime_tokens_revoked: await revokeRuntimeTokensForUsers(ctx, workspace._id, [...userIds]),
    }
  },
})
