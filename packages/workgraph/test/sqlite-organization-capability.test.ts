import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { initializeWorkGraphSqliteSchema } from "../src/adapters/sqlite/schema"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"
import type { ExecutionCapabilities, WorkGraphContext } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite organization-scoped personal WorkGraphs", () => {
  it("isolates the same user and idempotency key across organizations", async () => {
    const database = open()
    let next = 0
    const service = createSqliteWorkGraphService({
      database,
      ids: { next: (kind) => `${kind}_${++next}` },
      clock: { now: () => 1_000 + next },
    }).service
    const operationId = "same_operation" as never

    await expect(service.execute(owner("organization_a"), {
      operationId,
      command: { version: 1, type: "create_stream", title: "Organization A" },
    })).resolves.toMatchObject({ ok: true })
    await expect(service.execute(owner("organization_b"), {
      operationId,
      command: { version: 1, type: "create_stream", title: "Organization B" },
    })).resolves.toMatchObject({ ok: true })

    const first = await service.query(owner("organization_a"), "snapshot", "page", { limit: 50 })
    const second = await service.query(owner("organization_b"), "snapshot", "page", { limit: 50 })
    expect(first.records.filter((record) => record.recordType === "stream")).toEqual([
      expect.objectContaining({ title: "Organization A", ownerUserId: "same_user" }),
    ])
    expect(second.records.filter((record) => record.recordType === "stream")).toEqual([
      expect.objectContaining({ title: "Organization B", ownerUserId: "same_user" }),
    ])
    expect(database.prepare("SELECT organization_id, owner_user_id, id FROM wg_v2_operation_results ORDER BY organization_id").all())
      .toEqual([
        { organization_id: "organization_a", owner_user_id: "same_user", id: "same_operation" },
        { organization_id: "organization_b", owner_user_id: "same_user", id: "same_operation" },
      ])
  })

  it("rejects a capability catalog from another organization before persisting defaults", async () => {
    const database = open()
    const context = owner("organization_b")
    const service = createSqliteWorkGraphService({
      database,
      executionCapabilities: { read: async () => capabilities(owner("organization_a")) },
    }).service

    await expect(service.execute(context, {
      operationId: "defaults_cross_org" as never,
      command: {
        version: 1,
        type: "update_workgraph_defaults",
        expectedVersion: 1,
        defaults: { execution: profile, recap: {} },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_error", message: expect.stringContaining("organization_mismatch") },
    })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_operation_results").get()).toEqual({ count: 0 })
  })

  it("rejects unsupported Stream Recap settings before creating or updating a Stream", async () => {
    const database = open()
    const context = owner("organization_a")
    let next = 0
    const service = createSqliteWorkGraphService({
      database,
      executionCapabilities: { read: async () => capabilities(context) },
      ids: { next: (kind) => `${kind}_${++next}` },
    }).service

    await expect(service.execute(context, {
      operationId: "recap_create_unknown" as never,
      command: {
        version: 1,
        type: "create_stream",
        title: "Unsupported recap",
        recap: { model: { providerId: "openai", modelId: "missing" }, effort: "high", quietHours: 8 },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_error", message: expect.stringContaining("unsupported_model") },
    })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams").get()).toEqual({ count: 0 })

    const created = await service.execute(context, {
      operationId: "recap_create_supported" as never,
      command: { version: 1, type: "create_stream", title: "Supported recap" },
    })
    const streamId = valueId(created, "streamId")
    await expect(service.execute(context, {
      operationId: "recap_update_unknown" as never,
      command: {
        version: 1,
        type: "update_stream",
        streamId,
        expectedVersion: 1,
        recap: { model: { providerId: "openai", modelId: "missing" }, effort: "high", quietHours: 8 },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: "validation_error" } })
    expect(database.prepare("SELECT row_version, recap_defaults_json FROM wg_v2_streams WHERE id = ?").get(streamId))
      .toEqual({ row_version: 1, recap_defaults_json: "{}" })
  })

  it("requires a connected capability catalog before persisting explicit Stream Recap execution settings", async () => {
    const database = open()
    const service = createSqliteWorkGraphService({ database }).service
    await expect(service.execute(owner("organization_a"), {
      operationId: "recap_catalog_missing" as never,
      command: {
        version: 1,
        type: "create_stream",
        title: "No catalog",
        recap: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high", quietHours: 8 },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: "execution_unavailable" } })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams").get()).toEqual({ count: 0 })
  })

  it("revalidates the resolved profile against the current catalog before Attempt admission", async () => {
    const database = open()
    const context = owner("organization_a")
    let catalog = capabilities(context)
    let next = 0
    const service = createSqliteWorkGraphService({
      database,
      execution: {
        provisionOrAdopt: async () => { throw new Error("Attempt must not reach placement") },
        launch: async () => { throw new Error("Attempt must not reach launch") },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
        cleanup: async () => undefined,
      },
      executionCapabilities: { read: async () => catalog },
      ids: { next: (kind) => `${kind}_${++next}` },
    }).service
    await service.execute(context, {
      operationId: "defaults" as never,
      command: { version: 1, type: "update_workgraph_defaults", expectedVersion: 1, defaults: { execution: profile, recap: {} } },
    })
    const stream = await service.execute(context, {
      operationId: "stream" as never,
      command: { version: 1, type: "create_stream", title: "Catalog drift" },
    })
    const streamId = valueId(stream, "streamId")
    const item = await service.execute(context, {
      operationId: "item" as never,
      command: {
        version: 1,
        type: "create_work_item",
        streamId,
        title: "Execute exactly",
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{ id: "owner_review" as never, kind: "owner_confirmation", description: "Owner accepts" }],
        },
      },
    })
    catalog = { ...catalog, models: [{ ...catalog.models[0]!, modelId: "gpt-5-mini" }] }

    await expect(service.execute(context, {
      operationId: "execute" as never,
      command: { version: 1, type: "execute_work_item", workItemId: valueId(item, "workItemId"), executionMode: "autonomous" },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_error", message: expect.stringContaining("unsupported_model") },
    })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts").get()).toEqual({ count: 0 })
  })

  it("rejects owner-only legacy tables before making a partial schema change", () => {
    const database = open()
    database.exec("CREATE TABLE wg_v2_workgraphs (owner_user_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (owner_user_id, id))")
    expect(() => initializeWorkGraphSqliteSchema(database)).toThrow("trusted organization mapping is required")
    expect(database.prepare("PRAGMA table_info(wg_v2_workgraphs)").all()).not.toContainEqual(expect.objectContaining({ name: "organization_id" }))
  })
})

const profile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [] as string[],
  connectionIds: [],
}

function capabilities(context: WorkGraphContext): ExecutionCapabilities {
  const observedAt = Date.now()
  return {
    schemaVersion: 1,
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    catalogRevision: "1".repeat(64),
    observedAt,
    expiresAt: observedAt + 300_000,
    environments: [{
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "claxedo-v2" }],
    agents: [{ harnessId: "claxedo-v2", id: "build", label: "Build" }],
    models: [{ harnessId: "claxedo-v2", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["high"] }],
    tools: [{ harnessId: "claxedo-v2", id: "read" }],
    repository: { baseRevisions: ["HEAD"] },
    connections: [],
  }
}

function owner(organizationId: string): WorkGraphContext {
  return {
    organizationId: organizationId as WorkGraphContext["organizationId"],
    ownerUserId: "same_user" as WorkGraphContext["ownerUserId"],
    actor: { type: "user", id: "same_user" as WorkGraphContext["actor"]["id"] },
    requestId: `request_${organizationId}` as WorkGraphContext["requestId"],
    access: { mode: "owner" },
  }
}

function valueId(result: unknown, key: string) {
  const parsed = result as { ok?: boolean; value?: Record<string, unknown> }
  const value = parsed.value?.[key]
  if (!parsed.ok || typeof value !== "string") throw new Error(`Expected ${key}`)
  return value as never
}

function open() {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  return database
}
