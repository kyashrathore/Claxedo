import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import type { CompletionContract, OperationID, WorkGraphContext } from "../src/contracts"
import type { WorkspaceExecutionPort } from "../src/ports"
import { createSqliteWorkGraphService, renewSqliteAttemptLease } from "../src/adapters/sqlite/store"

const databases: BetterSqlite3.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("WorkGraph execution fencing and durable runtime effects", () => {
  it.each([
    ["autonomous", 2],
    ["supervised", 1],
  ] as const)(
    "persists %s Stream execution and recovers only its allowed ready batches",
    async (executionMode, expectedAttempts) => {
      const launches: string[] = []
      const executionRuntime = runtime({
        launch: async (_context, input) => {
          launches.push(input.attemptId)
          return { sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
        },
      })
      const fixture = setup(executionRuntime)
      const { streamId, blockerId, dependentId } = await createDependentItems(fixture)

      await expect(command(fixture, "execute_stream", { streamId, executionMode })).resolves.toMatchObject({ ok: true })
      expect(
        fixture.database
          .prepare("SELECT execution_mode, execution_state FROM wg_v2_streams WHERE id = ?")
          .get(streamId),
      ).toEqual({
        execution_mode: executionMode,
        execution_state: executionMode === "autonomous" ? "active" : "stopped",
      })
      expect(
        fixture.database.prepare("SELECT execution_mode FROM wg_v2_attempts WHERE work_item_id = ?").get(blockerId),
      ).toEqual({ execution_mode: executionMode })

      fixture.database
        .prepare("UPDATE wg_v2_attempts SET lifecycle = 'result', finished_at = 2 WHERE work_item_id = ?")
        .run(blockerId)
      fixture.database.prepare("DELETE FROM wg_v2_leases WHERE resource_id = ?").run(blockerId)
      fixture.database
        .prepare("UPDATE wg_v2_work_items SET lifecycle = 'completed', completed_at = 2 WHERE id = ?")
        .run(blockerId)

      createSqliteWorkGraphService({
        database: fixture.database,
        executionCapabilities: testExecutionCapabilities,
        execution: executionRuntime,
        clock: { now: () => 3 },
        ids: { next: (kind) => `${kind}_recovered` },
      })
      await expect
        .poll(
          () =>
            (fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts").get() as { count: number }).count,
        )
        .toBe(expectedAttempts)
      expect(
        (
          fixture.database
            .prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts WHERE work_item_id = ?")
            .get(dependentId) as { count: number }
        ).count,
      ).toBe(executionMode === "autonomous" ? 1 : 0)
      expect(launches).toHaveLength(expectedAttempts)
    },
  )

  it("continues an autonomous Stream after semantic completion makes a dependent Task ready", async () => {
    const fixture = setup(runtime())
    const { streamId, blockerId, dependentId } = await createDependentItems(fixture)
    const execution = await command(fixture, "execute_stream", { streamId, executionMode: "autonomous" })
    const attemptId = resultId(execution, "attemptIds")
    await fixture.attemptResults.recordResult(owner(), {
      attemptId: attemptId as never,
      workItemId: blockerId as never,
      leaseEpoch: 1,
      state: "result",
      summary: "Implemented",
      artifacts: ["commit:abc"],
    })
    await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: blockerId },
      requirementId: "proof",
      evidence: { kind: "test_result", summary: "Tests pass", passed: true, command: "bun test" },
    })
    await expect
      .poll(
        () =>
          (
            fixture.database
              .prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts WHERE work_item_id = ?")
              .get(dependentId) as { count: number }
          ).count,
      )
      .toBe(1)
  })

  it("launches a durable admitted autonomous Attempt after process restart", async () => {
    const launches: string[] = []
    const executionRuntime = runtime({
      launch: async (_context, input) => {
        launches.push(input.attemptId)
        return { sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
      },
    })
    const fixture = setup(executionRuntime)
    const itemId = await createItem(fixture)
    const streamId = streamFor(fixture, itemId)
    const executed = await command(fixture, "execute_work_item", { workItemId: itemId, executionMode: "autonomous" })
    const attemptId = resultId(executed, "attemptId")
    fixture.database
      .prepare(
        `
      UPDATE wg_v2_attempts SET lifecycle = 'admitted', session_id = NULL, started_at = NULL WHERE id = ?
    `,
      )
      .run(attemptId)

    createSqliteWorkGraphService({
      database: fixture.database,
      executionCapabilities: testExecutionCapabilities,
      execution: executionRuntime,
      clock: { now: () => 2_000 },
      ids: { next: (kind) => `${kind}_recovered` },
    })

    await expect
      .poll(
        () =>
          (
            fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId) as {
              lifecycle: string
            }
          ).lifecycle,
      )
      .toBe("running")
    expect(launches).toEqual([attemptId, attemptId])
    expect(fixture.database.prepare("SELECT execution_state FROM wg_v2_streams WHERE id = ?").get(streamId)).toEqual({
      execution_state: "active",
    })
  })

  it("atomically admits only one concurrent Attempt for a Work Item", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const results = await Promise.all([
      command(fixture, "execute_work_item", { workItemId: item }),
      command(fixture, "execute_work_item", { workItemId: item }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: "blocked" } })
    expect(
      (fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts").get() as { count: number }).count,
    ).toBe(1)
  })

  it("returns the concrete admission failure when a ready Stream batch cannot launch", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "Incomplete execution",
      execution: { ...execution, agent: undefined },
    })
    const streamId = resultId(stream, "streamId")
    await command(fixture, "create_work_item", {
      streamId,
      title: "Ready but not executable",
      completionContract: contract,
    })

    await expect(command(fixture, "execute_stream", { streamId, executionMode: "autonomous" })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_error", message: "Incomplete execution profile: agent" },
    })
  })

  it("lets a durable receipt win before cleanup and lets an atomic cleanup reservation block a later receipt", async () => {
    const cleanupCalls: string[] = []
    let releaseCleanup = () => {}
    let cleanupStarted = () => {}
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const fixture = setup(
      runtime({
        cleanup: async () => {
          cleanupCalls.push("cleanup")
          cleanupStarted()
          await blocked
        },
      }),
    )
    const first = await createItem(fixture)
    const firstStream = streamFor(fixture, first)
    await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: first },
      evidence: { kind: "integration", effect: "commit", summary: "Commit exists", reference: "abc" },
    })
    const receiptWins = await command(fixture, "delete_stream", {
      streamId: firstStream,
      expectedVersion: 1,
      reason: "Discard",
    })
    expect(receiptWins).toMatchObject({ ok: false, error: { code: "close_required" } })
    expect(cleanupCalls).toEqual([])

    const second = await createItem(fixture)
    const secondStream = streamFor(fixture, second)
    await command(fixture, "execute_work_item", { workItemId: second })
    const deleting = command(fixture, "delete_stream", {
      streamId: secondStream,
      expectedVersion: 1,
      reason: "Discard",
    })
    await started
    const lateReceipt = await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: second },
      evidence: { kind: "integration", effect: "commit", summary: "Too late", reference: "def" },
    })
    expect(lateReceipt).toMatchObject({ ok: false, error: { code: "blocked" } })
    releaseCleanup()
    await expect(deleting).resolves.toMatchObject({ ok: true })
  })

  it("does not admit autonomous work after Stream deletion reserves cleanup", async () => {
    let releaseCleanup = () => {}
    let cleanupStarted = () => {}
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const launches: string[] = []
    const fixture = setup(
      runtime({
        cleanup: async () => {
          cleanupStarted()
          await blocked
        },
        launch: async (_context, input) => {
          launches.push(input.attemptId)
          return { sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
        },
      }),
    )
    const itemId = await createItem(fixture)
    const streamId = streamFor(fixture, itemId)
    fixture.database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_mode = 'autonomous', execution_state = 'active', envelope_identity_json = ?
      WHERE id = ?
    `,
      )
      .run(JSON.stringify({ id: "envelope_1", workspaceId: "/tmp/worktree" }), streamId)

    const deleting = command(fixture, "delete_stream", { streamId, expectedVersion: 1, reason: "Discard" })
    await started
    await command(fixture, "create_stream", { title: "Trigger autonomous reconciliation" })

    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts WHERE work_item_id = ?").get(itemId),
    ).toEqual({ count: 0 })
    expect(launches).toEqual([])
    releaseCleanup()
    await expect(deleting).resolves.toMatchObject({ ok: true })
  })

  it("cancels admission racing with provisioning without launching a ghost Session", async () => {
    let releaseProvision = () => {}
    let provisionStarted = () => {}
    const started = new Promise<void>((resolve) => {
      provisionStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseProvision = resolve
    })
    const launches: string[] = []
    const cleanups: string[] = []
    const fixture = setup(
      runtime({
        provisionOrAdopt: async (_context, input) => {
          provisionStarted()
          await blocked
          return {
            id: "envelope_1" as never,
            streamId: input.streamId,
            environment: input.environment,
            repository: input.repository,
            workspaceId: "/tmp/worktree",
          }
        },
        launch: async (_context, input) => {
          launches.push(input.attemptId)
          return { sessionId: "session_1" as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
        },
        cleanup: async () => {
          cleanups.push("cleanup")
        },
      }),
    )
    const item = await createItem(fixture)
    const executing = command(fixture, "execute_work_item", { workItemId: item })
    await started
    const attempt = fixture.database
      .prepare("SELECT id, row_version FROM wg_v2_attempts WHERE work_item_id = ?")
      .get(item) as { id: string; row_version: number }
    await expect(
      command(fixture, "cancel_attempt", {
        attemptId: attempt.id,
        expectedVersion: attempt.row_version,
        reason: "Stop",
      }),
    ).resolves.toMatchObject({ ok: true })
    releaseProvision()
    await expect(executing).resolves.toMatchObject({ ok: true })
    expect(launches).toEqual([])
    expect(cleanups).toEqual([])
  })

  it("keeps a failed cancellation effect durable and retryable before terminalizing the Attempt", async () => {
    let failures = 1
    const fixture = setup(
      runtime({
        cancel: async () => {
          if (failures-- > 0) throw new Error("runtime unavailable")
        },
      }),
    )
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    const attemptId = resultId(admitted, "attemptId")
    const attempt = fixture.database.prepare("SELECT row_version FROM wg_v2_attempts WHERE id = ?").get(attemptId) as {
      row_version: number
    }
    const operationId = `operation_${crypto.randomUUID()}` as OperationID
    const request = {
      operationId,
      command: { version: 1, type: "cancel_attempt", attemptId, expectedVersion: attempt.row_version, reason: "Stop" },
    } as never
    await expect(fixture.service.execute(owner(), request)).resolves.toMatchObject({
      ok: false,
      error: { retryable: true },
    })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({
      lifecycle: "running",
    })
    expect(
      fixture.database
        .prepare("SELECT state, attempt_count FROM wg_v2_runtime_effects WHERE idempotency_key = ?")
        .get(operationId),
    ).toEqual({ state: "pending", attempt_count: 1 })
    await expect(fixture.service.execute(owner(), request)).resolves.toMatchObject({ ok: true })
    expect(
      fixture.database
        .prepare("SELECT state, attempt_count FROM wg_v2_runtime_effects WHERE idempotency_key = ?")
        .get(operationId),
    ).toEqual({ state: "completed", attempt_count: 2 })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({
      lifecycle: "cancelled",
    })
  })

  it("durably retries cancellation and legacy child cleanup after placement lease loss", async () => {
    let fixture!: ReturnType<typeof setup>
    let cancelFailures = 1
    const cancellations: string[] = []
    const cleanups: Array<readonly string[] | undefined> = []
    const executionRuntime = runtime({
      launch: async (_context, input) => {
        expect(
          renewSqliteAttemptLease(fixture.database, owner(), {
            attemptId: input.attemptId,
            expectedLeaseEpoch: 1,
            occurredAt: 1_000_000,
            durationMs: 300_000,
          }),
        ).toMatchObject({ leaseEpoch: 2, recovered: true })
        return { sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
      },
      cancel: async (_context, input) => {
        cancellations.push(input.sessionId)
        if (cancelFailures-- > 0) throw new Error("session cancellation unavailable")
      },
      cleanup: async (_context, input) => {
        cleanups.push(input.childIsolationIds)
      },
    })
    fixture = setup(executionRuntime)
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    const attemptId = resultId(admitted, "attemptId")

    expect(
      fixture.database.prepare("SELECT lifecycle, lease_epoch FROM wg_v2_attempts WHERE id = ?").get(attemptId),
    ).toEqual({ lifecycle: "placing", lease_epoch: 2 })
    expect(
      fixture.database
        .prepare(
          `
      SELECT state, attempt_count, last_error FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `,
        )
        .get(attemptId),
    ).toEqual({
      state: "pending",
      attempt_count: 1,
      last_error: expect.stringContaining("Attempt lease ownership was lost after launch"),
    })
    expect(
      (
        fixture.database
          .prepare("SELECT last_error FROM wg_v2_runtime_effects WHERE resource_id = ?")
          .get(attemptId) as { last_error: string }
      ).last_error,
    ).toContain("session cancellation unavailable")
    expect(cleanups).toEqual([])

    const persisted = fixture.database.prepare(`
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `).get(attemptId) as { payload_json: string }
    fixture.database.prepare(`
      UPDATE wg_v2_runtime_effects SET payload_json = ?
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `).run(JSON.stringify({ ...JSON.parse(persisted.payload_json), childIsolationId: "child_legacy" }), attemptId)

    createSqliteWorkGraphService({
      database: fixture.database,
      executionCapabilities: testExecutionCapabilities,
      execution: executionRuntime,
      clock: { now: () => 2_000_000 },
      ids: { next: (kind) => `${kind}_recovered` },
    })
    await expect
      .poll(() =>
        fixture.database
          .prepare(
            `
      SELECT state, attempt_count, last_error FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `,
          )
          .get(attemptId),
      )
      .toEqual({ state: "completed", attempt_count: 2, last_error: null })
    expect(
      fixture.database.prepare("SELECT lifecycle, attention_reason FROM wg_v2_attempts WHERE id = ?").get(attemptId),
    ).toEqual({ lifecycle: "attention", attention_reason: expect.stringContaining("session cancellation unavailable") })
    const compensation = fixture.database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `,
      )
      .get(attemptId) as { payload_json: string }
    expect(JSON.parse(compensation.payload_json)).toMatchObject({
      reason: "Attempt lease ownership was lost after launch",
      failureHistory: [expect.stringContaining("session cancellation unavailable")],
    })
    expect(cancellations).toEqual([`session_${attemptId}`, `session_${attemptId}`])
    expect(cleanups).toEqual([["child_legacy"]])
  })

  it("retains the shared Stream workspace when Session admission fails", async () => {
    const cleanups: string[] = []
    const failingRuntime = runtime({
      launch: async () => {
        throw new Error("Session admission rejected")
      },
      cleanup: async (_context, input) => {
        cleanups.push(input.envelopeId)
      },
    })
    const fixture = setup(failingRuntime)
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    const attemptId = resultId(admitted, "attemptId")

    expect(
      fixture.database.prepare("SELECT lifecycle, attention_reason FROM wg_v2_attempts WHERE id = ?").get(attemptId),
    ).toEqual({
      lifecycle: "attention",
      attention_reason: expect.stringContaining("Session admission rejected"),
    })
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_attempt_placement' AND resource_id = ?
    `).get(attemptId)).toEqual({ count: 0 })

    expect(cleanups).toEqual([])
  })

  it("persists one idempotent terminal result/change, sets result_ready, and leaves semantic completion pending", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId") as never
    await fixture.attemptResults.recordResult(owner(), {
      attemptId,
      workItemId: item as never,
      leaseEpoch: 1,
      state: "result",
      summary: "Done",
      artifacts: ["commit:abc"],
    })
    const cursor = (
      fixture.database
        .prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE owner_user_id = ?")
        .get(owner().ownerUserId) as { next_cursor: number }
    ).next_cursor
    await fixture.attemptResults.recordResult(owner(), {
      attemptId,
      workItemId: item as never,
      leaseEpoch: 1,
      state: "result",
      summary: "Done",
      artifacts: ["commit:abc"],
    })
    expect(
      (
        fixture.database
          .prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE owner_user_id = ?")
          .get(owner().ownerUserId) as { next_cursor: number }
      ).next_cursor,
    ).toBe(cursor)
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item)).toEqual({
      lifecycle: "result_ready",
    })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({
      lifecycle: "result",
    })
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ count: 0 })
  })

  it("rejects missing or blank semantic output instead of fabricating a successful result", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId") as never
    const identity = { attemptId, workItemId: item as never, leaseEpoch: 1, state: "result" as const }

    await expect(
      fixture.attemptResults.recordResult(owner(), { ...identity, summary: "   ", artifacts: [] }),
    ).rejects.toThrow("summary must be non-empty")
    await expect(
      fixture.attemptResults.recordResult(owner(), { ...identity, summary: "Done" } as never),
    ).rejects.toThrow("artifacts must be an explicit array")
    expect(
      fixture.database
        .prepare("SELECT lifecycle, terminal_result_json FROM wg_v2_attempts WHERE id = ?")
        .get(attemptId),
    ).toEqual({ lifecycle: "running", terminal_result_json: null })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item)).toEqual({
      lifecycle: "active",
    })
  })

  it("recovers an expired same-Attempt lease with a fenced epoch and close terminalizes active Attempts", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId")
    expect(
      renewSqliteAttemptLease(fixture.database, owner(), {
        attemptId: attemptId as never,
        expectedLeaseEpoch: 1,
        occurredAt: 1_000_000,
        durationMs: 300_000,
      }),
    ).toEqual({ leaseEpoch: 2, expiresAt: 1_300_000, recovered: true })
    expect(fixture.database.prepare("SELECT epoch FROM wg_v2_leases WHERE resource_id = ?").get(item)).toEqual({
      epoch: 2,
    })
    await expect(
      fixture.attemptResults.recordResult(owner(), {
        attemptId: attemptId as never,
        workItemId: item as never,
        leaseEpoch: 1,
        state: "result",
        summary: "Stale worker",
        artifacts: [],
      }),
    ).resolves.toBe(false)
    expect(
      fixture.database.prepare("SELECT lifecycle, lease_epoch FROM wg_v2_attempts WHERE id = ?").get(attemptId),
    ).toEqual({ lifecycle: "running", lease_epoch: 2 })
    const streamId = streamFor(fixture, item)
    await expect(
      command(fixture, "close_stream", { streamId, expectedVersion: 1, reason: "Stopping" }),
    ).resolves.toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({
      lifecycle: "cancelled",
    })
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ count: 0 })
  })
})

function setup(execution: WorkspaceExecutionPort) {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let id = 0
  const adapter = createSqliteWorkGraphService({
    database,
    executionCapabilities: testExecutionCapabilities,
    execution,
    clock: { now: () => 1_000 + id },
    ids: { next: (kind) => `${kind}_${++id}` },
  })
  return { database, ...adapter }
}

async function createItem(fixture: ReturnType<typeof setup>) {
  const stream = await command(fixture, "create_stream", { title: `Stream ${crypto.randomUUID()}`, execution })
  if (!stream.ok) throw new Error("Expected Stream")
  const item = await command(fixture, "create_work_item", {
    streamId: resultId(stream, "streamId"),
    title: "Implement",
    completionContract: contract,
  })
  if (!item.ok) throw new Error("Expected Work Item")
  return resultId(item, "workItemId")
}

async function createDependentItems(fixture: ReturnType<typeof setup>) {
  const stream = await command(fixture, "create_stream", { title: `Stream ${crypto.randomUUID()}`, execution })
  if (!stream.ok) throw new Error("Expected Stream")
  const streamId = resultId(stream, "streamId")
  const blocker = await command(fixture, "create_work_item", {
    streamId,
    title: "Blocker",
    completionContract: contract,
  })
  if (!blocker.ok) throw new Error("Expected blocker")
  const blockerId = resultId(blocker, "workItemId")
  const dependent = await command(fixture, "create_work_item", {
    streamId,
    title: "Dependent",
    dependencyIds: [blockerId],
    completionContract: contract,
  })
  if (!dependent.ok) throw new Error("Expected dependent")
  return { streamId, blockerId, dependentId: resultId(dependent, "workItemId") }
}

function streamFor(fixture: ReturnType<typeof setup>, item: string) {
  return (
    fixture.database.prepare("SELECT stream_id FROM wg_v2_work_items WHERE id = ?").get(item) as { stream_id: string }
  ).stream_id
}

function command(fixture: ReturnType<typeof setup>, type: string, value: Record<string, unknown>) {
  return fixture.service.execute(owner(), {
    operationId: `operation_${crypto.randomUUID()}` as OperationID,
    command: { version: 1, type, ...value },
  } as never)
}

function runtime(overrides: Partial<WorkspaceExecutionPort> = {}): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({
      id: "envelope_1" as never,
      streamId: input.streamId,
      environment: input.environment,
      repository: input.repository,
      workspaceId: "/tmp/worktree",
    }),
    launch: async (_context, input) => ({
      sessionId: `session_${input.attemptId}` as never,
      envelopeId: input.envelopeId,
      projectId: "/tmp/workgraph",
    }),
    cancel: async () => undefined,
    result: async () => ({ state: "running" }),
    cleanup: async () => undefined,
    ...overrides,
  }
}

const execution = {
  environment: { kind: "local_worktree" as const, directory: "/repo" },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}
const contract = {
  version: 1,
  mode: "all",
  requirements: [{ id: "proof" as never, kind: "test", description: "Tests pass" }],
} satisfies CompletionContract
function owner(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: "owner" as never,
    actor: { type: "agent", id: "agent" as never },
    requestId: "request" as never,
    access: { mode: "owner" },
  }
}

function resultId(result: Awaited<ReturnType<typeof command>>, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value))
    throw new Error(`Expected ${key}`)
  const value = result.value[key]
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  throw new Error(`Expected ${key}`)
}
import { testExecutionCapabilities } from "./test-execution-capabilities"
