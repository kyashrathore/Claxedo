import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { internal } from "./_generated/api"
import { workspaceRoleForUser } from "./model"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/** `workspace_share_grants` declares no `updated_at`; every other table here does. */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

/**
 * Removing an org membership must remove every role that membership stood
 * behind — by BOTH mirror paths, and at parity.
 *
 * WHY THIS IS A SECURITY SUITE. `teams.addMember` demands an `org_memberships`
 * row to add someone to a team (`team_member_org_membership_required`), but
 * `model.ts teamProjectRole`/`teamShareRole` never re-read that row: a
 * `team_memberships` row alone resolves to a WorkspaceRole, up to admin, and an
 * admin can mint runtime access tokens (`runtimeAccessTokens.recordMint` needs
 * only read). So a membership revocation that leaves team rows behind revokes
 * nothing the authorization path actually consults, and `org_memberships` has
 * no TTL to end it.
 *
 * The revocation reaches Convex two ways — the Clerk webhook
 * (`orgs.applyClerkWebhook`) and the reconcile sweep
 * (`clerkReconcile.applyReconcileCorrections`, which exists precisely because
 * the webhook can be dropped for days). Both are asserted here against the same
 * fixture, because a fallback that does less than the path it backstops is not
 * a fallback.
 */
async function seedOrgMemberWithTeams(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", stamped({
      token_identifier: "token_owner",
      clerk_subject: "clerk_owner",
      kind: "human",
    }) as never)
    const bobId = await ctx.db.insert("users", stamped({
      token_identifier: "token_bob",
      clerk_subject: "clerk_bob",
      kind: "human",
    }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({
      clerk_org_id: "clerk_org_1",
      kind: "clerk",
      name: "Acme",
      owner_user_id: ownerId,
    }) as never)
    // A second tenant Bob legitimately belongs to. Nothing done to his Acme
    // membership may touch it — a sweep that over-deletes is its own outage.
    const otherOrgId = await ctx.db.insert("orgs", stamped({
      clerk_org_id: "clerk_org_other",
      kind: "clerk",
      name: "Other",
      owner_user_id: bobId,
    }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: ownerId, role: "owner" }) as never)
    const membershipId = await ctx.db.insert("org_memberships", stamped({
      org_id: orgId,
      user_id: bobId,
      role: "member",
    }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: otherOrgId, user_id: bobId, role: "owner" }) as never)

    const defaultTeamId = await ctx.db.insert("teams", stamped({
      public_id: "team_everyone",
      org_id: orgId,
      name: "Everyone",
      is_default: true,
      created_by_user_id: ownerId,
    }) as never)
    // The row the old `removeDefaultTeamMembership` left behind.
    const secretTeamId = await ctx.db.insert("teams", stamped({
      public_id: "team_secret",
      org_id: orgId,
      name: "Platform",
      created_by_user_id: ownerId,
    }) as never)
    const otherTeamId = await ctx.db.insert("teams", stamped({
      public_id: "team_other_org",
      org_id: otherOrgId,
      name: "Other Everyone",
      is_default: true,
      created_by_user_id: bobId,
    }) as never)
    for (const teamId of [defaultTeamId, secretTeamId, otherTeamId]) {
      await ctx.db.insert("team_memberships", stamped({ team_id: teamId, user_id: bobId, role: "member" }) as never)
    }

    const workspaceId = await ctx.db.insert("workspaces", stamped({
      workspace_id: "ws_acme",
      org_id: orgId,
      owner_user_id: ownerId,
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Acme workspace",
    }) as never)
    await ctx.db.insert("workspace_share_grants", {
      workspace_id: workspaceId,
      granted_to_team_id: secretTeamId,
      role: "admin",
      created_by_user_id: ownerId,
      created_at: 1,
    } as never)
    return { ownerId, bobId, orgId, otherOrgId, defaultTeamId, secretTeamId, otherTeamId, membershipId, workspaceId }
  })
}

/**
 * Bob's `team_memberships` rows, split by the org that owns each team.
 *
 * Whole-table `.collect()` on purpose: `ReturnType<typeof convexTest>` drops the
 * schema generic, so `ctx.db` inside a shared helper is schemaless and cannot
 * name an index. The fixture is a handful of rows, and this matches the
 * `membershipRows`/`auditRows` helpers in clerk-reconcile.policy.test.ts.
 */
async function bobTeamMemberships(t: ReturnType<typeof convexTest>, bobId: unknown, orgId: unknown) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("team_memberships").collect())
      .filter((row: any) => row.user_id === bobId)
    const teams = await Promise.all(rows.map(async (row: any) => await ctx.db.get(row.team_id)))
    return {
      inOrg: teams.filter((team: any) => team?.org_id === orgId).map((team: any) => team.public_id),
      elsewhere: teams.filter((team: any) => team?.org_id !== orgId).map((team: any) => team.public_id),
    }
  })
}

/**
 * Bob's resolved role on the shared workspace, or the string "none".
 *
 * `t.run` returns a Convex value, and the codec turns `undefined` into `null` —
 * so a bare `toBeUndefined()` here would be asserting a harness artifact.
 * `?? "none"` keeps "resolved no role at all" a value the test states outright.
 */
async function bobWorkspaceRole(t: ReturnType<typeof convexTest>, bobId: unknown) {
  return await t.run(async (ctx) => {
    const workspace = (await ctx.db.query("workspaces").collect())
      .find((row: any) => row.workspace_id === "ws_acme")
    return await workspaceRoleForUser(ctx, workspace as never, { _id: bobId }) ?? "none"
  })
}

