import BetterSqlite3 from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteWorkGraphArchivePort } from "../../src"
import { createSqliteAttemptRuntime, createSqliteWorkGraphService } from "../../src/adapters/sqlite/store"
import type { CompletionContract, CompletionRequirementID, OperationID, StreamID, WorkGraphContext } from "../../src/contracts"
import type { WorkspaceExecutionPort } from "../../src/ports"
import { workGraphArchiveContract, workGraphAttentionContract, workGraphSnapshotRestartContract, workGraphStoreContract } from "./store-contract"

const databases: BetterSqlite3.Database[] = []
const temporaryDirectories: string[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.open) database.close()
  })
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

workGraphStoreContract("SQLite", async (input) => {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  const adapter = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: input.clock, ids: input.ids, execution })
  return {
    ...adapter,
    restart: async () => ({ attemptRuntime: createSqliteAttemptRuntime(database, input.clock) }),
  }
})

workGraphSnapshotRestartContract("SQLite", async (input) => {
  const directory = mkdtempSync(join(tmpdir(), "claxedo-workgraph-snapshot-"))
  const path = join(directory, "workgraph.sqlite")
  temporaryDirectories.push(directory)
  let database = new BetterSqlite3(path)
  databases.push(database)

  return {
    service: createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: input.clock, ids: input.ids }).service,
    restart: async () => {
      database.close()
      database = new BetterSqlite3(path)
      databases.push(database)
      return {
        service: createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: input.clock, ids: input.ids }).service,
      }
    },
  }
})

workGraphAttentionContract("SQLite", async () => {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  const service = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => 1_000 } }).service
  return {
    service,
    seed: async (context) => {
      const stream = await service.execute(context, {
        operationId: operation(`attention_stream_${context.ownerUserId}`),
        command: { version: 1, type: "create_stream", title: "Attention" },
      })
      if (!stream.ok || !stream.value || typeof stream.value !== "object" || Array.isArray(stream.value) || typeof stream.value.streamId !== "string") throw new Error("Attention Stream was not created")
      const item = await service.execute(context, {
        operationId: operation(`attention_item_${context.ownerUserId}`),
        command: {
          version: 1,
          type: "create_work_item",
          streamId: stream.value.streamId as StreamID,
          title: "Review",
          completionContract: { version: 1, mode: "all", requirements: [{ id: "owner" as never, kind: "owner_confirmation", description: "Owner reviews" }] },
        },
      })
      if (!item.ok || !item.value || typeof item.value !== "object" || Array.isArray(item.value) || typeof item.value.workItemId !== "string") throw new Error("Attention Task was not created")
      database.prepare("UPDATE wg_v2_work_items SET lifecycle = 'review_needed', updated_at = 200 WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
        .run(context.organizationId, context.ownerUserId, item.value.workItemId)
      database.prepare(`
        INSERT INTO wg_v2_intake_candidates
          (organization_id, owner_user_id, id, workgraph_id, candidate_kind, title, status, created_at, updated_at)
        VALUES (?, ?, ?, 'workgraph_default', 'session', 'Unorganized', 'unorganized', 100, 100)
      `).run(context.organizationId, context.ownerUserId, `candidate_${context.ownerUserId}`)
      return { expectedKinds: ["work_item", "unorganized_ai_work"] as const }
    },
  }
})

workGraphArchiveContract("SQLite", async (input) => {
  const source = new BetterSqlite3(":memory:")
  const emptyTarget = new BetterSqlite3(":memory:")
  const nonEmptyTarget = new BetterSqlite3(":memory:")
  databases.push(source, emptyTarget, nonEmptyTarget)

  const sourceService = createSqliteWorkGraphService({ database: source, executionCapabilities: testExecutionCapabilities, clock: input.clock, ids: input.ids }).service
  const nonEmptyService = createSqliteWorkGraphService({ database: nonEmptyTarget, executionCapabilities: testExecutionCapabilities, clock: input.clock, ids: input.ids }).service
  await sourceService.execute(input.owners.first, {
    operationId: operation("archive_source_stream"),
    command: { version: 1, type: "create_stream", title: "Ship archive conformance" },
  })
  await sourceService.execute(input.owners.first, {
    operationId: operation("archive_source_document"),
    command: { version: 1, type: "create_work_source", title: "Archive plan", content: "Preserve this immutable revision." },
  })
  await nonEmptyService.execute(input.owners.first, {
    operationId: operation("archive_existing_stream"),
    command: { version: 1, type: "create_stream", title: "Existing target work" },
  })

  return {
    source: createSqliteWorkGraphArchivePort(source, input.clock),
    emptyTarget: createSqliteWorkGraphArchivePort(emptyTarget, input.clock),
    nonEmptyTarget: createSqliteWorkGraphArchivePort(nonEmptyTarget, input.clock),
  }
})

const execution: WorkspaceExecutionPort = {
  provisionOrAdopt: async (_context, input) => ({
    id: "envelope_conformance" as never,
    streamId: input.streamId,
    environment: input.environment,
    repository: input.repository,
    workspaceId: "/tmp/workgraph-conformance",
  }),
  launch: async (_context, input) => ({ sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId }),
  cancel: async () => undefined,
  result: async () => ({ state: "running" }),
  cleanup: async () => undefined,
}

