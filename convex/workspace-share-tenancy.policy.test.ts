import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
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
 * Tenant fence on `workspaceShares.grant` (convex/workspaceShares.ts).
 *
 * A workspace share confers a real WorkspaceRole (`model.ts orgShareRole`
 * turns `granted_to_org_id` into a role on the workspace), so a grant may only
 * name a principal inside the workspace's own organization:
 * `requireTargetInWorkspaceOrganization` refuses any other organization and
 * any user without a membership there. Runs through the real pipeline via
 * `convex-test`, so `authedMutation` and `authorizeWorkspace(..., "admin")`
 * are exercised as deployed.
 */
async function seedTwoTenants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", stamped({
      token_identifier: "alice_token",
      clerk_subject: "alice_subject",
      public_id: "usr_alice",
      kind: "human",
    }) as never)
    const bobId = await ctx.db.insert("users", stamped({
      token_identifier: "bob_token",
      clerk_subject: "bob_subject",
      public_id: "usr_bob",
      kind: "human",
    }) as never)
    const malloryId = await ctx.db.insert("users", stamped({
      token_identifier: "mallory_token",
      clerk_subject: "mallory_subject",
      public_id: "usr_mallory",
      kind: "human",
    }) as never)
    const homeOrgId = await ctx.db.insert("orgs", stamped({
      name: "Acme",
      kind: "clerk",
      clerk_org_id: "clerk_org_home",
      owner_user_id: aliceId,
    }) as never)
    const foreignOrgId = await ctx.db.insert("orgs", stamped({
      name: "Evil",
      kind: "clerk",
      clerk_org_id: "clerk_org_foreign",
      owner_user_id: malloryId,
    }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: homeOrgId, user_id: aliceId, role: "owner" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: homeOrgId, user_id: bobId, role: "member" }) as never)
    await ctx.db.insert("org_memberships", stamped({
      org_id: foreignOrgId,
      user_id: malloryId,
      role: "owner",
    }) as never)
    const workspaceId = await ctx.db.insert("workspaces", stamped({
      workspace_id: "ws_home",
      org_id: homeOrgId,
      owner_user_id: aliceId,
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Home workspace",
    }) as never)
    return { aliceId, bobId, malloryId, homeOrgId, foreignOrgId, workspaceId }
  })
}

const alice = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: "alice_token", subject: "alice_subject" })

async function activeGrants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("workspace_share_grants").collect()).filter((row) => !row.revoked_at))
}

describe("workspace share tenant fence", () => {
  test("refuses a grant to another organization", async () => {
    const t = convexTest(schema, modules)
    const { foreignOrgId } = await seedTwoTenants(t)

    await expect(alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "admin",
      target_org_id: foreignOrgId,
    })).rejects.toThrow("Workspace share target belongs to another organization")

    expect(await activeGrants(t)).toEqual([])
  })

  test("refuses a grant to a user outside the workspace's organization", async () => {
    const t = convexTest(schema, modules)
    const { malloryId } = await seedTwoTenants(t)

    await expect(alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "admin",
      target_user_id: malloryId,
    })).rejects.toThrow("Workspace share target belongs to another organization")

    expect(await activeGrants(t)).toEqual([])
  })

  test("grants to a member and to the organization inside the workspace's own tenant", async () => {
    const t = convexTest(schema, modules)
    const { bobId, homeOrgId } = await seedTwoTenants(t)

    await alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "editor",
      target_user_id: bobId,
    })
    await alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "viewer",
      target_org_id: homeOrgId,
    })

    const grants = await activeGrants(t)
    expect(grants).toHaveLength(2)
    expect(grants.find((row) => row.granted_to_user_id === bobId)).toMatchObject({ role: "editor" })
    expect(grants.find((row) => row.granted_to_org_id === homeOrgId)).toMatchObject({ role: "viewer" })
  })

  test("a foreign organization that already holds a grant stays revocable", async () => {
    // Only `grant` is fenced. `revoke` removes access, so a workspace admin can
    // always clear a grant that names a principal outside the tenant.
    const t = convexTest(schema, modules)
    const { aliceId, foreignOrgId, workspaceId } = await seedTwoTenants(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_org_id: foreignOrgId,
        role: "admin",
        created_by_user_id: aliceId,
        created_at: 1,
      } as never)
    })

    await expect(alice(t).mutation(api.workspaceShares.revoke, {
      workspace_id: "ws_home",
      target_org_id: foreignOrgId,
    })).resolves.toMatchObject({ revoked: true })
    expect(await activeGrants(t)).toEqual([])
  })
})
