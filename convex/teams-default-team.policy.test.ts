import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"
import {
  backfillDefaultTeamForOrg,
  backfillDefaultTeamMembership,
  backfillDefaultTeamProjectGrant,
  backfillDefaultTeamSessionShare,
  backfillDefaultTeamWorkspaceShare,
} from "./migrations"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

async function runDefaultTeamBackfill(ctx: any, orgId: any) {
  const org = await ctx.db.get(orgId)
  if (!org) throw new Error("legacy org fixture disappeared")
  await backfillDefaultTeamForOrg(ctx, org)
  for (const membership of await ctx.db.query("org_memberships").collect()) {
    await backfillDefaultTeamMembership(ctx, membership)
  }
  for (const project of await ctx.db.query("projects").collect()) {
    await backfillDefaultTeamProjectGrant(ctx, project)
  }
  for (const share of await ctx.db.query("workspace_share_grants").collect()) {
    await backfillDefaultTeamWorkspaceShare(ctx, share)
  }
  for (const share of await ctx.db.query("session_share_grants").collect()) {
    await backfillDefaultTeamSessionShare(ctx, share)
  }
}

describe("default-team provisioning", () => {
  test("listForOrg is read-only and does not provision a missing default team", async () => {
    const t = convexTest(schema, modules)
    const orgId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", stamped({ token_identifier: "owner", kind: "human" }) as never)
      const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", kind: "team", owner_user_id: userId }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "owner" }) as never)
      return orgId
    })

    const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" })
    await expect(owner.query(api.teams.listForOrg, { org_id: orgId } as never)).resolves.toEqual([])
    await t.run(async (ctx) => {
      expect(await ctx.db.query("teams").collect()).toEqual([])
    })
  })

  test("team and workspace writers keep the default team membership and project grant current", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" })
    const org = await owner.mutation(api.orgs.createTeam, { name: "Acme" } as never)
    await owner.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_default_grant",
      org_id: org.org_id,
      display_name: "Default grant",
    } as never)

    await t.run(async (ctx) => {
      const team = (await ctx.db.query("teams").collect()).find((candidate) => candidate.is_default)
      const ownerUser = await ctx.db
        .query("users")
        .withIndex("by_token_identifier", (q) => q.eq("token_identifier", "owner"))
        .unique()
      const project = await ctx.db.query("projects").unique()
      expect(team).toBeDefined()
      expect(ownerUser).toBeDefined()
      expect(project).toBeDefined()
      expect(
        await ctx.db
          .query("team_memberships")
          .withIndex("by_team_user", (q) => q.eq("team_id", team!._id).eq("user_id", ownerUser!._id))
          .unique(),
      ).toMatchObject({ role: "owner" })
      expect(
        await ctx.db
          .query("team_project_grants")
          .withIndex("by_team_project", (q) => q.eq("team_id", team!._id).eq("project_id", project!.project_id!))
          .unique(),
      ).toMatchObject({ role: "editor" })
    })
  })

  test("workspace provisioning never reactivates a revoked default-team project grant", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" })
    const org = await owner.mutation(api.orgs.createTeam, { name: "Acme" } as never)
    await owner.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_before_revoke",
      org_id: org.org_id,
      project_id: "prj_revoked",
      repo_url: "https://github.com/acme/repo.git",
      display_name: "Before revoke",
    } as never)
    const defaultTeam = await t.run(async (ctx) =>
      (await ctx.db.query("teams").collect()).find((candidate) => candidate.is_default),
    )
    expect(defaultTeam).toBeDefined()
    await owner.mutation(api.teams.revokeProject, {
      team_id: defaultTeam!.public_id,
      project_id: "prj_revoked",
    } as never)

    await owner.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_after_revoke",
      org_id: org.org_id,
      project_id: "prj_revoked",
      repo_url: "https://github.com/acme/repo.git",
      display_name: "After revoke",
    } as never)

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("team_project_grants")
        .withIndex("by_team_project", (q) => q.eq("team_id", defaultTeam!._id).eq("project_id", "prj_revoked"))
        .unique()
      expect(grant?.revoked_at).toEqual(expect.any(Number))
    })
  })

  test("project grants accept only live projects owned by the team's organization", async () => {
    const t = convexTest(schema, modules)
    const owner = t.withIdentity({ tokenIdentifier: "owner", subject: "owner" })
    const primaryOrg = await owner.mutation(api.orgs.createTeam, { name: "Primary" } as never)
    const otherOrg = await owner.mutation(api.orgs.createTeam, { name: "Other" } as never)
    const fixture = await t.run(async (ctx) => {
      const ownerUser = await ctx.db
        .query("users")
        .withIndex("by_token_identifier", (q) => q.eq("token_identifier", "owner"))
        .unique()
      const team = (await ctx.db.query("teams").collect()).find((candidate) => candidate.org_id === primaryOrg.org_id)
      expect(ownerUser).toBeDefined()
      expect(team).toBeDefined()
      await ctx.db.insert(
        "projects",
        stamped({
          project_id: "prj_primary",
          org_id: primaryOrg.org_id,
          owner_user_id: ownerUser!._id,
        }) as never,
      )
      await ctx.db.insert(
        "projects",
        stamped({
          project_id: "prj_other",
          org_id: otherOrg.org_id,
          owner_user_id: ownerUser!._id,
        }) as never,
      )
      await ctx.db.insert(
        "projects",
        stamped({
          project_id: "prj_deleted",
          org_id: primaryOrg.org_id,
          owner_user_id: ownerUser!._id,
          deleted_at: 2,
        }) as never,
      )
      return { teamPublicId: team!.public_id }
    })

    await expect(
      owner.mutation(api.teams.grantProject, {
        team_id: fixture.teamPublicId,
        project_id: "prj_primary",
        role: "editor",
      } as never),
    ).resolves.toMatchObject({ grant_id: expect.anything() })
    await owner.mutation(api.teams.revokeProject, {
      team_id: fixture.teamPublicId,
      project_id: "prj_primary",
    } as never)
    await expect(
      owner.mutation(api.teams.grantProject, {
        team_id: fixture.teamPublicId,
        project_id: "prj_primary",
        role: "viewer",
      } as never),
    ).resolves.toMatchObject({ grant_id: expect.anything() })
    await t.run(async (ctx) => {
      const team = (await ctx.db.query("teams").collect()).find(
        (candidate) => candidate.public_id === fixture.teamPublicId,
      )
      const grant = await ctx.db
        .query("team_project_grants")
        .withIndex("by_team_project", (q) => q.eq("team_id", team!._id).eq("project_id", "prj_primary"))
        .unique()
      expect(grant).toMatchObject({ role: "viewer" })
      expect(grant).not.toHaveProperty("revoked_at")
    })
    for (const projectId of ["prj_missing", "prj_other", "prj_deleted"]) {
      await expect(
        owner.mutation(api.teams.grantProject, {
          team_id: fixture.teamPublicId,
          project_id: projectId,
          role: "editor",
        } as never),
      ).rejects.toThrow("Project not found")
    }
  })

  test("the ledger backfill converges historical memberships, projects, and org shares", async () => {
    const t = convexTest(schema, modules)
    const orgId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner", kind: "human" }) as never)
      const memberId = await ctx.db.insert("users", stamped({ token_identifier: "member", kind: "human" }) as never)
      const orgId = await ctx.db.insert(
        "orgs",
        stamped({ name: "Legacy", kind: "team", owner_user_id: ownerId }) as never,
      )
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: ownerId, role: "owner" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: memberId, role: "member" }) as never)
      await ctx.db.insert(
        "projects",
        stamped({ project_id: "prj_legacy", org_id: orgId, owner_user_id: ownerId }) as never,
      )
      const workspaceId = await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_legacy",
          org_id: orgId,
          owner_user_id: ownerId,
          project_id: "prj_legacy",
          backing: "cloud-vm",
          access: "cloud",
          display_name: "Legacy",
        }) as never,
      )
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_org_id: orgId,
        role: "editor",
        created_by_user_id: ownerId,
        created_at: 1,
      })
      await ctx.db.insert("session_share_grants", {
        session_id: "ses_legacy",
        workspace_id: workspaceId,
        granted_to_org_id: orgId,
        created_by_user_id: ownerId,
        created_at: 1,
      })
      return orgId
    })

    await t.run(async (ctx) => {
      await runDefaultTeamBackfill(ctx, orgId)
      await runDefaultTeamBackfill(ctx, orgId)
    })

    await t.run(async (ctx) => {
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_org", (q) => q.eq("org_id", orgId))
        .collect()
      expect(teams).toHaveLength(1)
      const team = teams[0]!
      expect(
        await ctx.db
          .query("team_memberships")
          .withIndex("by_team", (q) => q.eq("team_id", team._id))
          .collect(),
      ).toHaveLength(2)
      expect(
        await ctx.db
          .query("team_project_grants")
          .withIndex("by_team_project", (q) => q.eq("team_id", team._id).eq("project_id", "prj_legacy"))
          .collect(),
      ).toHaveLength(1)
      const workspaceShare = await ctx.db
        .query("workspace_share_grants")
        .withIndex("by_team", (q) => q.eq("granted_to_team_id", team._id))
        .unique()
      const sessionShare = await ctx.db
        .query("session_share_grants")
        .withIndex("by_team", (q) => q.eq("granted_to_team_id", team._id))
        .unique()
      expect(workspaceShare).not.toHaveProperty("granted_to_org_id")
      expect(workspaceShare).not.toHaveProperty("revoked_at")
      expect(sessionShare).not.toHaveProperty("granted_to_org_id")
      expect(sessionShare).not.toHaveProperty("revoked_at")
    })
  })

  test("the ledger backfill reactivates one canonical row without ambiguous active identities", async () => {
    const t = convexTest(schema, modules)
    const fixture = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner", kind: "human" }) as never)
      const orgId = await ctx.db.insert(
        "orgs",
        stamped({ name: "Legacy", kind: "team", owner_user_id: ownerId }) as never,
      )
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: ownerId, role: "owner" }) as never)
      const teamId = await ctx.db.insert(
        "teams",
        stamped({
          public_id: "team_default",
          org_id: orgId,
          name: "Everyone",
          is_default: true,
          created_by_user_id: ownerId,
        }) as never,
      )
      await ctx.db.insert(
        "projects",
        stamped({ project_id: "prj_legacy", org_id: orgId, owner_user_id: ownerId }) as never,
      )
      await ctx.db.insert("team_project_grants", {
        team_id: teamId,
        project_id: "prj_legacy",
        role: "viewer",
        created_by_user_id: ownerId,
        created_at: 1,
        revoked_at: 2,
      })
      const workspaceId = await ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_legacy",
          org_id: orgId,
          owner_user_id: ownerId,
          project_id: "prj_legacy",
          backing: "cloud-vm",
          access: "cloud",
          display_name: "Legacy",
        }) as never,
      )
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_org_id: orgId,
        role: "admin",
        created_by_user_id: ownerId,
        created_at: 3,
      })
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_team_id: teamId,
        role: "viewer",
        created_by_user_id: ownerId,
        created_at: 1,
        revoked_at: 2,
      })
      await ctx.db.insert("session_share_grants", {
        session_id: "ses_legacy",
        workspace_id: workspaceId,
        granted_to_org_id: orgId,
        created_by_user_id: ownerId,
        created_at: 3,
      })
      await ctx.db.insert("session_share_grants", {
        session_id: "ses_legacy",
        workspace_id: workspaceId,
        granted_to_team_id: teamId,
        created_by_user_id: ownerId,
        created_at: 1,
        revoked_at: 2,
      })
      return { orgId, teamId, workspaceId }
    })

    await t.run(async (ctx) => {
      await runDefaultTeamBackfill(ctx, fixture.orgId)
      await runDefaultTeamBackfill(ctx, fixture.orgId)
    })

    await t.run(async (ctx) => {
      const grants = await ctx.db
        .query("team_project_grants")
        .withIndex("by_team_project", (q) => q.eq("team_id", fixture.teamId).eq("project_id", "prj_legacy"))
        .collect()
      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({ role: "editor" })
      expect(grants[0]).not.toHaveProperty("revoked_at")

      const workspaceShares = await ctx.db
        .query("workspace_share_grants")
        .withIndex("by_workspace_team", (q) =>
          q.eq("workspace_id", fixture.workspaceId).eq("granted_to_team_id", fixture.teamId),
        )
        .collect()
      expect(workspaceShares).toHaveLength(1)
      expect(workspaceShares[0]).toMatchObject({ role: "admin" })
      expect(workspaceShares[0]).not.toHaveProperty("revoked_at")

      const sessionShares = await ctx.db
        .query("session_share_grants")
        .withIndex("by_session_team", (q) => q.eq("session_id", "ses_legacy").eq("granted_to_team_id", fixture.teamId))
        .collect()
      expect(sessionShares).toHaveLength(1)
      expect(sessionShares[0]).not.toHaveProperty("revoked_at")
    })
  })
})
