import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { anyApi } from "convex/server"
import schema from "./schema"
import agentPluginsSchema from "./components/agentPlugins/schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const componentModules = import.meta.glob("./components/agentPlugins/**/*.ts")
const featureApi = (anyApi as any)["agentPlugins.feature"]
const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
const service = { service_token: "svc_secret" }

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})

afterEach(() => {
  if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
})

async function fixture() {
  const t = convexTest(schema, modules)
  t.registerComponent("agentPlugins", agentPluginsSchema, componentModules)
  const ids = await t.run(async (ctx) => {
    const now = Date.now()
    const member = await ctx.db.insert("users", {
      token_identifier: "issuer|member",
      clerk_subject: "member",
      created_at: now,
      updated_at: now,
    })
    const admin = await ctx.db.insert("users", {
      token_identifier: "issuer|admin",
      clerk_subject: "admin",
      created_at: now,
      updated_at: now,
    })
    const outsider = await ctx.db.insert("users", {
      token_identifier: "issuer|outsider",
      clerk_subject: "outsider",
      created_at: now,
      updated_at: now,
    })
    const org = await ctx.db.insert("orgs", {
      clerk_org_id: "clerk_org_main",
      name: "Main",
      kind: "clerk",
      owner_user_id: admin,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("org_memberships", { org_id: org, user_id: member, role: "member", created_at: now, updated_at: now })
    await ctx.db.insert("org_memberships", { org_id: org, user_id: admin, role: "admin", created_at: now, updated_at: now })
    const projectA = await ctx.db.insert("projects", {
      project_id: "project-a",
      org_id: org,
      owner_user_id: member,
      created_at: now,
      updated_at: now,
    })
    const projectB = await ctx.db.insert("projects", {
      project_id: "project-b",
      org_id: org,
      owner_user_id: outsider,
      created_at: now,
      updated_at: now,
    })
    const workspaceA = await ctx.db.insert("workspaces", {
      workspace_id: "workspace-a",
      org_id: org,
      owner_user_id: member,
      project_id: "project-a",
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Workspace A",
      created_at: now,
      updated_at: now,
    })
    return { member, admin, outsider, org, projectA, projectB, workspaceA }
  })
  return { t, ids }
}

function actor(tokenIdentifier: string) {
  return {
    ...service,
    user: { token_identifier: tokenIdentifier },
    clerk_org_id: "clerk_org_main",
  }
}

const retained = {
  digest: `sha256:${"a".repeat(64)}`,
  sourceId: "org-collection",
  relativePath: "review",
  sourceRevision: "commit-1",
}

describe("Agent Plugins isolated Convex component", () => {
  test("evaluates all-project defaults dynamically and preserves an explicit project override", async () => {
    const { t } = await fixture()
    const member = actor("issuer|member")

    await expect(t.mutation(featureApi.mutateUser, {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["codex"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: retained,
      expected_revision: 0,
      operation_id: "enable-all",
    } as never)).resolves.toBe(1)

    const future = await t.query(featureApi.read, {
      ...member,
      project_id: "project-a",
      plugin_instance_id: "plugin-review",
      harness_id: "codex",
    } as never) as any
    expect(future).toMatchObject({
      revision: 1,
      userDefault: true,
      pins: { user: retained.digest },
    })
    expect(future).not.toHaveProperty("projectOverride")

    await expect(t.mutation(featureApi.mutateUser, {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["codex"],
      choice: false,
      target: { scope: "projects", project_ids: ["project-a"] },
      expected_revision: 1,
      operation_id: "disable-project-a",
    } as never)).resolves.toBe(2)

    const current = await t.query(featureApi.read, {
      ...member,
      project_id: "project-a",
      plugin_instance_id: "plugin-review",
      harness_id: "codex",
    } as never) as any
    expect(current).toMatchObject({ userDefault: true, projectOverride: false })
  })

  test("authorizes every project before the component writes a bulk choice", async () => {
    const { t } = await fixture()
    const member = actor("issuer|member")
    await expect(t.mutation(featureApi.mutateUser, {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["claude"],
      choice: true,
      target: { scope: "projects", project_ids: ["project-a", "project-b"] },
      artifact: retained,
      expected_revision: 0,
      operation_id: "unauthorized-batch",
    } as never)).rejects.toThrow("project access denied")

    await expect(t.query(featureApi.revision, member as never)).resolves.toBe(0)
    const known = await t.query(featureApi.listKnown, member as never)
    expect(known).toEqual([])
  })

  test("makes retries idempotent, stale writers deterministic, and Update pin-only", async () => {
    const { t } = await fixture()
    const member = actor("issuer|member")
    const mutation = {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["cursor"],
      choice: true,
      target: { scope: "all-projects" },
      artifact: retained,
      expected_revision: 0,
      operation_id: "same-operation",
    }
    await expect(t.mutation(featureApi.mutateUser, mutation as never)).resolves.toBe(1)
    await expect(t.mutation(featureApi.mutateUser, mutation as never)).resolves.toBe(1)

    await expect(t.mutation(featureApi.mutateUser, {
      ...mutation,
      operation_id: "stale-operation",
    } as never)).rejects.toThrow("revision-conflict:0:1")

    const replacement = { ...retained, digest: `sha256:${"b".repeat(64)}`, sourceRevision: "commit-2" }
    await expect(t.mutation(featureApi.updatePin, {
      ...member,
      authority: "user",
      plugin_instance_id: "plugin-review",
      artifact: replacement,
      expected_revision: 1,
      operation_id: "update-user-pin",
    } as never)).resolves.toBe(2)
    const snapshot = await t.query(featureApi.read, {
      ...member,
      project_id: "project-a",
      plugin_instance_id: "plugin-review",
      harness_id: "cursor",
    } as never) as any
    expect(snapshot).toMatchObject({ userDefault: true, pins: { user: replacement.digest } })
  })

  test("keeps the component inaccessible without the service facade and restricts org defaults to admins", async () => {
    const { t } = await fixture()
    const member = actor("issuer|member")
    const admin = actor("issuer|admin")

    await expect(t.mutation(featureApi.mutateOrganizationDefault, {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["opencode"],
      choice: true,
      artifact: retained,
      expected_revision: 0,
      operation_id: "member-org-default",
    } as never)).rejects.toThrow("admin access required")

    await expect(t.mutation(featureApi.mutateOrganizationDefault, {
      ...admin,
      plugin_instance_id: "plugin-review",
      harness_ids: ["opencode"],
      choice: true,
      artifact: retained,
      expected_revision: 0,
      operation_id: "admin-org-default",
    } as never)).resolves.toBe(1)

    await expect(t.query(featureApi.revision, {
      ...admin,
      service_token: "wrong",
    } as never)).rejects.toThrow("Unauthenticated")
  })

  test("re-authorizes internal runtime identity before returning effective state", async () => {
    const { t, ids } = await fixture()
    const member = actor("issuer|member")
    await t.mutation(featureApi.mutateUser, {
      ...member,
      plugin_instance_id: "plugin-review",
      harness_ids: ["opencode"],
      choice: true,
      target: { scope: "projects", project_ids: ["project-a"] },
      artifact: retained,
      expected_revision: 0,
      operation_id: "runtime-enable",
    } as never)

    await expect(t.query(featureApi.runtimeRead, {
      ...service,
      owner_user_id: String(ids.member),
      organization_id: String(ids.org),
      project_id: "project-a",
      workspace_id: "workspace-a",
      plugin_instance_id: "plugin-review",
      harness_id: "opencode",
    } as never)).resolves.toMatchObject({
      projectOverride: true,
      pins: { user: retained.digest },
    })

    await expect(t.query(featureApi.runtimeRead, {
      ...service,
      owner_user_id: String(ids.outsider),
      organization_id: String(ids.org),
      project_id: "project-a",
      workspace_id: "workspace-a",
      plugin_instance_id: "plugin-review",
      harness_id: "opencode",
    } as never)).rejects.toThrow("membership is required")
  })
})