describe("org membership revocation removes every team-conferred role", () => {
  test("the fixture really does confer admin through the non-default team", async () => {
    // Positive control. Without it, every "returns no role" assertion below
    // would pass just as happily against a fixture that never granted anything.
    const t = convexTest(schema, modules)
    const { bobId } = await seedOrgMemberWithTeams(t)
    expect(await bobWorkspaceRole(t, bobId)).toBe("admin")
  })

  test("organizationMembership.deleted removes the non-default team rows too", async () => {
    const t = convexTest(schema, modules)
    const { bobId, orgId } = await seedOrgMemberWithTeams(t)

    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organizationMembership.deleted",
      data: {
        organization: { id: "clerk_org_1" },
        public_user_data: { user_id: "clerk_bob" },
      },
    } as never)

    expect(await bobTeamMemberships(t, bobId, orgId)).toEqual({
      inOrg: [],
      elsewhere: ["team_other_org"],
    })
    expect(await bobWorkspaceRole(t, bobId)).toBe("none")
  })

  test("the webhook records how many team memberships the revocation removed", async () => {
    const t = convexTest(schema, modules)
    await seedOrgMemberWithTeams(t)

    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organizationMembership.deleted",
      data: {
        organization: { id: "clerk_org_1" },
        public_user_data: { user_id: "clerk_bob" },
      },
    } as never)

    const audit = await t.run(async (ctx) => await ctx.db.query("audit_events").collect())
    expect(audit.find((row) => row.action === "org.membership.revoked")).toMatchObject({
      metadata: { team_memberships_removed: 2, source: "webhook" },
    })
  })

  test("a reconcile revoke removes the same rows the webhook would have", async () => {
    const t = convexTest(schema, modules)
    const { bobId, orgId, membershipId } = await seedOrgMemberWithTeams(t)

    const result = await t.mutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: "clerk_org_1",
      observed_at: 9_000,
      corrections: [{
        kind: "revoke",
        membership_id: String(membershipId),
        clerk_subject: "clerk_bob",
        role: "member",
      }],
    } as never)

    expect(result).toEqual({ applied: 1, skipped: 0 })
    expect(await bobTeamMemberships(t, bobId, orgId)).toEqual({
      inOrg: [],
      elsewhere: ["team_other_org"],
    })
    expect(await bobWorkspaceRole(t, bobId)).toBe("none")
  })

  test("a stranded team membership confers no workspace role on its own", async () => {
    // Defence in depth, independent of the two deletion paths above: whatever
    // leaves a `team_memberships` row behind — a dropped webhook, a grant
    // written before the workspaceShares tenant fence — the row alone must not
    // resolve to a role once the org membership is gone.
    const t = convexTest(schema, modules)
    const { bobId, orgId } = await seedOrgMemberWithTeams(t)
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("org_memberships")
        .withIndex("by_org_user", (q) => q.eq("org_id", orgId as never).eq("user_id", bobId as never))
        .unique()
      await ctx.db.delete(membership!._id)
    })

    // The team rows are deliberately still there — this is the belt, not the braces.
    expect((await bobTeamMemberships(t, bobId, orgId)).inOrg).toEqual(["team_everyone", "team_secret"])
    expect(await bobWorkspaceRole(t, bobId)).toBe("none")
  })
})

describe("reconcile sweep provisions team membership at webhook parity", () => {
  async function seedOrgWithoutMember(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({
        token_identifier: "token_owner",
        clerk_subject: "clerk_owner",
      }) as never)
      const bobId = await ctx.db.insert("users", stamped({
        token_identifier: "token_bob",
        clerk_subject: "clerk_bob",
      }) as never)
      const orgId = await ctx.db.insert("orgs", stamped({
        clerk_org_id: "clerk_org_1",
        kind: "clerk",
        name: "Acme",
        owner_user_id: ownerId,
      }) as never)
      return { ownerId, bobId, orgId }
    })
  }

  async function bobDefaultTeamMembership(t: ReturnType<typeof convexTest>, bobId: unknown) {
    return await t.run(async (ctx) => {
      const team = (await ctx.db.query("teams").collect()).find((candidate: any) => candidate.is_default)
      if (!team) return undefined
      return (await ctx.db.query("team_memberships").collect())
        .find((row: any) => row.team_id === team._id && row.user_id === bobId)
    })
  }

  test("an insert correction provisions the default team membership", async () => {
    const t = convexTest(schema, modules)
    const { bobId } = await seedOrgWithoutMember(t)

    const result = await t.mutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: "clerk_org_1",
      observed_at: 9_000,
      corrections: [{ kind: "insert", clerk_subject: "clerk_bob", role: "member", clerk_updated_at: 5_000 }],
    } as never)

    expect(result).toEqual({ applied: 1, skipped: 0 })
    expect(await bobDefaultTeamMembership(t, bobId)).toMatchObject({ role: "member" })
  })

  test("a role correction updates the default team role", async () => {
    const t = convexTest(schema, modules)
    const { bobId } = await seedOrgWithoutMember(t)
    await t.mutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: "clerk_org_1",
      observed_at: 9_000,
      corrections: [{ kind: "insert", clerk_subject: "clerk_bob", role: "member", clerk_updated_at: 5_000 }],
    } as never)
    const membershipId = await t.run(async (ctx) =>
      (await ctx.db.query("org_memberships").collect())[0]._id)

    const result = await t.mutation(internal.clerkReconcile.applyReconcileCorrections, {
      clerk_org_id: "clerk_org_1",
      observed_at: 10_000,
      corrections: [{
        kind: "role",
        membership_id: String(membershipId),
        clerk_subject: "clerk_bob",
        from: "member",
        to: "admin",
      }],
    } as never)

    expect(result).toEqual({ applied: 1, skipped: 0 })
    expect(await bobDefaultTeamMembership(t, bobId)).toMatchObject({ role: "admin" })
  })
})
