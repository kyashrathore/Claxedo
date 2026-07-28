import { beforeEach, describe, expect, test } from "vitest"
import {
  bindRunConnections,
  listMetadata,
  resolveWebhookMetadata,
  resolveOperationBinding,
  revokeRunBinding,
  upsertMetadata,
} from "../../../../convex/workgraphConnections"

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "service-secret"
})

describe("Convex WorkGraph Connection bindings", () => {
  test("stores only sanitized metadata in the canonical org partition", async () => {
    const db = fixture()
    const result = await invoke(upsertMetadata, db, metadata())

    expect(result).toEqual({
      id: "connection-github",
      integrationId: "github",
      capabilities: ["work-source"],
      status: "connected",
      accountLabel: "Acme GitHub",
      fields: { installation_id: "123" },
      tokenType: "bearer",
      orgId: "org-a",
    })
    expect(db.rows.workgraph_connection_metadata).toEqual([
      expect.objectContaining({
        organization_id: "org-a",
        connection_id: "connection-github",
        integration_id: "github",
        capabilities: ["work-source"],
        status: "connected",
        fields: { installation_id: "123" },
      }),
    ])
    expect(JSON.stringify(db.rows.workgraph_connection_metadata)).not.toMatch(/github_pat_|authorization|access_token|secret/i)
  })

  test("rejects secret-shaped metadata and non-member partitions", async () => {
    const db = fixture()
    await expect(invoke(upsertMetadata, db, metadata({ fields: { access_token: "github_pat_1234567890abcdef" } })))
      .rejects.toThrow("cannot contain credential material")
    await expect(invoke(upsertMetadata, db, metadata({ fields: { arbitrary: "not-a-secret" } })))
      .rejects.toThrow("Unsupported github Connection metadata field")
    await expect(invoke(upsertMetadata, db, metadata({ fields: { installation_id: "github_pat_1234567890abcdef" } })))
      .rejects.toThrow("credential material")
    await expect(invoke(upsertMetadata, db, metadata({ ownerUserId: "user-c" })))
      .rejects.toThrow("not an org member")
    expect(db.rows.workgraph_connection_metadata).toEqual([])
  })

  test("shares one team Connection across org members and rejects cross-provider or cross-org reuse", async () => {
    const db = fixture()
    await invoke(upsertMetadata, db, metadata())
    await invoke(upsertMetadata, db, metadata({ ownerUserId: "user-b", accountLabel: "Shared GitHub" }))

    expect(db.rows.workgraph_connection_metadata).toHaveLength(1)
    expect(db.rows.workgraph_connection_metadata[0]).toMatchObject({
      organization_id: "org-a",
      connection_id: "connection-github",
      account_label: "Shared GitHub",
      row_version: 2,
    })
    await expect(invoke(listMetadata, db, { ownerUserId: "user-a", orgId: "org-a" }))
      .resolves.toEqual([expect.objectContaining({ id: "connection-github", accountLabel: "Shared GitHub" })])
    await expect(invoke(listMetadata, db, { ownerUserId: "user-b", orgId: "org-a" }))
      .resolves.toEqual([expect.objectContaining({ id: "connection-github", accountLabel: "Shared GitHub" })])
    await expect(invoke(upsertMetadata, db, metadata({
      ownerUserId: "user-b",
      integrationId: "linear",
      fields: { team_id: "team-a" },
    }))).rejects.toThrow("integration cannot change")
    await expect(invoke(upsertMetadata, db, metadata({ ownerUserId: "user-c", orgId: "org-b" })))
      .rejects.toThrow("belongs to another org")
  })

  test("resolves only connected work-source metadata for host-internal webhook verification", async () => {
    const db = fixture()
    await invoke(upsertMetadata, db, metadata())
    await expect(invoke(resolveWebhookMetadata, db, { connectionId: "connection-github" })).resolves.toMatchObject({
      id: "connection-github",
      integrationId: "github",
      capabilities: ["work-source"],
      status: "connected",
      orgId: "org-a",
    })
    await expect(invoke(resolveWebhookMetadata, db, { connectionId: "missing" })).resolves.toBeNull()
    await invoke(upsertMetadata, db, metadata({ status: "degraded" }))
    await expect(invoke(resolveWebhookMetadata, db, { connectionId: "connection-github" })).resolves.toBeNull()
    await invoke(upsertMetadata, db, metadata({ capabilities: ["docs"] }))
    await expect(invoke(resolveWebhookMetadata, db, { connectionId: "connection-github" })).resolves.toBeNull()
  })

  test("binds only the immutable Run profile and resolves an exact connected operation", async () => {
    const db = fixture()
    await invoke(upsertMetadata, db, metadata())
    await expect(invoke(bindRunConnections, db, binding())).resolves.toEqual({ bound: true })

    const resolved = await invoke(resolveOperationBinding, db, operation())
    expect(resolved).toEqual({
      context: { ownerUserId: "user-a", ownerPartition: "org:org-a" },
      runId: "run-a",
      sessionId: "session-a",
      workspaceId: "workspace-a",
      connectionIds: ["connection-github"],
      tools: ["connection_work_source_list"],
      connection: {
        id: "connection-github",
        integrationId: "github",
        capabilities: ["work-source"],
        status: "connected",
        accountLabel: "Acme GitHub",
        fields: { installation_id: "123" },
        tokenType: "bearer",
        orgId: "org-a",
      },
    })
    for (const patch of [
      { ownerUserId: "user-b" },
      { orgId: "org-b" },
      { sessionId: "session-b" },
      { workspaceId: "workspace-b" },
      { connectionId: "connection-other" },
      { tool: "connection_work_source_update" },
    ]) {
      await expect(invoke(resolveOperationBinding, db, operation(patch))).resolves.toBeNull()
    }
  })

  test("fails closed for profile escalation, degraded metadata, and revoked bindings", async () => {
    const db = fixture()
    await invoke(upsertMetadata, db, metadata())
    await expect(invoke(bindRunConnections, db, binding({ connectionIds: ["connection-other"] })))
      .rejects.toThrow("immutable Run profile")
    await expect(invoke(bindRunConnections, db, binding({ tools: ["connection_work_source_update"] })))
      .rejects.toThrow("immutable Run profile")

    await invoke(bindRunConnections, db, binding())
    await invoke(upsertMetadata, db, metadata({ status: "degraded" }))
    await expect(invoke(resolveOperationBinding, db, operation())).resolves.toBeNull()
    await invoke(upsertMetadata, db, metadata())
    await expect(invoke(revokeRunBinding, db, { ownerUserId: "user-a", orgId: "org-a", runId: "run-a" })).resolves.toEqual({ revoked: true })
    await expect(invoke(resolveOperationBinding, db, operation())).resolves.toBeNull()
    await expect(invoke(revokeRunBinding, db, { ownerUserId: "user-a", orgId: "org-a", runId: "run-a" })).resolves.toEqual({ revoked: false })
  })
})

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: "user-a",
    orgId: "org-a",
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

