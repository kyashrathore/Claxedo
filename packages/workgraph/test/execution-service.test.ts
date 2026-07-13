import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { recordSemanticAttemptResult } from "../src/application/completion-service"
import { cleanupStreamBeforeRemoval } from "../src/application/stream-lifecycle-service"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"
import type { AttemptID, CompletionContract, OperationID, StreamID, WorkGraphContext, WorkItemID } from "../src/contracts"
import type { WorkspaceExecutionPort } from "../src/ports"

const databases: BetterSqlite3.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("durable local execution", () => {
  it("atomically admits and leases an immutable Attempt before placing it in the Stream envelope", async () => {
    const calls: string[] = []
    const fixture = setup(runtime(calls))
    const streamId = resultId(await execute(fixture, "create_stream", { title: "Ship", execution }), "streamId")
    const workItemId = resultId(await execute(fixture, "create_work_item", { streamId, title: "Implement", completionContract: contract }), "workItemId")

    const started = await execute(fixture, "execute_work_item", { workItemId, executionMode: "autonomous" })
    expect(started).toMatchObject({ ok: true, value: { workItemId } })
    expect(calls).toEqual(["envelope", "launch"])
    expect(fixture.database.prepare(`
      SELECT attempts.lifecycle, attempts.attempt_number, attempts.session_id, items.lifecycle AS item_lifecycle,
        leases.holder_id, attempts.resolved_execution_profile_json
      FROM wg_v2_attempts attempts
      JOIN wg_v2_work_items items ON items.id = attempts.work_item_id
      JOIN wg_v2_leases leases ON leases.resource_id = attempts.work_item_id
    `).get()).toMatchObject({
      lifecycle: "running",
      attempt_number: 1,
      session_id: "session_1",
      item_lifecycle: "active",
      resolved_execution_profile_json: JSON.stringify(execution),
    })
    expect(await execute(fixture, "execute_work_item", { workItemId, executionMode: "autonomous" })).toMatchObject({ ok: false, error: { code: "blocked" } })
    expect(await execute(fixture, "delete_stream", { streamId, expectedVersion: 0, reason: "Wrong version" })).toMatchObject({ ok: false, error: { code: "version_conflict" } })
    expect(calls).toEqual(["envelope", "launch"])
    expect(await execute(fixture, "delete_stream", { streamId, expectedVersion: 1, reason: "Discard" })).toMatchObject({ ok: true })
    expect(calls).toEqual(["envelope", "launch", "cancel", "cleanup"])
  })

  it("replays an admitted operation without launching a second Session", async () => {
    const calls: string[] = []
    const fixture = setup(runtime(calls))
    const streamId = resultId(await execute(fixture, "create_stream", { title: "Ship", execution }), "streamId")
    const workItemId = resultId(await execute(fixture, "create_work_item", { streamId, title: "Implement", completionContract: contract }), "workItemId")
    const request = { operationId: branded<OperationID>("operation_execute"), command: { version: 1, type: "execute_work_item", workItemId, executionMode: "autonomous" } } as const
    const first = await fixture.service.execute(owner(), request as never)
    const replay = await fixture.service.execute(owner(), request as never)
    expect(replay).toEqual(first)
    expect(calls).toEqual(["envelope", "launch"])
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_attempts").get()).toEqual({ count: 1 })
  })

  it("blocks new admission while paused and retries with a new immutable Attempt number", async () => {
    const fixture = setup(runtime([]))
    const streamId = resultId(await execute(fixture, "create_stream", { title: "Ship", execution }), "streamId")
    const workItemId = resultId(await execute(fixture, "create_work_item", { streamId, title: "Implement", completionContract: contract }), "workItemId")
    await execute(fixture, "set_stream_lifecycle", { streamId, expectedVersion: 1, state: "paused", reason: "Focus" })
    expect(await execute(fixture, "execute_work_item", { workItemId, executionMode: "autonomous" })).toMatchObject({ ok: false, error: { code: "blocked" } })
    await execute(fixture, "set_stream_lifecycle", { streamId, expectedVersion: 2, state: "active", reason: "Resume" })
    await execute(fixture, "execute_work_item", { workItemId, executionMode: "autonomous" })
    fixture.database.prepare("UPDATE wg_v2_attempts SET lifecycle = 'failed', finished_at = 10 WHERE work_item_id = ?").run(workItemId)
    fixture.database.prepare("DELETE FROM wg_v2_leases WHERE resource_id = ?").run(workItemId)
    const version = (fixture.database.prepare("SELECT row_version FROM wg_v2_work_items WHERE id = ?").get(workItemId) as { row_version: number }).row_version
    expect(await execute(fixture, "retry_work_item", { workItemId, expectedVersion: version })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT attempt_number FROM wg_v2_attempts WHERE work_item_id = ? ORDER BY attempt_number").all(workItemId))
      .toEqual([{ attempt_number: 1 }, { attempt_number: 2 }])
  })

  it("records runtime success as result_ready, never semantic completion", async () => {
    const writes: unknown[] = []
    const settled = await recordSemanticAttemptResult(owner(), { attemptId: branded("attempt"), workItemId: branded("item"), leaseEpoch: 1 }, {
      state: "succeeded",
      summary: "Patch produced",
      artifacts: ["diff://1"],
    }, { recordResult: async (_context, input) => { writes.push(input); return true } })
    expect(settled).toEqual({ settled: true, workItemState: "result_ready" })
    expect(writes).toEqual([expect.objectContaining({ state: "result", summary: "Patch produced" })])
  })

  it("does not let a stale placement failure erase a recovered lease epoch", async () => {
    let failProvision: (error: Error) => void = () => undefined
    let placementStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { placementStarted = resolve })
    const fixture = setup({
      ...runtime([]),
      provisionOrAdopt: async () => {
        placementStarted()
        return new Promise((_resolve, reject) => { failProvision = reject })
      },
    })
    const streamId = resultId(await execute(fixture, "create_stream", { title: "Recover", execution }), "streamId")
    const workItemId = resultId(await execute(fixture, "create_work_item", { streamId, title: "Recover safely", completionContract: contract }), "workItemId")
    const admission = execute(fixture, "execute_work_item", { workItemId, executionMode: "autonomous" })
    await started
    const attempt = fixture.database.prepare("SELECT id FROM wg_v2_attempts WHERE work_item_id = ?").get(workItemId) as { id: AttemptID }
    await expect(fixture.attemptRuntime.renewLease(owner(), {
      attemptId: attempt.id,
      expectedLeaseEpoch: 1,
      occurredAt: 1_000_000,
      durationMs: 300_000,
    })).resolves.toEqual({ leaseEpoch: 2, expiresAt: 1_300_000, recovered: true })
    failProvision(new Error("stale provision failure"))
    await expect(admission).resolves.toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle, lease_epoch FROM wg_v2_attempts WHERE id = ?").get(attempt.id))
      .toEqual({ lifecycle: "admitted", lease_epoch: 2 })
    expect(fixture.database.prepare("SELECT holder_id, epoch FROM wg_v2_leases WHERE resource_id = ?").get(workItemId))
      .toEqual({ holder_id: attempt.id, epoch: 2 })
  })

  it("requires cleanup to succeed before destructive removal", async () => {
    const order: string[] = []
    const adapter = runtime(order)
    await cleanupStreamBeforeRemoval(owner(), { streamId: branded("stream"), envelopeId: branded("envelope"), mode: "delete" }, adapter, async () => { order.push("remove") })
    expect(order).toEqual(["cleanup", "remove"])
  })
})

