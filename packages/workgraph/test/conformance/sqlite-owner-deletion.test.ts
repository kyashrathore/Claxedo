import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSqliteWorkGraphOwnerDeletionPort,
  createSqliteWorkGraphService,
  createSqliteSessionIntakePort,
} from "../../src"
import {
  workGraphOwnerDeletionConformance,
  type OwnerDeletionCleanupObservation,
} from "../../src/conformance"
import type {
  CompletionRequirementID,
  OperationID,
  OwnerUserID,
  StreamID,
  WorkGraphContext,
  WorkItemID,
} from "../../src/contracts"
import type { WorkspaceExecutionPort } from "../../src/ports"
import { testExecutionCapabilities } from "../test-execution-capabilities"

const databases: BetterSqlite3.Database[] = []

afterEach(() => {
  vi.useRealTimers()
  databases.splice(0).forEach((database) => database.close())
})

describe("SQLite WorkGraph owner deletion conformance", () => {
  workGraphOwnerDeletionConformance(async (input) => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const service = createSqliteWorkGraphService({ database, clock: input.clock, ids: input.ids }).service
    const firstStream = await createStream(service, input.owners.first, "first_stream", "Primary workspace")
    const secondStream = await createStream(service, input.owners.first, "second_stream", "Secondary workspace")
    const otherStream = await createStream(service, input.owners.second, "other_stream", "Other owner workspace")
    const firstItem = await createWorkItem(service, input.owners.first, firstStream, "first_item")
    const secondItem = await createWorkItem(service, input.owners.first, secondStream, "second_item")
    const otherItem = await createWorkItem(service, input.owners.second, otherStream, "other_item")
    seedWorkspace(database, input.owners.first, firstStream, firstItem, "envelope_first", "child_first")
    seedWorkspace(database, input.owners.first, secondStream, secondItem, "envelope_second", "child_second")
    seedWorkspace(database, input.owners.second, otherStream, otherItem, "envelope_other", "child_other")
    seedOperationalState(database, input.owners.first)
    seedOperationalState(database, input.owners.second)

    const observations: OwnerDeletionCleanupObservation[] = []
    let failingEnvelope: string | undefined
    let cleanupRace: Readonly<{ started: () => void; finish: Promise<void> }> | undefined
    const execution = workspaceExecution(async (context, cleanup) => {
      observations.push({
        ownerUserId: context.ownerUserId,
        streamId: cleanup.streamId,
        envelopeId: cleanup.envelopeId,
        childIsolationIds: cleanup.childIsolationIds ?? [],
        ownerRecordCountAtCleanup: countOwnerRecords(database, context),
      })
      if (cleanup.envelopeId === failingEnvelope) throw new Error("owner_deletion_cleanup_secret")
      if (cleanupRace) {
        cleanupRace.started()
        await cleanupRace.finish
        cleanupRace = undefined
      }
    })

    return {
      deletion: createSqliteWorkGraphOwnerDeletionPort(database, execution, input.clock),
      expectedCleanup: [
        { streamId: firstStream, envelopeId: "envelope_first", childIsolationIds: ["child_first"] },
        { streamId: secondStream, envelopeId: "envelope_second", childIsolationIds: ["child_second"] },
      ],
      ownerRecordCount: async (context) => countOwnerRecords(database, context),
      cleanupObservations: () => observations,
      setCleanupFailure: (envelopeId) => { failingEnvelope = envelopeId },
      setExecutionBusy: async (context, busy) => {
        if (!busy) {
          database.prepare("DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND id = 'owner_delete_busy'")
            .run(context.organizationId, context.ownerUserId)
          return
        }
        database.prepare(`
          INSERT INTO wg_v2_leases
            (organization_id, owner_user_id, id, resource_type, resource_id, holder_id, expires_at, created_at, updated_at)
          VALUES (?, ?, 'owner_delete_busy', 'owner_deletion', 'owner_deletion', 'conformance', 999999, 1, 1)
        `).run(context.organizationId, context.ownerUserId)
      },
      raceOwnerWriteDuringCleanup: async (context, startDeletion) => {
        let cleanupStarted!: () => void
        let finishCleanup!: () => void
        const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
        const finish = new Promise<void>((resolve) => { finishCleanup = resolve })
        cleanupRace = { started: cleanupStarted, finish }
        const deleting = startDeletion()
        await started
        const write = await service.execute(context, {
          operationId: branded<OperationID>("operation_conformance_raced_command"),
          command: { version: 1, type: "create_stream", title: "Concurrent owner write" },
        })
        finishCleanup()
        return { deletionResult: await deleting, writeCommitted: write.ok }
      },
    }
  }).forEach((testCase) => it(testCase.name, testCase.run))

  it("serializes concurrent exact retries and retains only a redacted completion receipt", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context = owner("private_owner_identifier")
    const service = createSqliteWorkGraphService({ database }).service
    const streamId = await createStream(service, context, "concurrent_stream", "Concurrent deletion")
    database.prepare("UPDATE wg_v2_streams SET envelope_identity_json = ? WHERE owner_user_id = ? AND id = ?")
      .run(JSON.stringify({ id: "concurrent_envelope", workspaceId: "/tmp/concurrent" }), context.ownerUserId, streamId)

    let releaseCleanup!: () => void
    let signalCleanup!: () => void
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanup = resolve })
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleanupCount = 0
    const deletion = createSqliteWorkGraphOwnerDeletionPort(database, workspaceExecution(async () => {
      cleanupCount += 1
      signalCleanup()
      await cleanupBlocked
    }))
    const input = { operationId: branded<OperationID>("concurrent_delete") }
    const first = deletion.deleteOwner(context, input)
    await cleanupStarted

    const concurrentCommand = await service.execute(context, {
      operationId: branded<OperationID>("write_during_owner_delete"),
      command: { version: 1, type: "create_stream", title: "Must not survive deletion" },
    })
    if (concurrentCommand.ok || concurrentCommand.error.code !== "blocked") {
      throw new Error("Owner deletion allowed a concurrent WorkGraph command")
    }
    await expect(createSqliteSessionIntakePort(database).createUnorganized(context, {
      sessionId: "session_during_owner_delete",
      title: "Must not survive deletion",
      body: "Concurrent Session intake",
      observedAt: 12,
      idempotencyKey: "session_during_owner_delete",
    })).rejects.toThrow("WorkGraph owner deletion is in progress")

    await expectDeletionReason(deletion.deleteOwner(context, input), "in_progress")
    await expectDeletionReason(deletion.deleteOwner(context, {
      operationId: branded<OperationID>("concurrent_other_delete"),
    }), "in_progress")
    releaseCleanup()
    const result = await first
    await expect(deletion.deleteOwner(context, input)).resolves.toEqual(result)
    if (cleanupCount !== 1) throw new Error("Concurrent exact retry repeated workspace cleanup")
    if (countOwnerRecords(database, context) !== 0) throw new Error("Concurrent deletion left owner rows")

    const receipt = database.prepare("SELECT * FROM wg_owner_deletion_receipts").get()
    if (!receipt || JSON.stringify(receipt).includes(context.ownerUserId) || JSON.stringify(receipt).includes(input.operationId)) {
      throw new Error("Deletion receipt retained an owner or operation identifier")
    }
  })

  it("keeps the owner write barrier after partial cleanup failure until deletion is retried", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context = owner("cleanup_failure_owner")
    const service = createSqliteWorkGraphService({ database }).service
    const streamId = await createStream(service, context, "cleanup_failure_stream", "Cleanup failure")
    database.prepare("UPDATE wg_v2_streams SET envelope_identity_json = ? WHERE owner_user_id = ? AND id = ?")
      .run(JSON.stringify({ id: "cleanup_failure_envelope", workspaceId: "/tmp/cleanup-failure" }), context.ownerUserId, streamId)
    let fail = true
    const deletion = createSqliteWorkGraphOwnerDeletionPort(database, workspaceExecution(async () => {
      if (fail) throw new Error("cleanup failed")
    }))
    const input = { operationId: branded<OperationID>("cleanup_failure_delete") }

    await expectDeletionReason(deletion.deleteOwner(context, input), "cleanup_failed")
    const blocked = await service.execute(context, {
      operationId: branded<OperationID>("write_after_cleanup_failure"),
      command: { version: 1, type: "create_stream", title: "Must remain blocked" },
    })
    if (blocked.ok || blocked.error.code !== "blocked") {
      throw new Error("Cleanup failure released the owner write barrier")
    }

    fail = false
    await deletion.deleteOwner(context, input)
    if (countOwnerRecords(database, context) !== 0) throw new Error("Cleanup failure retry left owner rows")
  })

  it("renews the owner deletion lease throughout long external cleanup", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context = owner("long_cleanup_owner")
    const service = createSqliteWorkGraphService({ database }).service
    const streamId = await createStream(service, context, "long_cleanup_stream", "Long cleanup")
    database.prepare("UPDATE wg_v2_streams SET envelope_identity_json = ? WHERE owner_user_id = ? AND id = ?")
      .run(JSON.stringify({ id: "long_cleanup_envelope", workspaceId: "/tmp/long-cleanup" }), context.ownerUserId, streamId)
    let cleanupStarted!: () => void
    let releaseCleanup!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const deletion = createSqliteWorkGraphOwnerDeletionPort(database, workspaceExecution(async () => {
      cleanupStarted()
      await blocked
    }))
    const deleting = deletion.deleteOwner(context, { operationId: "long_cleanup_delete" as OperationID })
    await started

    await vi.advanceTimersByTimeAsync(7 * 60 * 1_000)

    const receipt = database.prepare("SELECT lease_expires_at FROM wg_owner_deletion_receipts WHERE state = 'cleaning'")
      .get() as { lease_expires_at: number }
    expect(receipt.lease_expires_at).toBeGreaterThan(Date.now())
    releaseCleanup()
    await deleting
  })

  it("does not admit autonomous work while owner workspace cleanup is in progress", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context = owner("autonomous_owner_delete")
    const seed = createSqliteWorkGraphService({ database }).service
    const streamId = await createStream(seed, context, "autonomous_stream", "Autonomous deletion")
    const workItemId = await createWorkItem(seed, context, streamId, "autonomous_item")
    database.prepare(`
      UPDATE wg_v2_streams SET execution_defaults_json = ?, envelope_identity_json = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).run(
      JSON.stringify(executionProfile),
      JSON.stringify({ id: "autonomous_envelope", workspaceId: "/tmp/autonomous" }),
      context.organizationId,
      context.ownerUserId,
      streamId,
    )
    let cleanupStarted!: () => void
    let releaseCleanup!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const deletion = createSqliteWorkGraphOwnerDeletionPort(database, workspaceExecution(async () => {
      cleanupStarted()
      await blocked
    }))
    const deleting = deletion.deleteOwner(context, { operationId: "autonomous_owner_delete" as OperationID })
    await started

    let launches = 0
    createSqliteWorkGraphService({
      database,
      executionCapabilities: testExecutionCapabilities,
      execution: autonomousExecution(() => { launches += 1 }),
      ids: { next: (kind) => `${kind}_during_delete` },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(workItemId))
      .toEqual({ count: 0 })
    expect(launches).toBe(0)
    releaseCleanup()
    await deleting
  })
})

async function createStream(
  service: ReturnType<typeof createSqliteWorkGraphService>["service"],
  context: WorkGraphContext,
  operationId: string,
  title: string,
) {
  const result = await service.execute(context, {
    operationId: branded<OperationID>(operationId),
    command: { version: 1, type: "create_stream", title },
  })
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value) ||
    typeof result.value.streamId !== "string") throw new Error("Expected created Stream")
  return result.value.streamId as StreamID
}

async function createWorkItem(
  service: ReturnType<typeof createSqliteWorkGraphService>["service"],
  context: WorkGraphContext,
  streamId: StreamID,
  operationId: string,
) {
  const result = await service.execute(context, {
    operationId: branded<OperationID>(operationId),
    command: {
      version: 1,
      type: "create_work_item",
      streamId,
      title: operationId,
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: branded<CompletionRequirementID>(`${operationId}_proof`), kind: "test", description: "Proof" }],
      },
    },
  })
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value) ||
    typeof result.value.workItemId !== "string") throw new Error("Expected created Work Item")
  return result.value.workItemId as WorkItemID
}

function seedWorkspace(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  streamId: StreamID,
  workItemId: WorkItemID,
  envelopeId: string,
  childIsolationId: string,
) {
  database.prepare("UPDATE wg_v2_streams SET envelope_identity_json = ? WHERE owner_user_id = ? AND id = ?")
    .run(JSON.stringify({ id: envelopeId, workspaceId: `/tmp/${envelopeId}` }), context.ownerUserId, streamId)
  database.prepare(`
    INSERT INTO wg_v2_runs
      (organization_id, owner_user_id, id, stream_id, work_item_id, run_number, lifecycle, resolved_execution_profile_json,
       envelope_id, child_workspace_id, terminal_result_json, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, 1, 'result', '{}', ?, ?, '{"summary":"done","artifacts":[]}', 10, 11, 11)
  `).run(context.organizationId, context.ownerUserId, `run_${workItemId}`, streamId, workItemId, envelopeId, childIsolationId)
  database.prepare(`
    INSERT INTO wg_v2_session_bindings
      (organization_id, owner_user_id, id, stream_id, session_id, project_id, current_work_item_id,
       current_run_id, state, bound_at, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 10, '{}', 10, 10)
  `).run(
    context.organizationId,
    context.ownerUserId,
    `binding_${workItemId}`,
    streamId,
    `session_${workItemId}`,
    `project_${workItemId}`,
    workItemId,
    `run_${workItemId}`,
  )
  database.prepare(`
    INSERT INTO wg_v2_agent_checkpoints
      (organization_id, owner_user_id, id, stream_id, work_item_id, run_id, session_binding_id,
       level, summary, evidence_ids_json, occurred_at, provenance_json, operation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'progress', 'Owner deletion checkpoint', '[]', 10, '{}', ?, 10, 10)
  `).run(
    context.organizationId,
    context.ownerUserId,
    `checkpoint_${workItemId}`,
    streamId,
    workItemId,
    `run_${workItemId}`,
    `binding_${workItemId}`,
    `checkpoint_operation_${workItemId}`,
  )
}

function seedOperationalState(database: BetterSqlite3.Database, context: WorkGraphContext) {
  database.prepare(`
    INSERT INTO wg_v2_runtime_effects
      (organization_id, owner_user_id, id, effect_kind, resource_type, resource_id, idempotency_key, payload_json,
       state, attempt_count, created_at, updated_at, completed_at)
    VALUES (?, ?, 'completed_effect', 'cleanup', 'owner', 'owner', 'completed_effect', '{}', 'completed', 1, 1, 2, 2)
  `).run(context.organizationId, context.ownerUserId)
  database.prepare(`
    INSERT INTO wg_v2_archive_restores
      (organization_id, owner_user_id, operation_id, archive_hash, result_json, created_at)
    VALUES (?, ?, 'old_restore', 'archive_hash', '{}', 1)
  `).run(context.organizationId, context.ownerUserId)
  database.prepare(`
    INSERT INTO wg_v2_migration_intake
      (organization_id, owner_user_id, id, legacy_table, legacy_record_id, intake_kind, reason, raw_reference_json, created_at, updated_at)
    VALUES (?, ?, 'migration_review', 'legacy_work', 'legacy_1', 'work_mapping_review', 'Review', '{}', 1, 1)
  `).run(context.organizationId, context.ownerUserId)
}

function countOwnerRecords(database: BetterSqlite3.Database, context: WorkGraphContext) {
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wg_v2_%' ORDER BY name
  `).all() as Array<{ name: string }>).filter((table) =>
    (database.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>)
      .some((column) => column.name === "owner_user_id"))
  return tables.reduce((count, table) => count + (database.prepare(`
    SELECT COUNT(*) AS count FROM ${table.name} WHERE owner_user_id = ?
  `).get(context.ownerUserId) as { count: number }).count, 0)
}