function binding(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: "user-a",
    orgId: "org-a",
    runId: "run-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    connectionIds: ["connection-github"],
    tools: ["connection_work_source_list"],
    ...overrides,
  }
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    ...binding(),
    connectionId: "connection-github",
    tool: "connection_work_source_list",
    ...overrides,
  }
}

function fixture() {
  return new MemoryDb({
    org_memberships: [
      { _id: "membership-a", org_id: "org-a", user_id: "user-a" },
      { _id: "membership-b", org_id: "org-a", user_id: "user-b" },
      { _id: "membership-c", org_id: "org-b", user_id: "user-c" },
    ],
    workgraph_runs: [{
      _id: "run-row",
      organization_id: "org-a",
      owner_user_id: "user-a",
      id: "run-a",
      state: "running",
      session_id: "session-a",
      envelope_id: "workspace-a",
      resolved_execution: {
        connectionIds: ["connection-github"],
        tools: ["connection_work_source_list"],
      },
    }],
    workgraph_connection_metadata: [],
    workgraph_run_connection_bindings: [],
  })
}

function invoke(fn: unknown, db: MemoryDb, args: Record<string, unknown>) {
  return (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler(
    { db },
    { service_token: "service-secret", ...args },
  )
}

class MemoryDb {
  rows: Record<string, Array<Record<string, any>>>
  private next = 0

  constructor(rows: Record<string, Array<Record<string, any>>>) {
    this.rows = rows
  }

  query(table: string) {
    let selected = [...(this.rows[table] ?? [])]
    const chain = {
      withIndex: (_name: string, build: (query: any) => unknown) => {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = []
        const query = {
          eq: (field: string, value: unknown) => {
            predicates.push((row) => row[field] === value)
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => predicates.every((predicate) => predicate(row)))
        return chain
      },
      unique: async () => selected[0] ?? null,
      collect: async () => selected,
      take: async (limit: number) => selected.slice(0, limit),
    }
    return chain
  }

  async insert(table: string, value: Record<string, unknown>) {
    const id = `${table}-${++this.next}`
    ;(this.rows[table] ??= []).push({ _id: id, ...value })
    return id
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = Object.values(this.rows).flat().find((candidate) => candidate._id === id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }

  async delete(id: string) {
    Object.keys(this.rows).forEach((table) => {
      this.rows[table] = this.rows[table]!.filter((row) => row._id !== id)
    })
  }
}
