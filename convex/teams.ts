import { v } from "convex/values"
import {
  authedMutation,
  authedQuery,
  orgAdminForUser,
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
  if (!await orgAdminForUser(ctx.db, actor._id, orgId)) throw new Error("org_admin_required")
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

async function resolveUser(ctx: any, args: {
  token_identifier?: string
  clerk_subject?: string
  user_public_id?: string
}) {
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
    return await Promise.all(rows.map(async (row: any) => {
      const user = await ctx.db.get(row.user_id)
      return {
        user_id: row.user_id,
        public_id: user?.public_id,
        display_name: user?.name,
        email: user?.email,
        token_identifier: user?.token_identifier,
        role: row.role,
      }
    }))
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
    const actor = await requireOrgAdmin(ctx, team.org_id)
    const now = Date.now()
    const existing = await ctx.db
      .query("team_project_grants")
      .withIndex("by_team_project", (q: any) =>
        q.eq("team_id", team._id).eq("project_id", args.project_id))
      .unique()
    if (existing && !existing.revoked_at && existing.role === args.role) {
      return { grant_id: existing._id }
    }
    if (existing) await ctx.db.patch(existing._id, { revoked_at: now })
    const grantId = await ctx.db.insert("team_project_grants", {
      team_id: team._id,
      project_id: args.project_id,
      role: args.role,
      created_by_user_id: actor._id,
      created_at: now,
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
      .withIndex("by_team_project", (q: any) =>
        q.eq("team_id", team._id).eq("project_id", args.project_id))
      .unique()
    if (!existing || existing.revoked_at) return { revoked: false }
    await ctx.db.patch(existing._id, { revoked_at: Date.now() })
    return { revoked: true }
  },
})

/** Ensure non-personal orgs have a default team with mirrored memberships and project grants. */
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

    const existingTeams = await ctx.db
      .query("teams")
      .withIndex("by_org", (q: any) => q.eq("org_id", org._id))
      .collect()
    let defaultTeam = existingTeams.find((team: any) => !team.deleted_at && team.is_default)
    const now = Date.now()
    if (!defaultTeam) {
      const publicId = publicTeamId()
      const teamDocId = await ctx.db.insert("teams", {
        public_id: publicId,
        org_id: org._id,
        name: org.name || "Everyone",
        is_default: true,
        created_by_user_id: actor._id,
        created_at: now,
        updated_at: now,
      })
      defaultTeam = await ctx.db.get(teamDocId)
    }
    if (!defaultTeam) throw new Error("default_team_missing")

    const orgMembers = await ctx.db
      .query("org_memberships")
      .withIndex("by_org_user", (q: any) => q.eq("org_id", org._id))
      .collect()
    for (const member of orgMembers) {
      const existing = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_user", (q: any) => q.eq("team_id", defaultTeam!._id).eq("user_id", member.user_id))
        .unique()
      if (existing) continue
      await ctx.db.insert("team_memberships", {
        team_id: defaultTeam._id,
        user_id: member.user_id,
        role: member.role === "owner" || member.role === "admin" ? member.role : "member",
        created_at: now,
        updated_at: now,
      })
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q: any) => q.eq("org_id", org._id))
      .collect()
    for (const project of projects) {
      if (project.deleted_at) continue
      const projectKey = project.project_id ?? project._id
      const grant = await ctx.db
        .query("team_project_grants")
        .withIndex("by_team_project", (q: any) =>
          q.eq("team_id", defaultTeam!._id).eq("project_id", projectKey))
        .unique()
      if (grant && !grant.revoked_at) continue
      if (grant) await ctx.db.patch(grant._id, { revoked_at: now })
      await ctx.db.insert("team_project_grants", {
        team_id: defaultTeam._id,
        project_id: projectKey,
        role: "editor",
        created_by_user_id: actor._id,
        created_at: now,
      })
    }

    // D18: retarget interim org-scoped shares onto the default team (no session backfill).
    const orgWorkspaceShares = await ctx.db
      .query("workspace_share_grants")
      .withIndex("by_org", (q: any) => q.eq("granted_to_org_id", org._id))
      .collect()
    let workspaceSharesRetargeted = 0
    for (const share of orgWorkspaceShares) {
      if (share.revoked_at) continue
      const existingTeam = await ctx.db
        .query("workspace_share_grants")
        .withIndex("by_workspace_team", (q: any) =>
          q.eq("workspace_id", share.workspace_id).eq("granted_to_team_id", defaultTeam!._id))
        .unique()
      if (existingTeam && !existingTeam.revoked_at) {
        await ctx.db.patch(share._id, { revoked_at: now })
        continue
      }
      await ctx.db.patch(share._id, {
        granted_to_org_id: undefined,
        granted_to_team_id: defaultTeam._id,
      })
      workspaceSharesRetargeted += 1
    }

    const orgSessionShares = await ctx.db
      .query("session_share_grants")
      .withIndex("by_org", (q: any) => q.eq("granted_to_org_id", org._id))
      .collect()
    let sessionSharesRetargeted = 0
    for (const share of orgSessionShares) {
      if (share.revoked_at) continue
      const existingTeam = await ctx.db
        .query("session_share_grants")
        .withIndex("by_session_team", (q: any) =>
          q.eq("session_id", share.session_id).eq("granted_to_team_id", defaultTeam!._id))
        .unique()
      if (existingTeam && !existingTeam.revoked_at) {
        await ctx.db.patch(share._id, { revoked_at: now })
        continue
      }
      await ctx.db.patch(share._id, {
        granted_to_org_id: undefined,
        granted_to_team_id: defaultTeam._id,
      })
      sessionSharesRetargeted += 1
    }

    return {
      team_id: defaultTeam.public_id,
      org_id: org._id,
      members: orgMembers.length,
      projects: projects.filter((p: any) => !p.deleted_at).length,
      workspace_shares_retargeted: workspaceSharesRetargeted,
      session_shares_retargeted: sessionSharesRetargeted,
    }
  },
})
