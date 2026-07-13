import { afterEach, describe, expect, test, vi } from "vitest"
import { authorizeAdmin, remove, setEnabled, upsert } from "../../../../convex/agentExtensions"
import {
  list as listPolicyOverrides,
  listForRuntime as listPolicyOverridesForRuntime,
  remove as removePolicyOverride,
  set as setPolicyOverride,
} from "../../../../convex/agentExtensionPolicies"

type Row = Record<string, unknown> & { _id: string }
const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

function db(role: "viewer" | "editor" | "admin" | "owner") {
  const rows: Record<string, Row[]> = {
    users: [{ _id: "user_1", token_identifier: "user_token" }],
    orgs: [{ _id: "org_1" }],
    workspaces: [{ _id: "workspace_1", workspace_id: "ws_1", owner_user_id: "owner_1", org_id: "org_1" }],
    workspace_memberships: [{
      _id: "membership_1",
      workspace_id: "workspace_1",
      user_id: "user_1",
      role,
    }],
    workspace_share_grants: [],
    org_memberships: [],
    agent_extension_installs: [{
      _id: "install_1",
      workspace_id: "workspace_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "old" },
      enabled: true,
      created_at: 1,
      updated_at: 1,
    }],
    agent_extension_policy_overrides: [{
      _id: "policy_1",
      scope: "org",
      org_id: "org_1",
      extension_id: "review",
      enabled: false,
      reason: "blocked by org",
      created_at: 1,
      updated_at: 1,
    }, {
      _id: "policy_2",
      scope: "user",
      user_id: "user_1",
      extension_id: "review",
      enabled: true,
      created_at: 1,
      updated_at: 1,
    }, {
      _id: "policy_3",
      scope: "workspace",
      workspace_id: "workspace_1",
      extension_id: "review",
      enabled: true,
      reason: "workspace allow",
      created_at: 1,
      updated_at: 1,
    }],
  }
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
          return (await query.collect())[0]
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
      for (const table of Object.keys(rows)) {
        const row = rows[table]!.find((row) => row._id === id)
        if (row) return row
      }
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

function ctx(role: "viewer" | "editor" | "admin" | "owner") {
  return {
    db: db(role),
    auth: {
      getUserIdentity: async () => ({
        tokenIdentifier: "user_token",
      }),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

afterEach(() => {
  vi.restoreAllMocks()
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

describe("Convex Agent Extensions role policy", () => {
  test.each(["viewer", "editor"] as const)("denies %s workspace members admin Agent Extension mutations", async (role) => {
    const input = ctx(role)

    await expect(handler(authorizeAdmin)(input, { workspace_id: "ws_1" })).rejects.toThrow("Workspace not found")
    await expect(handler(upsert)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "new" },
    })).rejects.toThrow("Workspace not found")
    await expect(handler(setEnabled)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      enabled: false,
    })).rejects.toThrow("Workspace not found")
    await expect(handler(remove)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
    })).rejects.toThrow("Workspace not found")
    await expect(handler(setPolicyOverride)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
      enabled: false,
    })).rejects.toThrow("Workspace not found")
    await expect(handler(removePolicyOverride)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
    })).rejects.toThrow("Workspace not found")
  })

  test("allows admin workspace members to manage Agent Extension installs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx("admin")

    await expect(handler(authorizeAdmin)(input, { workspace_id: "ws_1" })).resolves.toEqual({ allowed: true })
    await expect(handler(upsert)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "new" },
    })).resolves.toEqual({ extension_id: "review" })
    expect(input.db.rows.agent_extension_installs[0]).toMatchObject({
      lock: { resolved_sha: "new" },
      updated_at: 123_456,
      deleted_at: undefined,
    })

    await expect(handler(setEnabled)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      enabled: false,
    })).resolves.toEqual({ extension_id: "review", enabled: false })
    expect(input.db.rows.agent_extension_installs[0]).toMatchObject({
      enabled: false,
      desired: {
        enabled: false,
        updated_at: 123_456,
      },
    })

    await expect(handler(remove)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
    })).resolves.toEqual({ ok: true })
    expect(input.db.rows.agent_extension_installs[0]).toMatchObject({
      deleted_at: 123_456,
      updated_at: 123_456,
    })
  })

  test("lists org, user, and workspace policy overrides for signed users", async () => {
    const input = ctx("admin")

    await expect(handler(listPolicyOverrides)(input, {
      workspace_id: "ws_1",
    })).resolves.toEqual([
      { id: "review", scope: "org", enabled: false, reason: "blocked by org" },
      { id: "review", scope: "user", enabled: true },
      { id: "review", scope: "workspace", enabled: true, reason: "workspace allow" },
    ])
  })

  test("runtime policy override hydration excludes user-specific overrides", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    const input = ctx("admin")

    await expect(handler(listPolicyOverridesForRuntime)(input, {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    })).resolves.toEqual([
      { id: "review", scope: "org", enabled: false, reason: "blocked by org" },
      { id: "review", scope: "workspace", enabled: true, reason: "workspace allow" },
    ])
  })

  test("allows admin workspace members to manage Agent Extension policy overrides", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const input = ctx("admin")

    await expect(handler(setPolicyOverride)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
      enabled: false,
      reason: "blocked by workspace",
    })).resolves.toEqual({ extension_id: "review", scope: "workspace" })
    expect(input.db.rows.agent_extension_policy_overrides.find((item) =>
      item.scope === "workspace" && item.extension_id === "review"
    )).toMatchObject({
      scope: "workspace",
      workspace_id: "workspace_1",
      extension_id: "review",
      enabled: false,
      reason: "blocked by workspace",
      updated_at: 123_456,
    })

    await expect(handler(removePolicyOverride)(input, {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "workspace",
    })).resolves.toEqual({ ok: true })
    expect(input.db.rows.agent_extension_policy_overrides.find((item) =>
      item.scope === "workspace" && item.extension_id === "review"
    )).toMatchObject({
      deleted_at: 123_456,
      updated_at: 123_456,
    })
  })

  test("runtime policy override hydration rejects missing or wrong service tokens", async () => {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const input = ctx("admin")

    await expect(handler(listPolicyOverridesForRuntime)(input, {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    })).rejects.toThrow("Unauthenticated")

    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

    await expect(handler(listPolicyOverridesForRuntime)(input, {
      workspace_id: "ws_1",
      service_token: "wrong",
    })).rejects.toThrow("Unauthenticated")
  })
})
