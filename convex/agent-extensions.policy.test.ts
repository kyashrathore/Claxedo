import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Every table here requires `created_at`/`updated_at`. The hand-rolled `db`
 * double this suite used to run against enforced nothing, so its seeds were
 * missing them and the schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

type WorkspaceRole = "viewer" | "editor" | "admin" | "owner"

/**
 * One workspace ("ws_1") in one org, one install and one policy override per
 * scope (org/user/workspace) — the same fixture shape the old hand-rolled
 * `db` double built by default. `role` seeds a `workspace_memberships` row
 * for the caller when given; `ownerIsCaller` makes the caller the org's
 * `owner_user_id` directly, with no membership row, to pin the "owner field
 * counts on its own" fallback.
 */
async function seedFixture(
  t: ReturnType<typeof convexTest>,
  role: WorkspaceRole | undefined,
  opts: { ownerIsCaller?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
    const userId = await ctx.db.insert("users", stamped({ token_identifier: "user_token" }) as never)
    const orgId = await ctx.db.insert(
      "orgs",
      stamped({ name: "Acme", owner_user_id: opts.ownerIsCaller ? userId : ownerId }) as never,
    )
    const workspaceId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_1",
        owner_user_id: ownerId,
        org_id: orgId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "Workspace 1",
      }) as never,
    )
    if (role) {
      await ctx.db.insert("workspace_memberships", stamped({ workspace_id: workspaceId, user_id: userId, role }) as never)
    }
    const installId = await ctx.db.insert(
      "agent_extension_installs",
      stamped({
        workspace_id: workspaceId,
        extension_id: "review",
        package_name: "review",
        desired: { id: "review", enabled: true },
        lock: { resolved_sha: "old" },
        enabled: true,
      }) as never,
    )
    const orgPolicyId = await ctx.db.insert(
      "agent_extension_policy_overrides",
      stamped({ scope: "org", org_id: orgId, extension_id: "review", enabled: false, reason: "blocked by org" }) as never,
    )
    const userPolicyId = await ctx.db.insert(
      "agent_extension_policy_overrides",
      stamped({ scope: "user", user_id: userId, extension_id: "review", enabled: true }) as never,
    )
    const workspacePolicyId = await ctx.db.insert(
      "agent_extension_policy_overrides",
      stamped({ scope: "workspace", workspace_id: workspaceId, extension_id: "review", enabled: true, reason: "workspace allow" }) as never,
    )
    return { ownerId, userId, orgId, workspaceId, installId, orgPolicyId, userPolicyId, workspacePolicyId }
  })
}

/**
 * The §4.2 escalation chain, exactly: a workspace owner hands an OUTSIDER a
 * narrow single-workspace `admin` share (`workspaceShares.grant` requires no
 * org membership), and `shareRole` in convex/model.ts resolves that grant
 * with no `org_memberships` lookup anywhere. So this caller genuinely holds
 * workspace-admin while holding nothing at all in the org.
 */
async function seedOutsiderFixture(t: ReturnType<typeof convexTest>) {
  const fixture = await seedFixture(t, undefined)
  await t.run(async (ctx) => {
    await ctx.db.insert("workspace_share_grants", {
      workspace_id: fixture.workspaceId,
      granted_to_user_id: fixture.userId,
      role: "admin",
      created_by_user_id: fixture.ownerId,
      created_at: 1,
    } as never)
  })
  return fixture
}

function asUser(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "user_token" })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Agent Extensions install + policy-override authorization, run through the
 * real `authedQuery`/`authedMutation`/`serviceQuery` wrappers via
 * `convex-test`. The previous version of this suite drove a hand-written
 * `db` double and reached past the builders into `_handler`, so it never
 * exercised identity resolution, `service_token` verification, or the real
 * index/`.unique()` semantics these checks depend on.
 */