const execution = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["terminal"],
  connectionIds: [],
  isolation: "stream" as const,
  cleanup: "destroy_on_close" as const,
  integration: "pull_request" as const,
}
const contract = { version: 1, mode: "all", requirements: [{ id: branded("proof"), kind: "test", description: "Tests pass" }] } satisfies CompletionContract

function runtime(calls: string[]): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => { calls.push("envelope"); return { id: branded("envelope_1"), streamId: input.streamId, environment: input.environment, repository: input.repository, workspaceId: "/tmp/worktree" } },
    createChildIsolation: async (_context, input) => { calls.push("child"); return { id: branded("child_1"), envelopeId: input.envelopeId, workItemId: input.workItemId, workspaceId: "/tmp/child" } },
    launch: async (_context, input) => { calls.push("launch"); return { sessionId: branded("session_1"), envelopeId: input.envelopeId, childIsolationId: input.childIsolationId } },
    cancel: async () => { calls.push("cancel") },
    result: async () => ({ state: "running" }),
    integrateResult: async (_context, input) => ({ summary: input.result.summary, artifacts: input.result.artifacts }),
    cleanup: async () => { calls.push("cleanup") },
  }
}

function setup(executionPort: WorkspaceExecutionPort) {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let id = 0
  let now = 1_000
  return { database, ...createSqliteWorkGraphService({ database, execution: executionPort, clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` } }) }
}
function execute(fixture: ReturnType<typeof setup>, type: string, command: Record<string, unknown>) {
  return fixture.service.execute(owner(), { operationId: branded<OperationID>(`operation_${crypto.randomUUID()}`), command: { version: 1, type, ...command } } as never)
}
function resultId(result: Awaited<ReturnType<typeof execute>>, key: string) {
  if (!result.ok || typeof result.value !== "object" || !result.value || Array.isArray(result.value)) throw new Error(`Expected ${key}`)
  return result.value[key] as string
}
function branded<Type = string>(value: string) { return value as Type }
function owner(): WorkGraphContext {
  return { ownerUserId: branded("owner"), actor: { type: "agent", id: branded("agent") }, requestId: branded("request"), access: { mode: "owner" } }
}
