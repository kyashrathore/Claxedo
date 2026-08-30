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
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

async function seedSharedSession(t: ReturnType<typeof convexTest>) {
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
    const carolId = await ctx.db.insert("users", stamped({
      token_identifier: "carol_token",
      clerk_subject: "carol_subject",
      public_id: "usr_carol",
      kind: "human",
    }) as never)
    const daveId = await ctx.db.insert("users", stamped({
      token_identifier: "dave_token",
      clerk_subject: "dave_subject",
      public_id: "usr_dave",
      kind: "human",
    }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({
      name: "Acme",
      kind: "team",
      owner_user_id: aliceId,
    }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: aliceId, role: "owner" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: bobId, role: "member" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: carolId, role: "admin" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: daveId, role: "member" }) as never)
    const teamId = await ctx.db.insert("teams", stamped({
      public_id: "team_everyone",
      org_id: orgId,
      name: "Everyone",
      is_default: true,
      created_by_user_id: aliceId,
    }) as never)
    await ctx.db.insert("team_memberships", stamped({ team_id: teamId, user_id: aliceId, role: "owner" }) as never)
    await ctx.db.insert("team_memberships", stamped({ team_id: teamId, user_id: bobId, role: "member" }) as never)
    await ctx.db.insert("team_memberships", stamped({ team_id: teamId, user_id: carolId, role: "member" }) as never)
    await ctx.db.insert("team_memberships", stamped({ team_id: teamId, user_id: daveId, role: "admin" }) as never)
    await ctx.db.insert("team_project_grants", {
      team_id: teamId,
      project_id: "project_shared",
      role: "admin",
      created_by_user_id: aliceId,
      created_at: 1,
    } as never)
    const workspaceId = await ctx.db.insert("workspaces", stamped({
      workspace_id: "ws_1",
      org_id: orgId,
      owner_user_id: aliceId,
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Shared workspace",
      project_id: "project_shared",
    }) as never)
    await ctx.db.insert("workspace_share_grants", {
      workspace_id: workspaceId,
      granted_to_team_id: teamId,
      role: "editor",
      created_by_user_id: aliceId,
      created_at: 1,
    } as never)
    await ctx.db.insert("session_history", stamped({
      session_id: "ses_private",
      workspace_id: workspaceId,
      org_id: orgId,
      created_by_user_id: aliceId,
      title: "Private session",
    }) as never)
    const grantId = await ctx.db.insert("session_share_grants", {
      session_id: "ses_private",
      workspace_id: workspaceId,
      granted_to_team_id: teamId,
      created_by_user_id: aliceId,
      created_at: 1,
    } as never)
    return { grantId }
  })
}

describe("Convex session People capability", () => {
  test("returns no People data or controls to a shared-session reader", async () => {
    const t = convexTest(schema, modules)
    const { grantId } = await seedSharedSession(t)

    const bob = t.withIdentity({ tokenIdentifier: "bob_token", subject: "bob_subject" })
    await expect(bob.query(api.sessionShares.list, {
      session_id: "ses_private",
      workspace_id: "ws_1",
    } as never)).resolves.toEqual({
      can_manage_shares: false,
      grants: [],
      participants: [],
      teams: [],
    })
    await expect(bob.mutation(api.sessionShares.grant, {
      session_id: "ses_private",
      workspace_id: "ws_1",
      granted_to_user_id: "usr_bob",
    } as never)).rejects.toThrow("session_share_admin_required")
    await expect(bob.mutation(api.sessionShares.revoke, {
      session_id: "ses_private",
      workspace_id: "ws_1",
      grant_id: grantId,
    } as never)).rejects.toThrow("session_share_admin_required")
  })

  test("rejects a workspace reader without session access", async () => {
    const t = convexTest(schema, modules)
    const { grantId } = await seedSharedSession(t)
    await t.run(async (ctx) => await ctx.db.delete(grantId))

    const bob = t.withIdentity({ tokenIdentifier: "bob_token", subject: "bob_subject" })
    await expect(bob.query(api.sessionShares.list, {
      session_id: "ses_private",
      workspace_id: "ws_1",
    } as never)).rejects.toThrow("session_share_admin_required")

    const alice = t.withIdentity({ tokenIdentifier: "alice_token", subject: "alice_subject" })
    await expect(alice.query(api.sessionShares.list, {
      session_id: "ses_missing",
      workspace_id: "ws_1",
    } as never)).rejects.toThrow("Session not found")
  })

  test("returns the session organization's teams and sharing state to its owner", async () => {
    const t = convexTest(schema, modules)
    await seedSharedSession(t)

    const alice = t.withIdentity({ tokenIdentifier: "alice_token", subject: "alice_subject" })
    await expect(alice.query(api.sessionShares.list, {
      session_id: "ses_private",
      workspace_id: "ws_1",
    } as never)).resolves.toMatchObject({
      can_manage_shares: true,
      grants: [expect.objectContaining({ grant_id: expect.any(String) })],
      participants: [],
      teams: [{
        team_id: "team_everyone",
        name: "Everyone",
        is_shared: true,
      }],
    })
  })

  test.each([
    ["organization administrator", "carol_token", "carol_subject", "usr_carol"],
    ["project-team administrator", "dave_token", "dave_subject", "usr_dave"],
  ])("lets a non-creator %s manage People", async (_label, tokenIdentifier, subject, userPublicId) => {
    const t = convexTest(schema, modules)
    await seedSharedSession(t)

    const administrator = t.withIdentity({ tokenIdentifier, subject })
    await expect(administrator.query(api.sessionShares.list, {
      session_id: "ses_private",
      workspace_id: "ws_1",
    } as never)).resolves.toMatchObject({
      can_manage_shares: true,
      teams: [{ team_id: "team_everyone", name: "Everyone", is_shared: true }],
    })
    const grant = await administrator.mutation(api.sessionShares.grant, {
      session_id: "ses_private",
      workspace_id: "ws_1",
      granted_to_user_id: userPublicId,
    } as never) as { grant_id: string }
    await expect(administrator.mutation(api.sessionShares.revoke, {
      session_id: "ses_private",
      workspace_id: "ws_1",
      grant_id: grant.grant_id,
    } as never)).resolves.toMatchObject({ revoked: true })
  })
})
