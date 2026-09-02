import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  orgAdminForUser,
  projectByPublicId,
  readUser,
  upsertUser,
  userByTokenIdentifier,
  userByClerkSubject,
} from "./model"

function publicTeamId() {
  return `team_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

async function requireOrgAdmin(ctx: any, orgId: unknown) {
  const actor = await readUser(ctx)
  if (!(await orgAdminForUser(ctx.db, actor._id, orgId))) throw new Error("org_admin_required")
  return actor
}

async function orgById(ctx: any, orgId: string) {
  try {
    const org = await ctx.db.get(orgId as never)
    if (!org || org.deleted_at) return undefined
    return org
  } catch {
    return undefined
  }
}

async function defaultTeamForOrg(ctx: any, orgId: unknown) {
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_org_default", (q: any) => q.eq("org_id", orgId).eq("is_default", true).eq("deleted_at", undefined))
    .collect()
  if (teams.length > 1) throw new Error("default_team_duplicate")
  return teams[0]
}

export async function ensureDefaultTeam(
  ctx: any,
  input: {
    org: any
    creatorUserId: unknown
    now: number
  },
) {
  const existing = await defaultTeamForOrg(ctx, input.org._id)
  if (existing) return existing
  const publicId = publicTeamId()
  const teamId = await ctx.db.insert("teams", {
    public_id: publicId,
    org_id: input.org._id,
    name: input.org.name || "Everyone",
    is_default: true,
    created_by_user_id: input.creatorUserId,
    created_at: input.now,
    updated_at: input.now,
  })
  const team = await ctx.db.get(teamId)
  if (!team) throw new Error("default_team_missing")
  return team
}

export async function ensureDefaultTeamMembership(
  ctx: any,
  input: {
    orgId: unknown
    userId: unknown
    role: "member" | "admin" | "owner"
    creatorUserId: unknown
    now: number
  },
) {
  const org = await ctx.db.get(input.orgId)
  if (!org || org.deleted_at || org.kind === "personal") return undefined
  const team = await ensureDefaultTeam(ctx, {
    org,
    creatorUserId: input.creatorUserId,
    now: input.now,
  })
  const existing = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_user", (q: any) => q.eq("team_id", team._id).eq("user_id", input.userId))
    .unique()
  if (existing) {
    if (existing.role !== input.role) await ctx.db.patch(existing._id, { role: input.role, updated_at: input.now })
    return team
  }
  await ctx.db.insert("team_memberships", {
    team_id: team._id,
    user_id: input.userId,
    role: input.role,
    created_at: input.now,
    updated_at: input.now,
  })
  return team
}

/**
 * Every `team_memberships` row this user holds in this org, removed.
 *
 * This used to be `removeDefaultTeamMembership`, and dropped ONLY the default
 * team's row. That was a standing-access hole: `teams.addMember` can put a user
 * in any number of non-default teams, and `model.ts teamProjectRole` /
 * `teamShareRole` resolve a WorkspaceRole from those rows. So an org membership
 * that was removed (Clerk webhook, or the reconcile sweep) left the ex-member
 * holding every team-conferred role they had outside the default team —
 * including admin, which is enough to re-mint runtime access tokens.
 *
 * Read through `by_user` rather than by walking the org's teams: the bound is
 * then the user's team count, not the org's team count. Deleted teams are
 * included on purpose — the membership row is what confers the role, and
 * leaving it behind would make an un-delete restore revoked access.
 *
 * Returns the number of rows removed so the caller can record it (the audit
 * trail for a revocation should say how much was actually taken away).
 */
export async function removeOrgTeamMemberships(ctx: any, input: { orgId: unknown; userId: unknown }) {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user", (q: any) => q.eq("user_id", input.userId))
    .collect()
  let removed = 0
  for (const membership of memberships) {
    const team = await ctx.db.get(membership.team_id)
    if (!team || team.org_id !== input.orgId) continue
    await ctx.db.delete(membership._id)
    removed += 1
  }
  return removed
}

export async function ensureDefaultTeamProjectGrant(
  ctx: any,
  input: {
    orgId: unknown
    projectId: string
    creatorUserId: unknown
    now: number
  },
) {
  const org = await ctx.db.get(input.orgId)
  if (!org || org.deleted_at || org.kind === "personal") return undefined
  const team = await ensureDefaultTeam(ctx, {
    org,
    creatorUserId: input.creatorUserId,
    now: input.now,
  })
  await upsertTeamProjectGrant(ctx, {
    teamId: team._id,
    projectId: input.projectId,
    role: "editor",
    creatorUserId: input.creatorUserId,
    now: input.now,
    reactivateRevoked: false,
  })
  return team
}

async function upsertTeamProjectGrant(
  ctx: any,
  input: {
    teamId: unknown
    projectId: string
    role: "viewer" | "editor" | "admin"
    creatorUserId: unknown
    now: number
    reactivateRevoked?: boolean
  },
) {
  const existing = await ctx.db
    .query("team_project_grants")
    .withIndex("by_team_project", (q: any) => q.eq("team_id", input.teamId).eq("project_id", input.projectId))
    .collect()
  const keeper = existing.find((grant: any) => !grant.revoked_at) ?? existing[0]
  if (!keeper) {
    return await ctx.db.insert("team_project_grants", {
      team_id: input.teamId,
      project_id: input.projectId,
      role: input.role,
      created_by_user_id: input.creatorUserId,
      created_at: input.now,
    })
  }
  if (keeper.revoked_at && input.reactivateRevoked === false) return keeper._id
  if (keeper.revoked_at || keeper.role !== input.role) {
    await ctx.db.patch(keeper._id, {
      role: input.role,
      created_by_user_id: input.creatorUserId,
      created_at: input.now,
      revoked_at: undefined,
    })
  }
  for (const duplicate of existing) {
    if (duplicate._id !== keeper._id && !duplicate.revoked_at) {
      await ctx.db.patch(duplicate._id, { revoked_at: input.now })
    }
  }
  return keeper._id
}

async function resolveUser(
  ctx: any,
  args: {
    token_identifier?: string
    clerk_subject?: string
    user_public_id?: string
  },
) {
  if (args.user_public_id) {
    const byPublic = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.user_public_id))
      .unique()
    if (byPublic) return byPublic
  }
  if (args.token_identifier) return await userByTokenIdentifier(ctx.db, args.token_identifier)
  if (args.clerk_subject) return await userByClerkSubject(ctx.db, args.clerk_subject)
  return undefined
}

export const listForOrg = authedQuery({
  args: { org_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await readUser(ctx)
    const org = await orgById(ctx, args.org_id)
    if (!org) return []
    const membership = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id).eq("user_id", actor._id))
      .unique()
    if (!membership && org.owner_user_id !== actor._id) return []
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_org", (q: any) => q.eq("org_id", org._id))
      .collect()
    return teams
      .filter((team: any) => !team.deleted_at)
      .map((team: any) => ({
        team_id: team.public_id,
        org_id: org._id,
        name: team.name,
        is_default: team.is_default === true,
      }))
  },
})

export const create = authedMutation({
  args: {
    org_id: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim()
    if (!name) throw new Error("team_name_required")
    const org = await orgById(ctx, args.org_id)
    if (!org) throw new Error("Organization not found")
    if (org.kind === "personal") throw new Error("team_not_allowed_on_personal_org")
    const actor = await requireOrgAdmin(ctx, org._id)
    const now = Date.now()
    const publicId = publicTeamId()
    const teamId = await ctx.db.insert("teams", {
      public_id: publicId,
      org_id: org._id,
      name,
      is_default: false,
      created_by_user_id: actor._id,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("team_memberships", {
      team_id: teamId,
      user_id: actor._id,
      role: "owner",
      created_at: now,
      updated_at: now,
    })
    return { team_id: publicId, name, role: "owner" as const }
  },
})

export const addMember = authedMutation({
  args: {
    team_id: v.string(),
    token_identifier: v.optional(v.string()),
    clerk_subject: v.optional(v.string()),
    user_public_id: v.optional(v.string()),
    role: v.optional(v.union(v.literal("member"), v.literal("admin"), v.literal("owner"))),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.team_id))
      .unique()
    if (!team || team.deleted_at) throw new Error("Team not found")
    await requireOrgAdmin(ctx, team.org_id)
    const user = await resolveUser(ctx, args)
    if (!user) throw new Error("team_member_not_found")
    const orgMembership = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", team.org_id).eq("user_id", user._id))
      .unique()
    if (!orgMembership) throw new Error("team_member_org_membership_required")
    const role = args.role ?? "member"
    const existing = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_user", (q: any) => q.eq("team_id", team._id).eq("user_id", user._id))
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { role, updated_at: now })
      return { team_id: team.public_id, user_id: user._id, role }
    }
    await ctx.db.insert("team_memberships", {
      team_id: team._id,
      user_id: user._id,
      role,
      created_at: now,
      updated_at: now,
    })
    return { team_id: team.public_id, user_id: user._id, role }
  },
})

export const removeMember = authedMutation({
  args: {
    team_id: v.string(),
    token_identifier: v.optional(v.string()),
    clerk_subject: v.optional(v.string()),
    user_public_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.team_id))
      .unique()
    if (!team || team.deleted_at) throw new Error("Team not found")
    await requireOrgAdmin(ctx, team.org_id)
    const user = await resolveUser(ctx, args)
    if (!user) return { removed: false }
    const existing = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_user", (q: any) => q.eq("team_id", team._id).eq("user_id", user._id))
      .unique()
    if (!existing) return { removed: false }
    await ctx.db.delete(existing._id)
    return { removed: true }
  },
})

export const listMembers = authedQuery({
  args: { team_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await readUser(ctx)
    const team = await ctx.db
      .query("teams")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.team_id))
      .unique()
    if (!team || team.deleted_at) return []
    const orgMembership = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", team.org_id).eq("user_id", actor._id))
      .unique()
    if (!orgMembership && !(await orgAdminForUser(ctx.db, actor._id, team.org_id))) return []
    const rows = await ctx.db
      .query("team_memberships")
      .withIndex("by_team", (q: any) => q.eq("team_id", team._id))
      .collect()
    return await Promise.all(
      rows.map(async (row: any) => {
        const user = await ctx.db.get(row.user_id)
        return {
          user_id: row.user_id,
          public_id: user?.public_id,
          display_name: user?.name,
          email: user?.email,
          token_identifier: user?.token_identifier,
          role: row.role,
        }
      }),
    )
  },
})

export const grantProject = authedMutation({
  args: {
    team_id: v.string(),
    project_id: v.string(),
    role: v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.team_id))
      .unique()
    if (!team || team.deleted_at) throw new Error("Team not found")
    const [actor, project] = await Promise.all([
      requireOrgAdmin(ctx, team.org_id),
      projectByPublicId(ctx.db, args.project_id, team.org_id),
    ])
    if (!project || project.deleted_at) throw new Error("Project not found")
    const now = Date.now()
    const grantId = await upsertTeamProjectGrant(ctx, {
      teamId: team._id,
      projectId: args.project_id,
      role: args.role,
      creatorUserId: actor._id,
      now,
    })
    return { grant_id: grantId }
  },
})

export const revokeProject = authedMutation({
  args: {
    team_id: v.string(),
    project_id: v.string(),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_public_id", (q: any) => q.eq("public_id", args.team_id))
      .unique()
    if (!team || team.deleted_at) throw new Error("Team not found")
    await requireOrgAdmin(ctx, team.org_id)
    const existing = await ctx.db
      .query("team_project_grants")
      .withIndex("by_team_project", (q: any) => q.eq("team_id", team._id).eq("project_id", args.project_id))
      .collect()
    const active = existing.filter((grant: any) => !grant.revoked_at)
    if (active.length === 0) return { revoked: false }
    const now = Date.now()
    for (const grant of active) await ctx.db.patch(grant._id, { revoked_at: now })
    return { revoked: true }
  },
})

/**
 * Provision the caller's default team membership. Historical reconciliation is
 * deliberately ledger-backed in migrations.ts; this request-path mutation must
 * not scan every org member, project, or share on each navigation.
 */
export const ensureDefaultTeamForOrg = authedMutation({
  args: { org_id: v.string() },
  handler: async (ctx, args) => {
    const actor = await upsertUser(ctx)
    const org = await orgById(ctx, args.org_id)
    if (!org) throw new Error("Organization not found")
    if (org.kind === "personal") return { skipped: true as const }
    const membership = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id).eq("user_id", actor._id))
      .unique()
    if (!membership && org.owner_user_id !== actor._id) throw new Error("org_membership_required")

    const now = Date.now()
    const defaultTeam = await ensureDefaultTeamMembership(ctx, {
      orgId: org._id,
      userId: actor._id,
      role: membership?.role ?? "owner",
      creatorUserId: actor._id,
      now,
    })
    if (!defaultTeam) throw new Error("default_team_missing")
    return {
      team_id: defaultTeam.public_id,
      org_id: org._id,
    }
  },
})
