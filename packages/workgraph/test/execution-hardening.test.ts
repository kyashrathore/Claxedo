import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import type { CompletionContract, OperationID, WorkGraphContext } from "../src/contracts"
import type { WorkspaceExecutionPort } from "../src/ports"
import { createSqliteWorkGraphService, renewSqliteAttemptLease } from "../src/adapters/sqlite/store"

const databases: BetterSqlite3.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("WorkGraph execution fencing and durable runtime effects", () => {
  it("atomically admits only one concurrent Attempt for a Work Item", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const results = await Promise.all([
      command(fixture, "execute_work_item", { workItemId: item }),
      command(fixture, "execute_work_item", { workItemId: item }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: "blocked" } })
    expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts").get() as { count: number }).count).toBe(1)
  })

  it("lets a durable receipt win before cleanup and lets an atomic cleanup reservation block a later receipt", async () => {
    const cleanupCalls: string[] = []
    let releaseCleanup = () => {}
    let cleanupStarted = () => {}
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const fixture = setup(runtime({ cleanup: async () => { cleanupCalls.push("cleanup"); cleanupStarted(); await blocked } }))
    const first = await createItem(fixture)
    const firstStream = streamFor(fixture, first)
    await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: first },
      evidence: { kind: "integration", effect: "commit", summary: "Commit exists", reference: "abc" },
    })
    const receiptWins = await command(fixture, "delete_stream", { streamId: firstStream, expectedVersion: 1, reason: "Discard" })
    expect(receiptWins).toMatchObject({ ok: false, error: { code: "close_required" } })
    expect(cleanupCalls).toEqual([])

    const second = await createItem(fixture)
    const secondStream = streamFor(fixture, second)
    await command(fixture, "execute_work_item", { workItemId: second })
    const deleting = command(fixture, "delete_stream", { streamId: secondStream, expectedVersion: 1, reason: "Discard" })
    await started
    const lateReceipt = await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: second },
      evidence: { kind: "integration", effect: "commit", summary: "Too late", reference: "def" },
    })
    expect(lateReceipt).toMatchObject({ ok: false, error: { code: "blocked" } })
    releaseCleanup()
    await expect(deleting).resolves.toMatchObject({ ok: true })
  })

  it("cancels admission racing with provisioning without launching a ghost Session", async () => {
    let releaseProvision = () => {}
    let provisionStarted = () => {}
    const started = new Promise<void>((resolve) => { provisionStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseProvision = resolve })
    const launches: string[] = []
    const cleanups: string[] = []
    const fixture = setup(runtime({
      provisionOrAdopt: async (_context, input) => {
        provisionStarted()
        await blocked
        return { id: "envelope_1" as never, streamId: input.streamId, environment: input.environment, repository: input.repository, workspaceId: "/tmp/worktree" }
      },
      launch: async (_context, input) => {
        launches.push(input.attemptId)
        return { sessionId: "session_1" as never, envelopeId: input.envelopeId }
      },
      cleanup: async () => { cleanups.push("cleanup") },
    }))
    const item = await createItem(fixture)
    const executing = command(fixture, "execute_work_item", { workItemId: item })
    await started
    const attempt = fixture.database.prepare("SELECT id, row_version FROM wg_v2_attempts WHERE work_item_id = ?").get(item) as { id: string; row_version: number }
    await expect(command(fixture, "cancel_attempt", { attemptId: attempt.id, expectedVersion: attempt.row_version, reason: "Stop" })).resolves.toMatchObject({ ok: true })
    releaseProvision()
    await expect(executing).resolves.toMatchObject({ ok: true })
    expect(launches).toEqual([])
    expect(cleanups).toEqual(["cleanup"])
  })

  it("keeps a failed cancellation effect durable and retryable before terminalizing the Attempt", async () => {
    let failures = 1
    const fixture = setup(runtime({ cancel: async () => {
      if (failures-- > 0) throw new Error("runtime unavailable")
    } }))
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    const attemptId = resultId(admitted, "attemptId")
    const attempt = fixture.database.prepare("SELECT row_version FROM wg_v2_attempts WHERE id = ?").get(attemptId) as { row_version: number }
    const operationId = `operation_${crypto.randomUUID()}` as OperationID
    const request = { operationId, command: { version: 1, type: "cancel_attempt", attemptId, expectedVersion: attempt.row_version, reason: "Stop" } } as never
    await expect(fixture.service.execute(owner(), request)).resolves.toMatchObject({ ok: false, error: { retryable: true } })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({ lifecycle: "running" })
    expect(fixture.database.prepare("SELECT state, attempt_count FROM wg_v2_runtime_effects WHERE idempotency_key = ?").get(operationId)).toEqual({ state: "pending", attempt_count: 1 })
    await expect(fixture.service.execute(owner(), request)).resolves.toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT state, attempt_count FROM wg_v2_runtime_effects WHERE idempotency_key = ?").get(operationId)).toEqual({ state: "completed", attempt_count: 2 })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({ lifecycle: "cancelled" })
  })

  it("persists one idempotent terminal result/change, sets result_ready, and leaves semantic completion pending", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId") as never
    await fixture.attemptResults.recordResult(owner(), { attemptId, workItemId: item as never, leaseEpoch: 1, state: "result", summary: "Done", artifacts: ["commit:abc"] })
    const cursor = (fixture.database.prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE owner_user_id = ?").get(owner().ownerUserId) as { next_cursor: number }).next_cursor
    await fixture.attemptResults.recordResult(owner(), { attemptId, workItemId: item as never, leaseEpoch: 1, state: "result", summary: "Done", artifacts: ["commit:abc"] })
    expect((fixture.database.prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE owner_user_id = ?").get(owner().ownerUserId) as { next_cursor: number }).next_cursor).toBe(cursor)
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item)).toEqual({ lifecycle: "result_ready" })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({ lifecycle: "result" })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item)).toEqual({ count: 0 })
  })

  it("rejects missing or blank semantic output instead of fabricating a successful result", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId") as never
    const identity = { attemptId, workItemId: item as never, leaseEpoch: 1, state: "result" as const }

    await expect(fixture.attemptResults.recordResult(owner(), { ...identity, summary: "   ", artifacts: [] }))
      .rejects.toThrow("summary must be non-empty")
    await expect(fixture.attemptResults.recordResult(owner(), { ...identity, summary: "Done" } as never))
      .rejects.toThrow("artifacts must be an explicit array")
    expect(fixture.database.prepare("SELECT lifecycle, terminal_result_json FROM wg_v2_attempts WHERE id = ?").get(attemptId))
      .toEqual({ lifecycle: "running", terminal_result_json: null })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item))
      .toEqual({ lifecycle: "active" })
  })

  it("recovers an expired same-Attempt lease with a fenced epoch and close terminalizes active Attempts", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const admitted = await command(fixture, "execute_work_item", { workItemId: item })
    if (!admitted.ok) throw new Error("Expected admission")
    const attemptId = resultId(admitted, "attemptId")
    expect(renewSqliteAttemptLease(fixture.database, owner(), {
      attemptId: attemptId as never,
      expectedLeaseEpoch: 1,
      occurredAt: 1_000_000,
      durationMs: 300_000,
    })).toEqual({ leaseEpoch: 2, expiresAt: 1_300_000, recovered: true })
    expect(fixture.database.prepare("SELECT epoch FROM wg_v2_leases WHERE resource_id = ?").get(item)).toEqual({ epoch: 2 })
    await expect(fixture.attemptResults.recordResult(owner(), {
      attemptId: attemptId as never,
      workItemId: item as never,
      leaseEpoch: 1,
      state: "result",
      summary: "Stale worker",
      artifacts: [],
    })).resolves.toBe(false)
    expect(fixture.database.prepare("SELECT lifecycle, lease_epoch FROM wg_v2_attempts WHERE id = ?").get(attemptId))
      .toEqual({ lifecycle: "running", lease_epoch: 2 })
    const streamId = streamFor(fixture, item)
    await expect(command(fixture, "close_stream", { streamId, expectedVersion: 1, reason: "Stopping" })).resolves.toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = ?").get(attemptId)).toEqual({ lifecycle: "cancelled" })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item)).toEqual({ count: 0 })
  })
})

