import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  authorizeWorkspaceForUser,
  orgAdminForUser,
  orgByClerkOrgId,
  readUser,
  upsertUser,
  userByClerkSubject,
  userByTokenIdentifier,
  workspaceByPublicId,
} from "./model"
import { sessionRoleForWorkspaceUser } from "./sessionAccess"

async function sessionPeopleAccess(
  ctx: any,
  args: { session_id: string; workspace_id: string },
) {
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
  const workspaceRole = await authorizeWorkspaceForUser(ctx, workspace, actor, "read")
  if (!workspaceRole) {
    throw new Error("session_share_admin_required")
  }
  const isCreator = session.created_by_user_id === actor._id
  const isOrgAdmin = await orgAdminForUser(ctx.db, actor._id, workspace.org_id)
  const isTeamAdmin = await teamAdminForProject(ctx, actor._id, workspace)
  const canManageShares = isCreator || isOrgAdmin || isTeamAdmin
  if (!canManageShares) {
    const role = await sessionRoleForWorkspaceUser(ctx, {
      user: actor,
      workspace,
      session,
      workspaceRole,
      isOrgAdmin,
    })
    if (!role) throw new Error("session_share_admin_required")
  }
  return { actor, workspace, session, canManageShares }
}

async function requireSessionShareAdmin(
  ctx: any,
  args: { session_id: string; workspace_id: string },
) {
  const access = await sessionPeopleAccess(ctx, args)
  if (!access.canManageShares) throw new Error("session_share_admin_required")
  return access
}

async function teamAdminForProject(ctx: any, userId: unknown, workspace: Record<string, any>) {
  if (!workspace.org_id || !workspace.project_id) return false
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect()
  for (const membership of memberships) {
    if (membership.role !== "admin" && membership.role !== "owner") continue
    const team = await ctx.db.get(membership.team_id)
    if (!team || team.deleted_at || team.org_id !== workspace.org_id) continue
    const grants = await ctx.db
      .query("team_project_grants")
      .withIndex("by_team_project", (q: any) =>
        q.eq("team_id", team._id).eq("project_id", workspace.project_id))
      .collect()
    if (grants.some((grant: any) => !grant.revoked_at)) return true
  }
  return false
}

async function grantedUser(ctx: any, args: {
  granted_to_token_identifier?: string
  granted_to_clerk_subject?: string
  granted_to_user_id?: string
}) {
  if (args.granted_to_user_id) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.granted_to_user_id))
      .unique()
    if (user) return user
    try {
      return await ctx.db.get(args.granted_to_user_id as never)
    } catch {
      return undefined
    }
  }
  if (args.granted_to_token_identifier) return await userByTokenIdentifier(ctx.db, args.granted_to_token_identifier)
  if (args.granted_to_clerk_subject) return await userByClerkSubject(ctx.db, args.granted_to_clerk_subject)
  return undefined
}

async function grantedOrg(ctx: any, clerkOrgId: string | undefined, orgId: string | undefined) {
  if (orgId) {
    try {
      return await ctx.db.get(orgId as never)
    } catch {
      return undefined
    }
  }
  if (!clerkOrgId) return undefined
  return await orgByClerkOrgId(ctx.db, clerkOrgId) ?? undefined
}

