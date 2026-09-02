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
 * Cross-tenant fence on `workspaceShares.grant` (convex/workspaceShares.ts).
 *
 * WHY THIS IS A SECURITY SUITE, not a validation one. A workspace share is not
 * a label — `model.ts teamShareRole`/`orgShareRole` turn `granted_to_team_id` /
 * `granted_to_org_id` into a real WorkspaceRole, up to admin. Neither resolver
 * checks the granted principal's tenant, so an unfenced `grant` lets a
 * workspace admin in org A confer admin over their workspace on a team or an
 * org in org B. `sessionShares.grant` already refuses exactly that
 * (`session_share_team_org_mismatch` / `session_share_org_mismatch`), and it
 * gates on a workspace role — so the unfenced workspace-level grant was a way
 * around the session-level guard rather than a separate gap.
 *
 * Runs through the real pipeline via `convex-test`, so the `authedMutation`
 * wrapper and `authorizeWorkspace(..., "admin")` are exercised as deployed.
 */
async function seedTwoTenants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", stamped({
      token_identifier: "alice_token",
      clerk_subject: "alice_subject",
      public_id: "usr_alice",
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
    await ctx.db.insert("org_memberships", stamped({
      org_id: foreignOrgId,
      user_id: malloryId,
      role: "owner",
    }) as never)
    const homeTeamId = await ctx.db.insert("teams", stamped({
      public_id: "team_home",
      org_id: homeOrgId,
      name: "Everyone",
      is_default: true,
      created_by_user_id: aliceId,
    }) as never)
    const foreignTeamId = await ctx.db.insert("teams", stamped({
      public_id: "team_foreign",
      org_id: foreignOrgId,
      name: "Outsiders",
      is_default: true,
      created_by_user_id: malloryId,
    }) as never)
    await ctx.db.insert("team_memberships", stamped({
      team_id: foreignTeamId,
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
    return { aliceId, malloryId, homeOrgId, foreignOrgId, homeTeamId, foreignTeamId, workspaceId }
  })
}

const alice = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: "alice_token", subject: "alice_subject" })

async function activeGrants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("workspace_share_grants").collect()).filter((row) => !row.revoked_at))
}

describe("workspace share tenant fence", () => {
  test("refuses a grant to a team in another organization", async () => {
    const t = convexTest(schema, modules)
    await seedTwoTenants(t)

    await expect(alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "admin",
      granted_to_team_public_id: "team_foreign",
    } as never)).rejects.toThrow("workspace_share_team_org_mismatch")

    expect(await activeGrants(t)).toEqual([])
  })

  test("refuses a grant to another organization", async () => {
    const t = convexTest(schema, modules)
    await seedTwoTenants(t)

    await expect(alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "admin",
      granted_to_clerk_org_id: "clerk_org_foreign",
    } as never)).rejects.toThrow("workspace_share_org_mismatch")

    expect(await activeGrants(t)).toEqual([])
  })

  test("still grants to a team and an organization inside the workspace's own tenant", async () => {
    const t = convexTest(schema, modules)
    const { homeTeamId, homeOrgId } = await seedTwoTenants(t)

    await alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "editor",
      granted_to_team_public_id: "team_home",
    } as never)
    await alice(t).mutation(api.workspaceShares.grant, {
      workspace_id: "ws_home",
      role: "viewer",
      granted_to_clerk_org_id: "clerk_org_home",
    } as never)

    const grants = await activeGrants(t)
    expect(grants).toHaveLength(2)
    expect(grants.find((row) => row.granted_to_team_id === homeTeamId)).toMatchObject({ role: "editor" })
    expect(grants.find((row) => row.granted_to_org_id === homeOrgId)).toMatchObject({ role: "viewer" })
  })

  test("a foreign-tenant team that was already granted stays revocable", async () => {
    // The fence is on `grant` only. `revoke` removes access, so fencing it too
    // would strand any cross-tenant grant written before the fence existed —
    // exactly the rows an operator most needs to be able to clear.
    const t = convexTest(schema, modules)
    const { aliceId, foreignTeamId, workspaceId } = await seedTwoTenants(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_team_id: foreignTeamId,
        role: "admin",
        created_by_user_id: aliceId,
        created_at: 1,
      } as never)
    })

    await expect(alice(t).mutation(api.workspaceShares.revoke, {
      workspace_id: "ws_home",
      granted_to_team_public_id: "team_foreign",
    } as never)).resolves.toMatchObject({ revoked: true })
    expect(await activeGrants(t)).toEqual([])
  })
})
