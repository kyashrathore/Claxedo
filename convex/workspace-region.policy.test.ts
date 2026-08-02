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
  return await t.run(async (ctx) =>
    ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_1",
        owner_user_id: userId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "old",
        home_region: "eu-west",
        ...overrides,
      }) as never,
    )
  )
}

describe("Convex workspace region policy", () => {
  test("re-registering a shared workspace preserves its existing home_region", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedWorkspace(t, userId, {})
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
    expect(inserted).toMatchObject({ project_id: "prj_ws_new" })
    const org = await t.run(async (ctx) =>
      ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", userId)).unique()
    )
    expect(inserted!.org_id).toBe(org!._id)

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
    expect(cloudWorkspace).toMatchObject({ project_id: "prj_ws_cloud_new" })
    const cloudOrg = await t.run(async (ctx) =>
      ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", cloudUserId)).unique()
    )
    expect(cloudWorkspace!.org_id).toBe(cloudOrg!._id)
  })

  test("re-registering an existing local workspace backfills org owner and project identity", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedWorkspace(t, userId, { workspace_id: "ws_legacy", home_region: undefined })
    const asUser = t.withIdentity({ tokenIdentifier: "token_1" })

    await asUser.mutation(api.workspaces.registerLocalForSharing, {
      workspace_id: "ws_legacy",
      display_name: "new",
    } as never)

    const workspace = await t.run(async (ctx) =>
      ctx.db.query("workspaces").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_legacy")).unique()
    )
    const org = await t.run(async (ctx) =>
      ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", userId)).unique()
    )
    expect(workspace).toMatchObject({
      org_id: org!._id,
      owner_user_id: userId,
      project_id: "prj_ws_legacy",
      display_name: "new",
    })
  })

  test("refuses to flip the backing of an existing cloud workspace (typed conflict)", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t)
    await seedWorkspace(t, userId, {
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
    await seedWorkspace(t, userId, {
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
