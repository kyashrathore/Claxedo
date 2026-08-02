import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
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

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
})

afterEach(() => vi.unstubAllEnvs())

/**
 * WorkGraph Connection binding policy: sanitized metadata storage, one team
 * Connection shared across org members, immutable Run profiles, and revoked
 * bindings. These are `serviceMutation`/`serviceQuery` — every entry point
 * requires org membership through `requireOrgMember`/`isOrgMember`.
 *
 * The previous version of this suite drove a hand-written `MemoryDb` and used
 * bare strings ("org-a", "user-a") as ids; the real schema's `v.id("orgs")` /
 * `v.id("users")` args and `workgraph_runs.stream_id` (non-optional) reject
 * that shape, so this version seeds real documents throughout.
 */
async function fixture(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const orgA = await ctx.db.insert("orgs", stamped({ name: "A" }) as never)
    const orgB = await ctx.db.insert("orgs", stamped({ name: "B" }) as never)
    const userA = await ctx.db.insert("users", stamped({ token_identifier: "t-a", clerk_subject: "user-a" }) as never)
    const userB = await ctx.db.insert("users", stamped({ token_identifier: "t-b", clerk_subject: "user-b" }) as never)
    const userC = await ctx.db.insert("users", stamped({ token_identifier: "t-c", clerk_subject: "user-c" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgA, user_id: userA, role: "member" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgA, user_id: userB, role: "member" }) as never)
    await ctx.db.insert("org_memberships", stamped({ org_id: orgB, user_id: userC, role: "member" }) as never)
    await ctx.db.insert("workgraph_runs", stamped({
      organization_id: orgA,
      owner_user_id: userA,
      id: "run-a",
      stream_id: "stream-a",
      work_item_id: "work-item-a",
      run_number: 1,
      generation: 1,
      state: "running",
      resolved_execution: {
        connectionIds: ["connection-github"],
        tools: ["connection_work_source_list"],
      },
      admitted_at: 1,
      envelope_id: "workspace-a",
      session_id: "session-a",
      source_revision_refs: [],
      provenance: {},
      row_version: 1,
      schema_version: 1,
    }) as never)
    return { orgA, orgB, userA, userB, userC }
  })
}

function metadataArgs(ids: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    service_token: "service-secret",
    ownerUserId: ids.userA,
    orgId: ids.orgA,
    connectionId: "connection-github",
    integrationId: "github",
    capabilities: ["work-source"],
    status: "connected",
    accountLabel: "Acme GitHub",
    fields: { installation_id: "123" },
    tokenType: "bearer",
    ...overrides,
  }
}

function bindingArgs(ids: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    service_token: "service-secret",
    ownerUserId: ids.userA,
    orgId: ids.orgA,
    runId: "run-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    connectionIds: ["connection-github"],
    tools: ["connection_work_source_list"],
    ...overrides,
  }
}

function operationArgs(ids: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return {
    service_token: "service-secret",
    ownerUserId: ids.userA,
    orgId: ids.orgA,
    runId: "run-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    connectionId: "connection-github",
    tool: "connection_work_source_list",
    ...overrides,
  }
}