async function grantedTeam(ctx: any, teamPublicId: string | undefined, teamDocId: string | undefined) {
  if (teamDocId) {
    try {
      const team = await ctx.db.get(teamDocId as never)
      if (team && !team.deleted_at) return team
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

function targetCount(args: Record<string, unknown>) {
  return [
    args.granted_to_token_identifier,
    args.granted_to_clerk_subject,
    args.granted_to_user_id,
    args.granted_to_clerk_org_id,
    args.granted_to_org_id,
    args.granted_to_team_id,
    args.granted_to_team_public_id,
  ].filter(Boolean).length
}

async function orgUserIds(ctx: any, orgId: unknown) {
  return (await ctx.db
    .query("org_memberships")
    .withIndex("by_org_user", (q: any) => q.eq("org_id", orgId))
    .collect())
    .map((membership: any) => membership.user_id)
}

async function teamUserIds(ctx: any, teamId: unknown) {
  return (await ctx.db
    .query("team_memberships")
    .withIndex("by_team", (q: any) => q.eq("team_id", teamId))
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
      await ctx.db.patch(token._id, { revoked_at: now }),
    ))
  return rows.filter((token: any) => !token.revoked_at).length
}

function publicGrant(grant: any) {
  return {
    grant_id: grant._id,
    session_id: grant.session_id,
    workspace_id: grant.workspace_id,
    granted_to_user_id: grant.granted_to_user_id,
    granted_to_org_id: grant.granted_to_org_id,
    granted_to_team_id: grant.granted_to_team_id,
    created_by_user_id: grant.created_by_user_id,
    created_at: grant.created_at,
    revoked_at: grant.revoked_at,
  }
}

async function revokedFanoutTarget(ctx: any, grant: any) {
  if (grant.granted_to_user_id) {
    const user = await ctx.db.get(grant.granted_to_user_id)
    if (user?.token_identifier) return { grantedToTokenIdentifier: user.token_identifier }
    if (user?.clerk_subject) return { grantedToClerkSubject: user.clerk_subject }
    if (user?.public_id) return { grantedToUserId: user.public_id }
  }
  if (grant.granted_to_team_id) {
    const team = await ctx.db.get(grant.granted_to_team_id)
    if (team?.public_id) return { grantedToTeamPublicId: team.public_id }
  }
  if (grant.granted_to_org_id) {
    return { grantedToOrgId: String(grant.granted_to_org_id) }
  }
  return undefined
}

export const grant = authedMutation({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    granted_to_token_identifier: v.optional(v.string()),
    granted_to_clerk_subject: v.optional(v.string()),
    granted_to_user_id: v.optional(v.string()),
    granted_to_clerk_org_id: v.optional(v.string()),
    granted_to_org_id: v.optional(v.string()),
    granted_to_team_id: v.optional(v.string()),
    granted_to_team_public_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (targetCount(args) !== 1) throw new Error("session_share_target_required")
    const access = await requireSessionShareAdmin(ctx, args)
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id, args.granted_to_org_id)
    const team = await grantedTeam(ctx, args.granted_to_team_public_id, args.granted_to_team_id)
    if (!user && !org && !team) throw new Error("session_share_target_not_found")
    if (user && !await authorizeWorkspaceForUser(ctx, access.workspace, user, "read")) {
      throw new Error("session_participant_workspace_access_required")
    }
    if (team && team.org_id !== access.workspace.org_id) {
      throw new Error("session_share_team_org_mismatch")
    }
    if (org && access.workspace.org_id && org._id !== access.workspace.org_id) {
      throw new Error("session_share_org_mismatch")
    }
    const actor = await upsertUser(ctx)
    const existing = await ctx.db
      .query("session_share_grants")
      .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    const match = existing.filter((grant: any) => {
      if (grant.revoked_at) return false
      if (user) return grant.granted_to_user_id === user._id
      if (team) return grant.granted_to_team_id === team._id
      if (org) return grant.granted_to_org_id === org._id
      return false
    })
    if (match.length === 1) return { grant_id: match[0]._id }
    const now = Date.now()
    for (const grant of match) await ctx.db.patch(grant._id, { revoked_at: now })
    const grantId = await ctx.db.insert("session_share_grants", {
      session_id: args.session_id,
      workspace_id: access.workspace._id,
      granted_to_user_id: user?._id,
      granted_to_org_id: org?._id,
      granted_to_team_id: team?._id,
      created_by_user_id: actor._id,
      created_at: now,
    })
    return { grant_id: grantId }
  },
})

