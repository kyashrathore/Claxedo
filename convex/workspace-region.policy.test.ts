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

/**
 * Home-region policy for `workspaces.registerLocalForSharing`/`createCloud`
 * (`convex/workspaces.ts`) — validation of caller-supplied regions, and that
 * no hardcoded default is ever silently written. Runs through the real
 * `authedMutation` wrapper via `convex-test`, including `ensureOwnerOrg` and
 * `ensureProject`, which the old hand-rolled `db` double bypassed entirely by
 * reaching into `_handler`.
 */
async function seedUser(t: ReturnType<typeof convexTest>, tokenIdentifier = "token_1") {
  return await t.run(async (ctx) => ctx.db.insert("users", stamped({ token_identifier: tokenIdentifier }) as never))
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  userId: string,
  overrides: Record<string, unknown>,
) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert(
      "orgs",
      stamped({ name: "Personal", kind: "personal", owner_user_id: userId }) as never,
    )
    await ctx.db.insert(
      "org_memberships",
      stamped({ org_id: orgId, user_id: userId, role: "owner" }) as never,
    )
    return await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_1",
        org_id: orgId,
        owner_user_id: userId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "old",
        home_region: "eu-west",
        ...overrides,
      }) as never,
    )
  })
}

async function seedCanonicalWorkspace(
  t: ReturnType<typeof convexTest>,
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  const workspaceId = typeof overrides.workspace_id === "string" ? overrides.workspace_id : "ws_1"
  const projectId = typeof overrides.project_id === "string" ? overrides.project_id : `prj_${workspaceId}`
  const repoUrl = typeof overrides.repo_url === "string" ? overrides.repo_url : undefined
  const repoKey = repoUrl ? "github.com/acme/demo" : `workspace:${workspaceId}`

  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert(
      "orgs",
      stamped({ name: "Personal", kind: "personal", owner_user_id: userId }) as never,
    )
    await ctx.db.insert(
      "org_memberships",
      stamped({ org_id: orgId, user_id: userId, role: "owner" }) as never,
    )
    await ctx.db.insert(
      "projects",
      stamped({ project_id: projectId, org_id: orgId, repo_key: repoKey, owner_user_id: userId }) as never,
    )
    await ctx.db.insert(
      "project_memberships",
      stamped({ project_id: projectId, user_id: userId, role: "owner" }) as never,
    )
    return await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: workspaceId,
        org_id: orgId,
        owner_user_id: userId,
        project_id: projectId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "old",
        home_region: "eu-west",
        ...overrides,
      }) as never,
    )
  })
}