function setup(execution: WorkspaceExecutionPort) {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let id = 0
  const adapter = createSqliteWorkGraphService({
    database,
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

function streamFor(fixture: ReturnType<typeof setup>, item: string) {
  return (fixture.database.prepare("SELECT stream_id FROM wg_v2_work_items WHERE id = ?").get(item) as { stream_id: string }).stream_id
}

function command(fixture: ReturnType<typeof setup>, type: string, value: Record<string, unknown>) {
  return fixture.service.execute(owner(), {
    operationId: `operation_${crypto.randomUUID()}` as OperationID,
    command: { version: 1, type, ...value },
  } as never)
}

function runtime(overrides: Partial<WorkspaceExecutionPort> = {}): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({ id: "envelope_1" as never, streamId: input.streamId, environment: input.environment, repository: input.repository, workspaceId: "/tmp/worktree" }),
    createChildIsolation: async () => { throw new Error("unused") },
    launch: async (_context, input) => ({ sessionId: `session_${input.attemptId}` as never, envelopeId: input.envelopeId }),
    cancel: async () => undefined,
    result: async () => ({ state: "running" }),
    integrateResult: async (_context, input) => ({ summary: input.result.summary, artifacts: input.result.artifacts }),
    cleanup: async () => undefined,
    ...overrides,
  }
}

const execution = {
  environment: { kind: "local_worktree" as const }, repository: { baseRevision: "HEAD" }, harness: "claxedo-v2", agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" }, effort: "high", tools: [], connectionIds: [], isolation: "stream" as const,
  cleanup: "destroy_on_close" as const, integration: "manual" as const,
}
const contract = { version: 1, mode: "all", requirements: [{ id: "proof" as never, kind: "test", description: "Tests pass" }] } satisfies CompletionContract
function owner(): WorkGraphContext {
  return { ownerUserId: "owner" as never, actor: { type: "agent", id: "agent" as never }, requestId: "request" as never, access: { mode: "owner" } }
}

function resultId(result: Awaited<ReturnType<typeof command>>, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Expected ${key}`)
  const value = result.value[key]
  if (typeof value !== "string") throw new Error(`Expected ${key}`)
  return value
}