export const revoke = authedMutation({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
    grant_id: v.optional(v.id("session_share_grants")),
    granted_to_token_identifier: v.optional(v.string()),
    granted_to_clerk_subject: v.optional(v.string()),
    granted_to_user_id: v.optional(v.string()),
    granted_to_clerk_org_id: v.optional(v.string()),
    granted_to_org_id: v.optional(v.string()),
    granted_to_team_id: v.optional(v.string()),
    granted_to_team_public_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireSessionShareAdmin(ctx, args)
    const user = await grantedUser(ctx, args)
    const org = await grantedOrg(ctx, args.granted_to_clerk_org_id, args.granted_to_org_id)
    const team = await grantedTeam(ctx, args.granted_to_team_public_id, args.granted_to_team_id)
    const grants = args.grant_id
      ? [await ctx.db.get(args.grant_id)].filter((item: any) =>
        item?.session_id === args.session_id && item?.workspace_id === access.workspace._id)
      : (await ctx.db
        .query("session_share_grants")
        .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
        .collect())
        .filter((grant: any) => {
          if (user) return grant.granted_to_user_id === user._id
          if (team) return grant.granted_to_team_id === team._id
          if (org) return grant.granted_to_org_id === org._id
          return false
        })
    const active = grants.filter((item: any) => item && !item.revoked_at)
    if (active.length === 0) return { revoked: false, runtime_tokens_revoked: 0, revokedTargets: [] }
    const revokedTargets = (await Promise.all(active.map((grant: any) => revokedFanoutTarget(ctx, grant))))
      .filter((target): target is NonNullable<typeof target> => !!target)
    const now = Date.now()
    for (const grant of active) await ctx.db.patch(grant._id, { revoked_at: now })
    const userIds = new Set<unknown>()
    for (const grant of active) {
      if (grant.granted_to_user_id) userIds.add(grant.granted_to_user_id)
      if (grant.granted_to_org_id) {
        for (const id of await orgUserIds(ctx, grant.granted_to_org_id)) userIds.add(id)
      }
      if (grant.granted_to_team_id) {
        for (const id of await teamUserIds(ctx, grant.granted_to_team_id)) userIds.add(id)
      }
    }
    return {
      revoked: true,
      runtime_tokens_revoked: await revokeRuntimeTokensForUsers(ctx, access.workspace._id, [...userIds]),
      revokedTargets,
    }
  },
})

export const list = authedQuery({
  args: {
    session_id: v.string(),
    workspace_id: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await sessionPeopleAccess(ctx, args)
    if (!access.canManageShares) {
      return { can_manage_shares: false, grants: [], participants: [], teams: [] }
    }
    const [grants, participants, teams] = await Promise.all([
      ctx.db
        .query("session_share_grants")
        .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
        .collect(),
      ctx.db
        .query("session_participants")
        .withIndex("by_session_user", (q: any) => q.eq("session_id", args.session_id))
        .collect(),
      access.workspace.org_id
        ? ctx.db
          .query("teams")
          .withIndex("by_org", (q: any) => q.eq("org_id", access.workspace.org_id))
          .collect()
        : [],
    ])
    const sharedTeamIds = new Set(grants
      .filter((grant: any) => !grant.revoked_at && grant.granted_to_team_id)
      .map((grant: any) => grant.granted_to_team_id))
    return {
      can_manage_shares: true,
      grants: grants.filter((grant: any) => !grant.revoked_at).map(publicGrant),
      participants: participants
        .filter((row: any) => !row.revoked_at)
        .map((row: any) => ({
          user_id: row.user_id,
          added_by_user_id: row.added_by_user_id,
          created_at: row.created_at,
        })),
      teams: teams
        .filter((team: any) => !team.deleted_at)
        .map((team: any) => ({
          team_id: team.public_id,
          name: team.name,
          is_shared: sharedTeamIds.has(team._id),
        }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    }
  },
})