describe("Convex workspace region policy", () => {
  test("re-registering a shared workspace preserves its existing home_region", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedCanonicalWorkspace(t, userId)
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await expect(
      asUser.mutation(api.workspaces.registerLocalForSharing, {
        workspace_id: "ws_1",
        display_name: "new",
        home_region: "apac-south",
      } as never),
    ).resolves.toMatchObject({
      workspace_id: "ws_1",
      home_region: "eu-west",
    })

    const workspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).unique()
    )
    expect(workspace).toMatchObject({
      workspace_id: "ws_1",
      display_name: "new",
      home_region: "eu-west",
    })
  })

  test("rejects an unknown home_region instead of storing it", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedWorkspace(t, userId, {})
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await expect(
      asUser.mutation(api.workspaces.registerLocalForSharing, {
        workspace_id: "ws_new",
        display_name: "demo",
        home_region: "mars-north",
      } as never),
    ).rejects.toThrow("home_region_invalid")
    await expect(
      asUser.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_cloud_new",
        display_name: "demo",
        home_region: "mars-north",
      } as never),
    ).rejects.toThrow("home_region_invalid")
  })

  test("stores no hardcoded default region — unset home_region stays unset", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedWorkspace(t, userId, {})
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    const result = (await asUser.mutation(api.workspaces.registerLocalForSharing, {
      workspace_id: "ws_new",
      display_name: "demo",
    } as never)) as { home_region?: string }
    expect(result.home_region).toBeUndefined()

    const inserted = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_new")).unique()
    )
    expect(inserted).not.toHaveProperty("home_region")
    expect(inserted?.project_id).toMatch(/^prj_/)
    const org = await t.run(async (ctx) =>
      ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", userId)).unique()
    )
    expect(inserted!.org_id).toBe(org!._id)
    const localProject = await t.run(async (ctx) =>
      ctx.db.query("projects").withIndex("by_project_id", (q) => q.eq("project_id", inserted!.project_id)).unique()
    )
    expect(localProject).toMatchObject({ org_id: org!._id, repo_key: "workspace:ws_new" })

    const cloudUserId = await seedUser(t, "token_cloud")
    const asCloudUser = t.withIdentity({ tokenIdentifier: "token_cloud" })
    await asCloudUser.mutation(api.workspaces.createCloud, {
      workspace_id: "ws_cloud_new",
      display_name: "demo",
    } as never)
    const cloudWorkspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_cloud_new")).unique()
    )
    expect(cloudWorkspace).not.toHaveProperty("home_region")
    expect(cloudWorkspace?.project_id).toMatch(/^prj_/)
    const cloudOrg = await t.run(async (ctx) =>
      ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", cloudUserId)).unique()
    )
    expect(cloudWorkspace!.org_id).toBe(cloudOrg!._id)
    const cloudProject = await t.run(async (ctx) =>
      ctx.db.query("projects").withIndex("by_project_id", (q) => q.eq("project_id", cloudWorkspace!.project_id)).unique()
    )
    expect(cloudProject).toMatchObject({ org_id: cloudOrg!._id, repo_key: "workspace:ws_cloud_new" })
  })

  test("fails closed for a legacy workspace missing tenant identity", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await t.run(async (ctx) =>
      ctx.db.insert(
        "workspaces",
        stamped({
          workspace_id: "ws_legacy",
          owner_user_id: userId,
          backing: "local-worktree",
          access: "user-hosted",
          display_name: "old",
        }) as never,
      )
    )
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await expect(
      asUser.mutation(api.workspaces.registerLocalForSharing, {
        workspace_id: "ws_legacy",
        display_name: "new",
      } as never),
    ).rejects.toThrow("Workspace not found")

    const workspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_legacy")).unique()
    )
    expect(workspace).toMatchObject({
      owner_user_id: userId,
      display_name: "old",
      updated_at: 1,
    })
    expect(workspace).not.toHaveProperty("org_id")
    expect(workspace).not.toHaveProperty("project_id")
    const [orgs, projects] = await t.run(async (ctx) =>
      Promise.all([ctx.db.query("orgs").collect(), ctx.db.query("projects").collect()])
    )
    expect(orgs).toEqual([])
    expect(projects).toEqual([])
  })

  test("refuses to flip the backing of an existing cloud workspace (typed conflict)", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedCanonicalWorkspace(t, userId, {
      backing: "cloud-vm",
      access: "cloud",
      display_name: "cloud workspace",
      home_region: "eu-west",
      repo_url: "https://github.com/acme/demo.git",
    })
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await expect(
      asUser.mutation(api.workspaces.registerLocalForSharing, {
        workspace_id: "ws_1",
        display_name: "hijacked",
      } as never),
    ).rejects.toThrow("workspace_backing_conflict")

    // Nothing about the workspace row changed.
    const workspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).unique()
    )
    expect(workspace).toMatchObject({
      backing: "cloud-vm",
      access: "cloud",
      display_name: "cloud workspace",
      repo_url: "https://github.com/acme/demo.git",
      updated_at: 1,
    })
  })

  test("re-registration patches only supplied fields — never erases metadata with undefined", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedCanonicalWorkspace(t, userId, {
      project_id: "prj_ws_1",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
    })
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await asUser.mutation(api.workspaces.registerLocalForSharing, {
      workspace_id: "ws_1",
      display_name: "renamed",
    } as never)

    const workspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).unique()
    )
    expect(workspace).toMatchObject({
      display_name: "renamed",
      project_id: "prj_ws_1",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
      home_region: "eu-west",
    })
  })
})