describe("Convex Agent Extensions role policy", () => {
  test.each(["viewer", "editor"] as const)("denies %s workspace members admin Agent Extension mutations", async (role) => {
    const t = convexTest(schema, modules)
    await seedFixture(t, role)
    const caller = asUser(t)

    await expect(caller.query(api.agentExtensions.authorizeAdmin, { workspace_id: "ws_1" } as never))
      .rejects.toThrow("Workspace not found")
    await expect(caller.mutation(api.agentExtensions.upsert, {
      workspace_id: "ws_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "new" },
    } as never)).rejects.toThrow("Workspace not found")
    await expect(caller.mutation(api.agentExtensions.setEnabled, {
      workspace_id: "ws_1",
      extension_id: "review",
      enabled: false,
    } as never)).rejects.toThrow("Workspace not found")
    await expect(caller.mutation(api.agentExtensions.remove, {
      workspace_id: "ws_1",
      extension_id: "review",
    } as never)).rejects.toThrow("Workspace not found")
    await expect(caller.mutation(api.agentExtensionPolicies.set, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
      enabled: false,
    } as never)).rejects.toThrow("Workspace not found")
    await expect(caller.mutation(api.agentExtensionPolicies.remove, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
    } as never)).rejects.toThrow("Workspace not found")
  })

  test("allows admin workspace members to manage Agent Extension installs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    const { installId } = await seedFixture(t, "admin")
    const caller = asUser(t)

    await expect(caller.query(api.agentExtensions.authorizeAdmin, { workspace_id: "ws_1" } as never))
      .resolves.toEqual({ allowed: true })
    await expect(caller.mutation(api.agentExtensions.upsert, {
      workspace_id: "ws_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "new" },
    } as never)).resolves.toEqual({ extension_id: "review" })
    const afterUpsert = await t.run(async (ctx) => ctx.db.get(installId))
    expect(afterUpsert!.deleted_at).toBeUndefined()
    expect(afterUpsert).toMatchObject({ lock: { resolved_sha: "new" }, updated_at: 123_456 })

    await expect(caller.mutation(api.agentExtensions.setEnabled, {
      workspace_id: "ws_1",
      extension_id: "review",
      enabled: false,
    } as never)).resolves.toEqual({ extension_id: "review", enabled: false })
    const afterSetEnabled = await t.run(async (ctx) => ctx.db.get(installId))
    expect(afterSetEnabled).toMatchObject({
      enabled: false,
      desired: { enabled: false, updated_at: 123_456 },
    })

    await expect(caller.mutation(api.agentExtensions.remove, {
      workspace_id: "ws_1",
      extension_id: "review",
    } as never)).resolves.toEqual({ ok: true })
    const afterRemove = await t.run(async (ctx) => ctx.db.get(installId))
    expect(afterRemove).toMatchObject({ deleted_at: 123_456, updated_at: 123_456 })
  })

  test("lists org, user, and workspace policy overrides for signed users", async () => {
    const t = convexTest(schema, modules)
    await seedFixture(t, "admin")
    const caller = asUser(t)

    await expect(caller.query(api.agentExtensionPolicies.list, { workspace_id: "ws_1" } as never)).resolves.toEqual([
      { id: "review", scope: "org", enabled: false, reason: "blocked by org" },
      { id: "review", scope: "user", enabled: true },
      { id: "review", scope: "workspace", enabled: true, reason: "workspace allow" },
    ])
  })

  test("runtime policy override hydration excludes user-specific overrides", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
    const t = convexTest(schema, modules)
    await seedFixture(t, "admin")

    await expect(t.query(api.agentExtensionPolicies.listForRuntime, {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    } as never)).resolves.toEqual([
      { id: "review", scope: "org", enabled: false, reason: "blocked by org" },
      { id: "review", scope: "workspace", enabled: true, reason: "workspace allow" },
    ])
  })

  test("allows admin workspace members to manage Agent Extension policy overrides", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)
    const { workspacePolicyId } = await seedFixture(t, "admin")
    const caller = asUser(t)

    await expect(caller.mutation(api.agentExtensionPolicies.set, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
      enabled: false,
      reason: "blocked by workspace",
    } as never)).resolves.toEqual({ extension_id: "review", scope: "workspace" })
    const afterSet = await t.run(async (ctx) => ctx.db.get(workspacePolicyId))
    expect(afterSet).toMatchObject({
      scope: "workspace",
      extension_id: "review",
      enabled: false,
      reason: "blocked by workspace",
      updated_at: 123_456,
    })

    await expect(caller.mutation(api.agentExtensionPolicies.remove, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
    } as never)).resolves.toEqual({ ok: true })
    const afterRemove = await t.run(async (ctx) => ctx.db.get(workspacePolicyId))
    expect(afterRemove).toMatchObject({ deleted_at: 123_456, updated_at: 123_456 })
  })

  /**
   * Pre-launch security review §4.2 — `set`/`remove` treated workspace-admin as
   * proof of org authority.
   *
   * An `org`-scoped row is keyed on `workspace.org_id`, and `policyRows` reads
   * org rows for EVERY workspace in that org, so an org-scoped write reaches
   * workspaces the caller was never granted. The only check was
   * `authorizeWorkspace(..., "admin")`, applied identically to all three scopes.
   */
  describe("org-scoped policy writes require org authority, not workspace admin", () => {
    test("an admin share grantee with no org membership is refused at org scope", async () => {
      const t = convexTest(schema, modules)
      await seedOutsiderFixture(t)
      const caller = asUser(t)

      await expect(caller.mutation(api.agentExtensionPolicies.set, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "org",
        enabled: true,
        reason: "escalated",
      } as never)).rejects.toThrow("org_policy_forbidden")

      await expect(caller.mutation(api.agentExtensionPolicies.remove, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "org",
      } as never)).rejects.toThrow("org_policy_forbidden")

      // The org-wide row is untouched — no new row, and the seeded one keeps
      // its original disposition and is not soft-deleted.
      const orgRows = await t.run(async (ctx) =>
        (await ctx.db.query("agent_extension_policy_overrides").collect()).filter((row) => row.scope === "org")
      )
      expect(orgRows).toHaveLength(1)
      expect(orgRows[0]).toMatchObject({ enabled: false, reason: "blocked by org", updated_at: 1 })
      expect(orgRows[0]).not.toHaveProperty("deleted_at")
    })

    test("the same grantee still manages workspace scope — sharing is not broken", async () => {
      // Pins the boundary rather than just the denial: external
      // single-workspace collaboration is intentional and must keep working.
      vi.spyOn(Date, "now").mockReturnValue(123_456)
      const t = convexTest(schema, modules)
      const { workspacePolicyId } = await seedOutsiderFixture(t)
      const caller = asUser(t)

      await expect(caller.mutation(api.agentExtensionPolicies.set, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "workspace",
        enabled: false,
        reason: "blocked by workspace",
      } as never)).resolves.toEqual({ extension_id: "review", scope: "workspace" })
      const afterSet = await t.run(async (ctx) => ctx.db.get(workspacePolicyId))
      expect(afterSet).toMatchObject({ enabled: false, reason: "blocked by workspace", updated_at: 123_456 })

      await expect(caller.mutation(api.agentExtensionPolicies.remove, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "workspace",
      } as never)).resolves.toEqual({ ok: true })
    })

    test("a plain org MEMBER is refused — the bar is org admin", async () => {
      // `orgWorkspaceRole` already maps an org "member" to a workspace VIEWER,
      // so accepting mere membership here would grant more authority org-wide
      // than the model grants on any single workspace in that org.
      const t = convexTest(schema, modules)
      const { orgId, userId } = await seedFixture(t, "admin")
      await t.run(async (ctx) => {
        await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "member" }) as never)
      })
      const caller = asUser(t)

      await expect(caller.mutation(api.agentExtensionPolicies.set, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "org",
        enabled: true,
      } as never)).rejects.toThrow("org_policy_forbidden")
    })

    test.each(["admin", "owner"] as const)("an org %s may still write org scope", async (orgRole) => {
      vi.spyOn(Date, "now").mockReturnValue(123_456)
      const t = convexTest(schema, modules)
      const { orgId, userId, orgPolicyId } = await seedFixture(t, "admin")
      await t.run(async (ctx) => {
        await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: orgRole }) as never)
      })
      const caller = asUser(t)

      await expect(caller.mutation(api.agentExtensionPolicies.set, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "org",
        enabled: true,
        reason: "allowed by org admin",
      } as never)).resolves.toEqual({ extension_id: "review", scope: "org" })
      const afterSet = await t.run(async (ctx) => ctx.db.get(orgPolicyId))
      expect(afterSet).toMatchObject({ enabled: true, reason: "allowed by org admin", updated_at: 123_456 })
    })

    test("the org's owner_user_id counts even with no membership row", async () => {
      // Orgs predating the membership row would otherwise have no org admin at
      // all; `requireWorkGraphOwner` in convex/workspaces.ts already treats
      // `owner_user_id` and a membership row as equivalent.
      const t = convexTest(schema, modules)
      await seedFixture(t, "admin", { ownerIsCaller: true })
      const caller = asUser(t)

      await expect(caller.mutation(api.agentExtensionPolicies.set, {
        workspace_id: "ws_1",
        extension_id: "review",
        scope: "org",
        enabled: true,
      } as never)).resolves.toEqual({ extension_id: "review", scope: "org" })
    })
  })

  test("runtime policy override hydration rejects missing or wrong service tokens", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "")
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_PREVIOUS", "")
    const t = convexTest(schema, modules)
    await seedFixture(t, "admin")

    await expect(t.query(api.agentExtensionPolicies.listForRuntime, {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    } as never)).rejects.toThrow("Unauthenticated")

    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")

    await expect(t.query(api.agentExtensionPolicies.listForRuntime, {
      workspace_id: "ws_1",
      service_token: "wrong",
    } as never)).rejects.toThrow("Unauthenticated")
  })
})