describe("Convex WorkGraph Connection bindings", () => {
  test("stores only sanitized metadata in the canonical org partition", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    const result = await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)

    expect(result).toEqual({
      id: "connection-github",
      integrationId: "github",
      capabilities: ["work-source"],
      status: "connected",
      accountLabel: "Acme GitHub",
      fields: { installation_id: "123" },
      tokenType: "bearer",
      orgId: String(ids.orgA),
    })
    const rows = await t.run(async (ctx) => ctx.db.query("workgraph_connection_metadata").collect())
    expect(rows).toEqual([
      expect.objectContaining({
        organization_id: ids.orgA,
        connection_id: "connection-github",
        integration_id: "github",
        capabilities: ["work-source"],
        status: "connected",
        fields: { installation_id: "123" },
      }),
    ])
    expect(JSON.stringify(rows)).not.toMatch(/github_pat_|authorization|access_token|secret/i)
  })

  test("rejects secret-shaped metadata and non-member partitions", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { fields: { access_token: "github_pat_1234567890abcdef" } }) as never))
      .rejects.toThrow("cannot contain credential material")
    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { fields: { arbitrary: "not-a-secret" } }) as never))
      .rejects.toThrow("Unsupported github Connection metadata field")
    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { fields: { installation_id: "github_pat_1234567890abcdef" } }) as never))
      .rejects.toThrow("credential material")
    // user-c is a member of org-b, not org-a (the default `orgId` here).
    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { ownerUserId: ids.userC }) as never))
      .rejects.toThrow("not an org member")

    const rows = await t.run(async (ctx) => ctx.db.query("workgraph_connection_metadata").collect())
    expect(rows).toEqual([])
  })

  test("shares one team Connection across org members and rejects cross-provider or cross-org reuse", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)
    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { ownerUserId: ids.userB, accountLabel: "Shared GitHub" }) as never)

    const rows = await t.run(async (ctx) => ctx.db.query("workgraph_connection_metadata").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      organization_id: ids.orgA,
      connection_id: "connection-github",
      account_label: "Shared GitHub",
      row_version: 2,
    })

    await expect(t.query(api.workgraphConnections.listMetadata, { service_token: "service-secret", ownerUserId: ids.userA, orgId: ids.orgA } as never))
      .resolves.toEqual([expect.objectContaining({ id: "connection-github", accountLabel: "Shared GitHub" })])
    await expect(t.query(api.workgraphConnections.listMetadata, { service_token: "service-secret", ownerUserId: ids.userB, orgId: ids.orgA } as never))
      .resolves.toEqual([expect.objectContaining({ id: "connection-github", accountLabel: "Shared GitHub" })])

    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, {
      ownerUserId: ids.userB,
      integrationId: "linear",
      fields: { team_id: "team-a" },
    }) as never)).rejects.toThrow("integration cannot change")
    await expect(t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { ownerUserId: ids.userC, orgId: ids.orgB }) as never))
      .rejects.toThrow("belongs to another org")
  })

  test("resolves only connected work-source metadata for host-internal webhook verification", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)
    await expect(t.query(api.workgraphConnections.resolveWebhookMetadata, { service_token: "service-secret", connectionId: "connection-github" } as never))
      .resolves.toMatchObject({
        id: "connection-github",
        integrationId: "github",
        capabilities: ["work-source"],
        status: "connected",
        orgId: String(ids.orgA),
      })
    await expect(t.query(api.workgraphConnections.resolveWebhookMetadata, { service_token: "service-secret", connectionId: "missing" } as never))
      .resolves.toBeNull()

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { status: "degraded" }) as never)
    await expect(t.query(api.workgraphConnections.resolveWebhookMetadata, { service_token: "service-secret", connectionId: "connection-github" } as never))
      .resolves.toBeNull()

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { capabilities: ["docs"] }) as never)
    await expect(t.query(api.workgraphConnections.resolveWebhookMetadata, { service_token: "service-secret", connectionId: "connection-github" } as never))
      .resolves.toBeNull()
  })

  test("binds only the immutable Run profile and resolves an exact connected operation", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)
    await expect(t.mutation(api.workgraphConnections.bindRunConnections, bindingArgs(ids) as never)).resolves.toEqual({ bound: true })

    const resolved = await t.query(api.workgraphConnections.resolveOperationBinding, operationArgs(ids) as never)
    expect(resolved).toEqual({
      context: { ownerUserId: String(ids.userA), ownerPartition: `org:${String(ids.orgA)}` },
      runId: "run-a",
      sessionId: "session-a",
      workspaceId: "workspace-a",
      connectionIds: ["connection-github"],
      tools: ["connection_work_source_list"],
      // The old suite's fixture never gave `workgraph_runs` a `stream_id` —
      // the hand-rolled `MemoryDb` enforced nothing, but the real schema
      // makes it non-optional, so a real seed always produces this field.
      streamId: "stream-a",
      connection: {
        id: "connection-github",
        integrationId: "github",
        capabilities: ["work-source"],
        status: "connected",
        accountLabel: "Acme GitHub",
        fields: { installation_id: "123" },
        tokenType: "bearer",
        orgId: String(ids.orgA),
      },
    })

    for (const patch of [
      { ownerUserId: ids.userB },
      { orgId: ids.orgB },
      { sessionId: "session-b" },
      { workspaceId: "workspace-b" },
      { connectionId: "connection-other" },
      { tool: "connection_work_source_update" },
    ]) {
      await expect(t.query(api.workgraphConnections.resolveOperationBinding, operationArgs(ids, patch) as never)).resolves.toBeNull()
    }
  })

  test("fails closed for profile escalation, degraded metadata, and revoked bindings", async () => {
    const t = convexTest(schema, modules)
    const ids = await fixture(t)

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)
    await expect(t.mutation(api.workgraphConnections.bindRunConnections, bindingArgs(ids, { connectionIds: ["connection-other"] }) as never))
      .rejects.toThrow("immutable Run profile")
    await expect(t.mutation(api.workgraphConnections.bindRunConnections, bindingArgs(ids, { tools: ["connection_work_source_update"] }) as never))
      .rejects.toThrow("immutable Run profile")

    await t.mutation(api.workgraphConnections.bindRunConnections, bindingArgs(ids) as never)
    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids, { status: "degraded" }) as never)
    await expect(t.query(api.workgraphConnections.resolveOperationBinding, operationArgs(ids) as never)).resolves.toBeNull()

    await t.mutation(api.workgraphConnections.upsertMetadata, metadataArgs(ids) as never)
    await expect(t.mutation(api.workgraphConnections.revokeRunBinding, { service_token: "service-secret", ownerUserId: ids.userA, orgId: ids.orgA, runId: "run-a" } as never))
      .resolves.toEqual({ revoked: true })
    await expect(t.query(api.workgraphConnections.resolveOperationBinding, operationArgs(ids) as never)).resolves.toBeNull()
    await expect(t.mutation(api.workgraphConnections.revokeRunBinding, { service_token: "service-secret", ownerUserId: ids.userA, orgId: ids.orgA, runId: "run-a" } as never))
      .resolves.toEqual({ revoked: false })
  })
})