function workspaceExecution(
  cleanup: WorkspaceExecutionPort["cleanup"],
): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async () => { throw new Error("unused") },
    launch: async () => { throw new Error("unused") },
    cancel: async () => { throw new Error("unused") },
    result: async () => { throw new Error("unused") },
    cleanup,
  }
}

function autonomousExecution(launched: () => void): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({
      id: "autonomous_envelope" as never,
      streamId: input.streamId,
      environment: input.environment,
      repository: input.repository,
      workspaceId: "/tmp/autonomous",
    }),
    launch: async (_context, input) => {
      launched()
      return { sessionId: `session_${input.runId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph-owner-deletion" }
    },
    cancel: async () => undefined,
    result: async () => ({ state: "running" }),
    cleanup: async () => undefined,
  }
}

const executionProfile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}

function branded<Type>(value: string) {
  return value as Type
}

function owner(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: branded<OwnerUserID>(ownerUserId),
    actor: { type: "user", id: branded(ownerUserId) },
    requestId: branded(`request_${ownerUserId}`),
    access: { mode: "owner" },
  }
}

async function expectDeletionReason(promise: Promise<unknown>, reason: string) {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error && "reason" in error && error.reason === reason) return
    throw error
  }
  throw new Error(`Expected ${reason}`)
}
