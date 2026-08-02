import { describe, expect, test, vi } from "vitest"
import { createCloud, registerLocalForSharing } from "../../../../../convex/workspaces"

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0] ?? null
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = `${table}:${(rows[table] ?? []).length + 1}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
    },
    async get(id: string) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

function ctx(workspace: Row = {
  _id: "workspace_1",
  workspace_id: "ws_1",
  owner_user_id: "user_1",
  backing: "local-worktree",
  access: "user-hosted",
  display_name: "old",
  home_region: "eu-west",
  created_at: 1,
  updated_at: 1,
}) {
  return {
    db: db({
      users: [{ _id: "user_1", token_identifier: "token_1", created_at: 1, updated_at: 1 }],
      workspaces: [workspace],
      projects: [],
      project_memberships: [],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
    }),
    auth: {
      getUserIdentity: vi.fn(async () => ({ tokenIdentifier: "token_1" })),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

describe("Convex workspace region policy", () => {
  test("re-registering a shared workspace preserves its existing home_region", async () => {
    const input = ctx()
    await expect(handler(registerLocalForSharing)(input, {
      workspace_id: "ws_1",
      display_name: "new",
      home_region: "apac-south",
    })).resolves.toMatchObject({
      workspace_id: "ws_1",
      home_region: "eu-west",
    })

    expect(input.db.rows.workspaces[0]).toMatchObject({
      workspace_id: "ws_1",
      display_name: "new",
      home_region: "eu-west",
    })
  })

  test("rejects an unknown home_region instead of storing it", async () => {
    await expect(handler(registerLocalForSharing)(ctx(), {
      workspace_id: "ws_new",
      display_name: "demo",
      home_region: "mars-north",
    })).rejects.toThrow("home_region_invalid")
    await expect(handler(createCloud)(ctx(), {
      workspace_id: "ws_cloud_new",
      display_name: "demo",
      home_region: "mars-north",
    })).rejects.toThrow("home_region_invalid")
  })

  test("stores no hardcoded default region — unset home_region stays unset", async () => {
    const input = ctx()
    const result = await handler(registerLocalForSharing)(input, {
      workspace_id: "ws_new",
      display_name: "demo",
    }) as { home_region?: string }
    expect(result.home_region).toBeUndefined()
    const inserted = input.db.rows.workspaces.find((row) => row.workspace_id === "ws_new")!
    expect(inserted).not.toHaveProperty("home_region")
    expect(inserted.project_id).toBe("prj_ws_new")
    expect(inserted.org_id).toBe("orgs:1")

    const cloud = ctx()
    await handler(createCloud)(cloud, {
      workspace_id: "ws_cloud_new",
      display_name: "demo",
    })
    expect(cloud.db.rows.workspaces.find((row) => row.workspace_id === "ws_cloud_new")!)
      .not.toHaveProperty("home_region")
    expect(cloud.db.rows.workspaces.find((row) => row.workspace_id === "ws_cloud_new")!)
      .toMatchObject({ project_id: "prj_ws_cloud_new", org_id: "orgs:1" })
  })

  test("re-registering an existing local workspace backfills org owner and project identity", async () => {
    const input = ctx({
      _id: "workspace_1",
      workspace_id: "ws_legacy",
      owner_user_id: "user_1",
      backing: "local-worktree",
      access: "user-hosted",
      display_name: "old",
      created_at: 1,
      updated_at: 1,
    })

    await handler(registerLocalForSharing)(input, {
      workspace_id: "ws_legacy",
      display_name: "new",
    })

    expect(input.db.rows.workspaces[0]).toMatchObject({
      org_id: "orgs:1",
      owner_user_id: "user_1",
      project_id: "prj_ws_legacy",
      display_name: "new",
    })
  })

  test("refuses to flip the backing of an existing cloud workspace (typed conflict)", async () => {
    const input = ctx({
      _id: "workspace_1",
      workspace_id: "ws_1",
      owner_user_id: "user_1",
      backing: "cloud-vm",
      access: "cloud",
      display_name: "cloud workspace",
      home_region: "eu-west",
      repo_url: "https://github.com/acme/demo.git",
      created_at: 1,
      updated_at: 1,
    })
    await expect(handler(registerLocalForSharing)(input, {
      workspace_id: "ws_1",
      display_name: "hijacked",
    })).rejects.toThrow("workspace_backing_conflict")
    // Nothing about the workspace row changed.
    expect(input.db.rows.workspaces[0]).toMatchObject({
      backing: "cloud-vm",
      access: "cloud",
      display_name: "cloud workspace",
      repo_url: "https://github.com/acme/demo.git",
      updated_at: 1,
    })
  })

  test("re-registration patches only supplied fields — never erases metadata with undefined", async () => {
    const input = ctx({
      _id: "workspace_1",
      workspace_id: "ws_1",
      owner_user_id: "user_1",
      backing: "local-worktree",
      access: "user-hosted",
      display_name: "old",
      project_id: "prj_ws_1",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
      home_region: "eu-west",
      created_at: 1,
      updated_at: 1,
    })
    await handler(registerLocalForSharing)(input, {
      workspace_id: "ws_1",
      display_name: "renamed",
    })
    expect(input.db.rows.workspaces[0]).toMatchObject({
      display_name: "renamed",
      project_id: "prj_ws_1",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
      home_region: "eu-west",
    })
  })
})