describe("SQLite WorkGraph persistence", () => {
  it("persists actual Stream IDs and per-Stream sequences without a hidden Stream anchor", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let id = 0
    const adapter = createSqliteWorkGraphService({
      database,
      executionCapabilities: testExecutionCapabilities,
      clock: { now: () => 1_000 + id },
      ids: { next: (kind) => `${kind}_${++id}` },
    })
    const created = await adapter.service.execute(owner(), {
      operationId: operation("create"),
      command: { version: 1, type: "create_stream", title: "Ship" },
    })
    if (!created.ok || typeof created.value !== "object" || !created.value || Array.isArray(created.value)) throw new Error("Expected Stream")
    const streamId = created.value.streamId as StreamID
    await adapter.service.execute(owner(), {
      operationId: operation("update"),
      command: {
        version: 1,
        type: "update_stream",
        streamId,
        expectedVersion: 1,
        title: "Ship now",
        recap: {
          model: { providerId: "openai", modelId: "gpt-5" },
          quietHours: 16,
          effort: "high",
        },
      },
    })
    await expect(adapter.service.query(owner(), "streams", "read", { streamId })).resolves.toMatchObject({
      recapDefaults: {
        model: { providerId: "openai", modelId: "gpt-5" },
        quietHours: 16,
        effort: "high",
      },
    })
    await adapter.service.execute(owner(), {
      operationId: operation("clear_settings"),
      command: {
        version: 1,
        type: "update_stream",
        streamId,
        expectedVersion: 2,
        execution: {},
        recap: {},
      },
    })
    await expect(adapter.service.query(owner(), "streams", "read", { streamId })).resolves.toMatchObject({
      version: 3,
      executionDefaults: {},
      recapDefaults: {},
    })
    await adapter.service.execute(owner(), {
      operationId: operation("source"),
      command: { version: 1, type: "create_work_source", title: "Plan", content: "Plan content" },
    })

    expect(database.prepare(`
      SELECT stream_id, sequence FROM wg_v2_events WHERE organization_id = ? AND owner_user_id = ? AND event_type IN ('stream_created', 'stream_updated') ORDER BY sequence
    `).all("organization", "owner")).toEqual([
      { stream_id: streamId, sequence: 1 },
      { stream_id: streamId, sequence: 2 },
      { stream_id: streamId, sequence: 3 },
    ])
    expect(database.prepare(`
      SELECT stream_id FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ? AND change_type IN ('stream_created', 'stream_updated') ORDER BY cursor
    `).all("organization", "owner")).toEqual([
      { stream_id: streamId },
      { stream_id: streamId },
      { stream_id: streamId },
    ])
    expect(database.prepare(`
      SELECT stream_id FROM wg_v2_events WHERE organization_id = ? AND owner_user_id = ? AND event_type = 'work_source_created'
    `).get("organization", "owner")).toEqual({ stream_id: null })
    expect(database.prepare("SELECT id FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id LIKE '__workgraph_%'").all("organization", "owner")).toEqual([])

    const deleted = await adapter.service.execute(owner(), {
      operationId: operation("delete"),
      command: { version: 1, type: "delete_stream", streamId, expectedVersion: 3, reason: "Discard" },
    })
    expect(deleted.ok).toBe(true)
    expect(database.prepare(`
      SELECT stream_id, sequence FROM wg_v2_events WHERE organization_id = ? AND owner_user_id = ? AND event_type = 'stream_deleted'
    `).get("organization", "owner")).toEqual({ stream_id: streamId, sequence: 4 })
    expect(database.prepare(`
      SELECT stream_id FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ? AND change_type = 'stream_deleted'
    `).get("organization", "owner")).toEqual({ stream_id: streamId })
    await expect(adapter.service.query(owner(), "changes", "listStream", { streamId })).resolves.toHaveLength(4)
    await expect(adapter.service.query(owner(), "streams", "read", { streamId })).resolves.toBeUndefined()
  })

  it("stores a valid pending Work Item state and rejects missing dependencies without a partial row", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let id = 0
    const adapter = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, ids: { next: (kind) => `${kind}_${++id}` } })
    const created = await adapter.service.execute(owner(), {
      operationId: operation("create"),
      command: { version: 1, type: "create_stream", title: "Ship" },
    })
    if (!created.ok || typeof created.value !== "object" || !created.value || Array.isArray(created.value)) throw new Error("Expected Stream")
    const streamId = created.value.streamId as StreamID
    const contract = {
      version: 1,
      mode: "all" as const,
      requirements: [{ id: branded<CompletionRequirementID>("requirement"), kind: "test" as const, description: "Tests pass" }],
    } satisfies CompletionContract
    const valid = await adapter.service.execute(owner(), {
      operationId: operation("valid"),
      command: { version: 1, type: "create_work_item", streamId, title: "Test", completionContract: contract },
    })
    expect(valid.ok).toBe(true)
    expect(database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE owner_user_id = ? AND title = ?").get("owner", "Test"))
      .toEqual({ lifecycle: "pending" })

    const invalid = await adapter.service.execute(owner(), {
      operationId: operation("invalid"),
      command: {
        version: 1,
        type: "create_work_item",
        streamId,
        title: "Invalid",
        dependencyIds: [branded("missing")],
        completionContract: contract,
      },
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items WHERE owner_user_id = ? AND title = ?").get("owner", "Invalid"))
      .toEqual({ count: 0 })
  })
})

const branded = <Type>(value: string) => value as Type

function operation(value: string) {
  return branded<OperationID>(value)
}

function owner(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: branded("owner"),
    actor: { type: "user", id: branded("owner") },
    requestId: branded("request"),
    access: { mode: "owner" },
  }
}
import { testExecutionCapabilities } from "../test-execution-capabilities"
