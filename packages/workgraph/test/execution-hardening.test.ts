import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { masterSessionId, type CompletionContract, type OperationID, type WorkGraphContext } from "../src/contracts"
import type { WorkspaceExecutionPort } from "../src/ports"
import {
  createSqliteWorkGraphService,
  recordSqliteWorkGraphLlmUsage,
  renewSqliteRunLease,
} from "../src/adapters/sqlite/store"

const databases: BetterSqlite3.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("WorkGraph execution fencing and durable runtime effects", () => {
  it("continues an active Stream after semantic completion makes a dependent Task ready", async () => {
    const fixture = setup(runtime())
    const { blockerId, dependentId } = await createDependentItems(fixture)
    // The blocker is auto-admitted on creation; the dependent waits for it.
    const runId = runIdFor(fixture, blockerId)
    await fixture.runResults.recordResult(owner(), {
      runId: runId as never,
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
              .prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?")
              .get(dependentId) as { count: number }
          ).count,
      )
      .toBe(1)
  })

  it("fills isolated execution width and admits the next Task when a seat settles", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "Parallel worktrees",
      execution: {
        ...execution,
        environment: { ...execution.environment, placement: "worktree" },
        maxParallel: 2,
      },
    })
    const streamId = resultId(stream, "streamId")
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 1,
      state: "paused",
      reason: "Stage Tasks",
    })
    const itemIds = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        command(fixture, "create_work_item", {
          streamId,
          title: `Parallel Task ${index + 1}`,
          completionContract: contract,
        }).then((result) => resultId(result, "workItemId")),
      ),
    )
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 2,
      state: "active",
      reason: "Run",
    })
    await fixture.drainReadyStreams()

    expect(
      fixture.database
        .prepare("SELECT lifecycle, COUNT(*) AS count FROM wg_v2_runs WHERE stream_id = ? GROUP BY lifecycle")
        .all(streamId),
    ).toEqual([{ lifecycle: "running", count: 2 }])
    expect(
      fixture.database
        .prepare(
          `
        SELECT leases.resource_type, COUNT(*) AS count
        FROM wg_v2_leases leases
        JOIN wg_v2_runs runs ON runs.id = leases.holder_id
        WHERE runs.stream_id = ?
        GROUP BY leases.resource_type
      `,
        )
        .all(streamId),
    ).toEqual([{ resource_type: "work_item", count: 2 }])

    const firstRun = fixture.database
      .prepare("SELECT id, work_item_id, generation FROM wg_v2_runs WHERE stream_id = ? ORDER BY created_at, id LIMIT 1")
      .get(streamId) as { id: string; work_item_id: string; generation: number }
    await fixture.runResults.recordResult(owner(), {
      runId: firstRun.id as never,
      workItemId: firstRun.work_item_id as never,
      leaseEpoch: firstRun.generation,
      state: "result",
      summary: "Seat released",
      artifacts: [],
    })
    await fixture.drainReadyStreams()

    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE stream_id = ? AND lifecycle = 'running'")
        .get(streamId),
    ).toEqual({ count: 2 })
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items WHERE id IN (?, ?, ?, ?, ?) AND lifecycle = 'pending'")
        .get(...itemIds),
    ).toEqual({ count: 2 })
  })

  it("releases both shared leases on cancellation without leaking the Stream fence", async () => {
    const fixture = setup(runtime())
    const streamId = resultId(await command(fixture, "create_stream", {
      title: "Shared lease cleanup",
      execution,
    }), "streamId")
    const firstId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "First",
      completionContract: contract,
    }), "workItemId")
    const secondId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "Second",
      completionContract: contract,
    }), "workItemId")
    const firstRun = fixture.database
      .prepare("SELECT id, row_version FROM wg_v2_runs WHERE work_item_id = ?")
      .get(firstId) as { id: string; row_version: number }

    await command(fixture, "cancel_run", {
      runId: firstRun.id,
      expectedVersion: firstRun.row_version,
      reason: "Replace the Run",
    })
    await fixture.drainReadyStreams()
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM wg_v2_leases WHERE holder_id = ?",
    ).get(firstRun.id)).toEqual({ count: 0 })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases").get()).toEqual({ count: 0 })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(secondId))
      .toEqual({ lifecycle: "pending" })
  })

  it("launches with the generation parameters from the assigned named profile", async () => {
    const launched: Array<{ agent: string; effort: string; tools: readonly string[] }> = []
    const fixture = setup(runtime({
      launch: async (_context, input) => {
        launched.push(input.profile)
        return {
          sessionId: `session_${input.runId}` as never,
          envelopeId: input.envelopeId,
          projectId: "/tmp/workgraph",
        }
      },
    }))
    await expect(command(fixture, "create_stream", {
      title: "Unknown named execution",
      execution: {
        ...execution,
        assignments: { execution: "missing" },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: "unknown_agent_profile" } })
    const streamId = resultId(await command(fixture, "create_stream", {
      title: "Named execution",
      execution: {
        ...execution,
        agents: [{
          name: "focused",
          brief: "Implement the bounded task.",
          generation: {
            harness: "claxedo-v2",
            agent: "build",
            model: { providerId: "openai", modelId: "gpt-5.1" },
            effort: "maximum",
            tools: ["read"],
            connectionIds: [],
          },
          memoryRef: "memory://focused",
        }],
        assignments: { execution: "focused" },
      },
    }), "streamId")
    await command(fixture, "create_work_item", {
      streamId,
      title: "Use the focused seat",
      completionContract: contract,
    })

    await expect.poll(() => launched).toEqual([
      expect.objectContaining({
        agent: "build",
        effort: "maximum",
        tools: ["read"],
      }),
    ])
  })

  it("holds parent completion for subtasks and forbids a subtask seat from creating work", async () => {
    const fixture = setup(runtime())
    const streamId = resultId(await command(fixture, "create_stream", {
      title: "Subtask roll-up",
      execution,
    }), "streamId")
    const parentId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "Parent",
      completionContract: contract,
    }), "workItemId")
    await expect(command(fixture, "create_work_item", {
      streamId,
      parentTaskId: parentId,
      title: "Invalid dependent child",
      dependencyIds: [parentId],
      completionContract: contract,
    })).resolves.toMatchObject({ ok: false, error: { code: "validation_error" } })
    const childId = resultId(await command(fixture, "create_work_item", {
      streamId,
      parentTaskId: parentId,
      title: "Child",
      completionContract: contract,
    }), "workItemId")
    const parentRun = fixture.database
      .prepare("SELECT id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(parentId) as { id: string; generation: number }
    await fixture.runResults.recordResult(owner(), {
      runId: parentRun.id as never,
      workItemId: parentId as never,
      leaseEpoch: parentRun.generation,
      state: "result",
      summary: "Parent implementation is ready",
      artifacts: [],
    })
    await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: parentId },
      requirementId: "proof",
      evidence: { kind: "test_result", summary: "Parent tests pass", passed: true },
    })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(parentId))
      .toEqual({ lifecycle: "result_ready" })

    await fixture.drainReadyStreams()
    const childRun = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(childId) as { id: string; session_id: string; generation: number }
    const forbidden = await fixture.service.execute({
      ...owner(),
      actor: { type: "agent", id: childRun.session_id as never },
    }, {
      operationId: "operation_subtask_seat_forbidden" as never,
      command: {
        version: 1,
        type: "create_work_item",
        streamId: streamId as never,
        title: "Grandchild",
        completionContract: contract,
      },
    })
    expect(forbidden).toMatchObject({ ok: false, error: { code: "forbidden_for_subtask" } })

    await fixture.runResults.recordResult(owner(), {
      runId: childRun.id as never,
      workItemId: childId as never,
      leaseEpoch: childRun.generation,
      state: "result",
      summary: "Child implementation is ready",
      artifacts: [],
    })
    await command(fixture, "record_evidence", {
      subject: { type: "work_item", workItemId: childId },
      requirementId: "proof",
      evidence: { kind: "test_result", summary: "Child tests pass", passed: true },
    })
    expect(
      fixture.database
        .prepare("SELECT id, lifecycle FROM wg_v2_work_items WHERE id IN (?, ?) ORDER BY id")
        .all(parentId, childId),
    ).toEqual([
      { id: parentId, lifecycle: "completed" },
      { id: childId, lifecycle: "completed" },
    ].sort((left, right) => left.id.localeCompare(right.id)))
  })

  it("carves child Stream budgets, confirms the first promotion, and rolls closure up", async () => {
    const fixture = setup(runtime())
    const parentId = resultId(await command(fixture, "create_stream", {
      title: "Parent",
      execution: {
        ...execution,
        mayPromote: true,
        budget: { amount: 100, unit: "tokens", window: "stream" },
      },
    }), "streamId")
    await expect(command(fixture, "create_stream", {
      title: "Unconfirmed child",
      parentStreamId: parentId,
      budgetCarve: { amount: 30, unit: "tokens", window: "stream" },
    })).resolves.toMatchObject({ ok: false, error: { code: "promotion_confirmation_required" } })

    const firstChildId = resultId(await command(fixture, "create_stream", {
      title: "Confirmed child",
      parentStreamId: parentId,
      budgetCarve: { amount: 30, unit: "tokens", window: "stream" },
      confirmAutonomy: true,
    }), "streamId")
    const parent = fixture.database.prepare(
      "SELECT row_version, execution_defaults_json FROM wg_v2_streams WHERE id = ?",
    ).get(parentId) as { row_version: number; execution_defaults_json: string }
    const firstChild = fixture.database.prepare(
      "SELECT parent_stream_id, execution_defaults_json FROM wg_v2_streams WHERE id = ?",
    ).get(firstChildId) as { parent_stream_id: string; execution_defaults_json: string }
    expect(JSON.parse(parent.execution_defaults_json)).toMatchObject({
      mayPromote: true,
      budget: { amount: 70, unit: "tokens", window: "stream" },
    })
    expect(firstChild.parent_stream_id).toBe(parentId)
    expect(JSON.parse(firstChild.execution_defaults_json)).toMatchObject({
      mayPromote: true,
      budget: { amount: 30, unit: "tokens", window: "stream" },
    })
    const childTaskId = resultId(await command(fixture, "create_work_item", {
      streamId: firstChildId,
      title: "Child decision context",
      completionContract: contract,
    }), "workItemId")
    await command(fixture, "propose_decision", {
      streamId: firstChildId,
      question: "Which interface?",
      options: [{ id: "stable", label: "Stable" }],
      affectedWorkItemIds: [childTaskId],
    })
    await expect(fixture.service.queries.attention.list(owner(), { limit: 10 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          kind: "decision",
          streamPath: [
            { streamId: parentId, title: "Parent" },
            { streamId: firstChildId, title: "Confirmed child" },
          ],
        }),
      ],
    })

    const secondChild = await fixture.service.execute({
      ...owner(),
      actor: { type: "agent", id: "parent_master" as never },
    }, {
      operationId: "operation_second_promotion" as never,
      command: {
        version: 1,
        type: "create_stream",
        title: "Second child",
        parentStreamId: parentId as never,
      },
    })
    expect(secondChild).toMatchObject({ ok: true })
    const secondChildId = resultId(secondChild, "streamId")

    await expect(command(fixture, "close_stream", {
      streamId: parentId,
      expectedVersion: parent.row_version,
      reason: "Done",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "children_open",
        message: expect.stringContaining(firstChildId),
        details: { childStreamIds: expect.arrayContaining([firstChildId, secondChildId]) },
      },
    })
    await command(fixture, "close_stream", { streamId: firstChildId, expectedVersion: 1, reason: "Done" })
    await command(fixture, "close_stream", { streamId: secondChildId, expectedVersion: 1, reason: "Done" })
    await expect(command(fixture, "close_stream", {
      streamId: parentId,
      expectedVersion: parent.row_version,
      reason: "Done",
    })).resolves.toMatchObject({ ok: true })
  })

  it("turns a landing conflict into durable integration work for the Stream master", async () => {
    const fixture = setup(runtime())
    const itemId = await createItem(fixture)
    const streamId = streamFor(fixture, itemId)
    const run = fixture.database
      .prepare("SELECT id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(itemId) as { id: string; generation: number }
    await fixture.runResults.recordResult(owner(), {
      runId: run.id as never,
      workItemId: itemId as never,
      leaseEpoch: run.generation,
      state: "result",
      summary: "Candidate ready",
      artifacts: [],
    })
    const result = await fixture.service.execute({
      ...owner(),
      actor: { type: "agent", id: masterSessionId(streamId as never) as never },
    }, {
      operationId: "operation_landing_conflict" as never,
      command: {
        version: 1,
        type: "record_landing_conflict",
        streamId: streamId as never,
        workItemId: itemId as never,
        reason: "Both candidates changed the same interface",
      },
    })

    expect(result).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(itemId))
      .toEqual({ lifecycle: "integration_needed" })
    expect(fixture.database.prepare(
      "SELECT status, message FROM wg_v2_master_mailbox WHERE stream_id = ?",
    ).get(streamId)).toMatchObject({
      status: "pending",
      message: expect.stringContaining("Both candidates changed the same interface"),
    })
    const wake = fixture.database.prepare(
      "SELECT status, payload_json FROM wg_v2_due_jobs WHERE subject_id = ? AND job_type = 'master_wake'",
    ).get(streamId) as { status: string; payload_json: string }
    expect(wake.status).toBe("pending")
    expect(JSON.parse(wake.payload_json)).toMatchObject({ trigger: "mailbox" })
  })

  it("launches a durable admitted autonomous Run after process restart", async () => {
    const launches: string[] = []
    const executionRuntime = runtime({
      launch: async (_context, input) => {
        launches.push(input.runId)
        return { sessionId: `session_${input.runId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
      },
    })
    const fixture = setup(executionRuntime)
    const itemId = await createItem(fixture)
    const streamId = streamFor(fixture, itemId)
    // Auto-admitted on creation; simulate a crash before launch by resetting it to `admitted`.
    const runId = runIdFor(fixture, itemId)
    fixture.database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'admitted', session_id = NULL, started_at = NULL WHERE id = ?
    `,
      )
      .run(runId)

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
            fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runId) as {
              lifecycle: string
            }
          ).lifecycle,
      )
      .toBe("running")
    expect(launches).toEqual([runId, runId])
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_streams WHERE id = ?").get(streamId)).toEqual({
      lifecycle: "active",
    })
  })

  it("resumes a transiently parked Run with the same identity and generation", async () => {
    const launches: string[] = []
    let fail = true
    const fixture = setup(
      runtime({
        launch: async (_context, input) => {
          launches.push(input.runId)
          if (fail) {
            fail = false
            throw new Error("Session transport unavailable")
          }
          return {
            sessionId: `session_${input.runId}` as never,
            envelopeId: input.envelopeId,
            projectId: "/tmp/workgraph",
          }
        },
      }),
      Date.now,
    )
    const item = await createItem(fixture)
    const runId = runIdFor(fixture, item)
    expect(
      fixture.database
        .prepare("SELECT lifecycle, generation, resume_attempts FROM wg_v2_runs WHERE id = ?")
        .get(runId),
    ).toEqual({ lifecycle: "parked", generation: 1, resume_attempts: 1 })
    expect(
      fixture.database.prepare("SELECT holder_id, epoch FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ holder_id: runId, epoch: 1 })

    await expect
      .poll(
        () =>
          fixture.database
            .prepare("SELECT lifecycle, generation, resume_attempts FROM wg_v2_runs WHERE id = ?")
            .get(runId),
        { timeout: 3_000 },
      )
      .toEqual({ lifecycle: "running", generation: 1, resume_attempts: 1 })
    expect(launches).toEqual([runId, runId])
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(item),
    ).toEqual({ count: 1 })
  })

  it("parks an interrupted running Session, keeps its lease, and resumes the same Run", async () => {
    const launches: string[] = []
    const fixture = setup(
      runtime({
        launch: async (_context, input) => {
          launches.push(input.runId)
          return {
            sessionId: `session_${input.runId}` as never,
            envelopeId: input.envelopeId,
            projectId: "/tmp/workgraph",
          }
        },
      }),
    )
    const item = await createItem(fixture)
    const run = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(item) as { id: string; session_id: string; generation: number }

    await expect(
      fixture.runRuntime.park(owner(), {
        runId: run.id as never,
        workItemId: item as never,
        sessionId: run.session_id as never,
        leaseEpoch: run.generation,
        reason: "Session stopped before the provider step settled",
      }),
    ).resolves.toEqual({ state: "parked", retryAfterMs: 1_000 })
    expect(
      fixture.database
        .prepare("SELECT lifecycle, session_id, generation, resume_attempts FROM wg_v2_runs WHERE id = ?")
        .get(run.id),
    ).toEqual({
      lifecycle: "parked",
      session_id: run.session_id,
      generation: run.generation,
      resume_attempts: 1,
    })
    expect(
      fixture.database.prepare("SELECT holder_id, epoch FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ holder_id: run.id, epoch: run.generation })

    fixture.database.prepare("UPDATE wg_v2_runs SET resume_available_at = 0 WHERE id = ?").run(run.id)
    await fixture.drainReadyStreams()

    expect(
      fixture.database.prepare("SELECT lifecycle, session_id, generation FROM wg_v2_runs WHERE id = ?").get(run.id),
    ).toEqual({ lifecycle: "running", session_id: run.session_id, generation: run.generation })
    expect(launches).toEqual([run.id, run.id])
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(item),
    ).toEqual({ count: 1 })
  })

  it("reschedules the shared resume drain when a newly parked Run is due sooner", async () => {
    const fixture = setup(runtime(), Date.now)
    const laterItem = await createItem(fixture)
    const laterRun = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(laterItem) as { id: string; session_id: string; generation: number }
    fixture.database.prepare("UPDATE wg_v2_runs SET resume_attempts = 3 WHERE id = ?").run(laterRun.id)
    await fixture.runRuntime.park(owner(), {
      runId: laterRun.id as never,
      workItemId: laterItem as never,
      sessionId: laterRun.session_id as never,
      leaseEpoch: laterRun.generation,
      reason: "Long retry",
    })

    const soonerItem = await createItem(fixture)
    const soonerRun = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(soonerItem) as { id: string; session_id: string; generation: number }
    await fixture.runRuntime.park(owner(), {
      runId: soonerRun.id as never,
      workItemId: soonerItem as never,
      sessionId: soonerRun.session_id as never,
      leaseEpoch: soonerRun.generation,
      reason: "Short retry",
    })

    await expect.poll(
      () => fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(soonerRun.id),
      { timeout: 3_000 },
    ).toEqual({ lifecycle: "running" })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(laterRun.id))
      .toEqual({ lifecycle: "parked" })
  })

  it("fails an interrupted running Session at the resume cap and surfaces Needs-you", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const run = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(item) as { id: string; session_id: string; generation: number }
    fixture.database.prepare("UPDATE wg_v2_runs SET resume_attempts = 5 WHERE id = ?").run(run.id)

    await expect(
      fixture.runRuntime.park(owner(), {
        runId: run.id as never,
        workItemId: item as never,
        sessionId: run.session_id as never,
        leaseEpoch: run.generation,
        reason: "Session repeatedly stopped before settlement",
      }),
    ).resolves.toEqual({ state: "failed" })
    expect(
      fixture.database.prepare("SELECT lifecycle, resume_attempts FROM wg_v2_runs WHERE id = ?").get(run.id),
    ).toEqual({ lifecycle: "failed", resume_attempts: 6 })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item))
      .toEqual({ lifecycle: "failed" })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item))
      .toEqual({ count: 0 })
    await expect(fixture.service.queries.attention.list(owner(), { limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ kind: "work_item", id: item })],
    })
  })

  it("allows the fifth transient resume failure to park the Run", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const run = fixture.database
      .prepare("SELECT id, session_id, generation FROM wg_v2_runs WHERE work_item_id = ?")
      .get(item) as { id: string; session_id: string; generation: number }
    fixture.database.prepare("UPDATE wg_v2_runs SET resume_attempts = 4 WHERE id = ?").run(run.id)

    await expect(
      fixture.runRuntime.park(owner(), {
        runId: run.id as never,
        workItemId: item as never,
        sessionId: run.session_id as never,
        leaseEpoch: run.generation,
        reason: "Transient Session transport failure",
      }),
    ).resolves.toEqual({ state: "parked", retryAfterMs: 16_000 })
    expect(
      fixture.database.prepare("SELECT lifecycle, resume_attempts FROM wg_v2_runs WHERE id = ?").get(run.id),
    ).toEqual({ lifecycle: "parked", resume_attempts: 5 })
  })

  it("admits exactly one lease-fenced Run for an approved Work Item", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    // The drain admits the approved item once, under the per-item lease fence.
    expect(
      (fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs").get() as { count: number }).count,
    ).toBe(1)
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item)).toEqual({
      lifecycle: "active",
    })
  })

  it("does not admit a ready Work Item whose resolved execution profile is incomplete", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "Incomplete execution",
      execution: { ...execution, agent: undefined },
    })
    const streamId = resultId(stream, "streamId")
    const item = await command(fixture, "create_work_item", {
      streamId,
      title: "Ready but not executable",
      completionContract: contract,
    })
    // The drain re-derives launchability and skips the item — no Run, task stays pending.
    expect(
      (fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs").get() as { count: number }).count,
    ).toBe(0)
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(resultId(item, "workItemId")))
      .toEqual({ lifecycle: "pending" })
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
    // `second` is already auto-admitted on creation.
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
          launches.push(input.runId)
          return { sessionId: `session_${input.runId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
        },
      }),
    )
    const { item: itemId, streamId } = await createPausedItem(fixture)
    fixture.database
      .prepare(`UPDATE wg_v2_streams SET envelope_identity_json = ? WHERE id = ?`)
      .run(JSON.stringify({ id: "envelope_1", workspaceId: "/tmp/worktree" }), streamId)

    const deleting = command(fixture, "delete_stream", { streamId, expectedVersion: 2, reason: "Discard" })
    await started
    // Reconciliation runs while cleanup is reserved; the reserved Stream admits nothing.
    await command(fixture, "create_stream", { title: "Trigger reconciliation" })

    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(itemId),
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
          launches.push(input.runId)
          return { sessionId: "session_1" as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
        },
        cleanup: async () => {
          cleanups.push("cleanup")
        },
      }),
    )
    const { item, streamId } = await createPausedItem(fixture)
    // Resuming the Stream admits the item and enters provisioning (which blocks).
    const admitting = command(fixture, "set_stream_lifecycle", { streamId, expectedVersion: 2, state: "active", reason: "Run" })
    await started
    const run = fixture.database
      .prepare("SELECT id, row_version FROM wg_v2_runs WHERE work_item_id = ?")
      .get(item) as { id: string; row_version: number }
    // Cancel commits synchronously (marks the Run cancelled) before joining the
    // in-flight drain; releasing provisioning then lets both settle. Placement finds
    // the Run cancelled and never launches a ghost Session.
    const cancelling = command(fixture, "cancel_run", {
      runId: run.id,
      expectedVersion: run.row_version,
      reason: "Stop",
    })
    releaseProvision()
    await expect(cancelling).resolves.toMatchObject({ ok: true })
    await expect(admitting).resolves.toMatchObject({ ok: true })
    expect(launches).toEqual([])
    expect(cleanups).toEqual([])
  })

  it("keeps a failed cancellation effect durable and retryable before terminalizing the Run", async () => {
    let failures = 1
    const fixture = setup(
      runtime({
        cancel: async () => {
          if (failures-- > 0) throw new Error("runtime unavailable")
        },
      }),
    )
    const item = await createItem(fixture)
    const runId = runIdFor(fixture, item)
    const run = fixture.database.prepare("SELECT row_version FROM wg_v2_runs WHERE id = ?").get(runId) as {
      row_version: number
    }
    const operationId = `operation_${crypto.randomUUID()}` as OperationID
    const request = {
      operationId,
      command: { version: 1, type: "cancel_run", runId, expectedVersion: run.row_version, reason: "Stop" },
    } as never
    await expect(fixture.service.execute(owner(), request)).resolves.toMatchObject({
      ok: false,
      error: { retryable: true },
    })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runId)).toEqual({
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
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runId)).toEqual({
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
          renewSqliteRunLease(fixture.database, owner(), {
            runId: input.runId,
            expectedLeaseEpoch: 1,
            occurredAt: 1_000_000,
            durationMs: 300_000,
          }),
        ).toMatchObject({ leaseEpoch: 2, recovered: true })
        return { sessionId: `session_${input.runId}` as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }
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
    const runId = runIdFor(fixture, item)

    expect(
      fixture.database.prepare("SELECT lifecycle, generation FROM wg_v2_runs WHERE id = ?").get(runId),
    ).toEqual({ lifecycle: "placing", generation: 2 })
    expect(
      fixture.database
        .prepare(
          `
      SELECT state, attempt_count, last_error FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `,
        )
        .get(runId),
    ).toEqual({
      state: "pending",
      attempt_count: 1,
      last_error: expect.stringContaining("Run lease ownership was lost after launch"),
    })
    expect(
      (
        fixture.database
          .prepare("SELECT last_error FROM wg_v2_runtime_effects WHERE resource_id = ?")
          .get(runId) as { last_error: string }
      ).last_error,
    ).toContain("session cancellation unavailable")
    expect(cleanups).toEqual([])

    const persisted = fixture.database.prepare(`
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `).get(runId) as { payload_json: string }
    fixture.database.prepare(`
      UPDATE wg_v2_runtime_effects SET payload_json = ?
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `).run(JSON.stringify({ ...JSON.parse(persisted.payload_json), childIsolationId: "child_legacy" }), runId)

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
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `,
          )
          .get(runId),
      )
      .toEqual({ state: "completed", attempt_count: 2, last_error: null })
    expect(
      fixture.database.prepare("SELECT lifecycle, parked_reason FROM wg_v2_runs WHERE id = ?").get(runId),
    ).toEqual({ lifecycle: "parked", parked_reason: expect.stringContaining("session cancellation unavailable") })
    const compensation = fixture.database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `,
      )
      .get(runId) as { payload_json: string }
    expect(JSON.parse(compensation.payload_json)).toMatchObject({
      reason: "Run lease ownership was lost after launch",
      failureHistory: [expect.stringContaining("session cancellation unavailable")],
    })
    expect(cancellations).toEqual([`session_${runId}`, `session_${runId}`])
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
    const runId = runIdFor(fixture, item)

    expect(
      fixture.database.prepare("SELECT lifecycle, parked_reason FROM wg_v2_runs WHERE id = ?").get(runId),
    ).toEqual({
      lifecycle: "parked",
      parked_reason: expect.stringContaining("Session admission rejected"),
    })
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_run_placement' AND resource_id = ?
    `).get(runId)).toEqual({ count: 0 })

    expect(cleanups).toEqual([])
  })

  it("persists one idempotent terminal result/change, sets result_ready, and leaves semantic completion pending", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const runId = runIdFor(fixture, item) as never
    await fixture.runResults.recordResult(owner(), {
      runId,
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
    await fixture.runResults.recordResult(owner(), {
      runId,
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
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runId)).toEqual({
      lifecycle: "result",
    })
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ count: 0 })
  })

  it("rejects missing or blank semantic output instead of fabricating a successful result", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const runId = runIdFor(fixture, item) as never
    const identity = { runId, workItemId: item as never, leaseEpoch: 1, state: "result" as const }

    await expect(
      fixture.runResults.recordResult(owner(), { ...identity, summary: "   ", artifacts: [] }),
    ).rejects.toThrow("summary must be non-empty")
    await expect(
      fixture.runResults.recordResult(owner(), { ...identity, summary: "Done" } as never),
    ).rejects.toThrow("artifacts must be an explicit array")
    expect(
      fixture.database
        .prepare("SELECT lifecycle, terminal_result_json FROM wg_v2_runs WHERE id = ?")
        .get(runId),
    ).toEqual({ lifecycle: "running", terminal_result_json: null })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(item)).toEqual({
      lifecycle: "active",
    })
  })

  it("recovers an expired same-Run lease with a fenced epoch and close terminalizes active Runs", async () => {
    const fixture = setup(runtime())
    const item = await createItem(fixture)
    const runId = runIdFor(fixture, item)
    expect(
      renewSqliteRunLease(fixture.database, owner(), {
        runId: runId as never,
        expectedLeaseEpoch: 1,
        occurredAt: 1_000_000,
        durationMs: 300_000,
      }),
    ).toEqual({ leaseEpoch: 2, expiresAt: 1_300_000, recovered: true })
    expect(fixture.database.prepare("SELECT epoch FROM wg_v2_leases WHERE resource_id = ?").get(item)).toEqual({
      epoch: 2,
    })
    await expect(
      fixture.runResults.recordResult(owner(), {
        runId: runId as never,
        workItemId: item as never,
        leaseEpoch: 1,
        state: "result",
        summary: "Stale worker",
        artifacts: [],
      }),
    ).resolves.toBe(false)
    expect(
      fixture.database.prepare("SELECT lifecycle, generation FROM wg_v2_runs WHERE id = ?").get(runId),
    ).toEqual({ lifecycle: "running", generation: 2 })
    const streamId = streamFor(fixture, item)
    await expect(
      command(fixture, "close_stream", { streamId, expectedVersion: 1, reason: "Stopping" }),
    ).resolves.toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runId)).toEqual({
      lifecycle: "cancelled",
    })
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE resource_id = ?").get(item),
    ).toEqual({ count: 0 })
  })

  it("restarts a parked Run as a fresh higher generation and fences the old callback", async () => {
    const cancellations: string[] = []
    const launches: string[] = []
    const fixture = setup(
      runtime({
        launch: async (_context, input) => {
          launches.push(input.runId)
          return {
            sessionId: `session_${input.runId}` as never,
            envelopeId: input.envelopeId,
            projectId: "/tmp/workgraph",
          }
        },
        cancel: async (_context, input) => {
          cancellations.push(input.sessionId)
        },
      }),
    )
    const item = await createItem(fixture)
    const oldRunId = runIdFor(fixture, item)
    fixture.database
      .prepare("UPDATE wg_v2_runs SET lifecycle = 'parked', row_version = row_version + 1 WHERE id = ?")
      .run(oldRunId)
    const oldRun = fixture.database
      .prepare("SELECT row_version FROM wg_v2_runs WHERE id = ?")
      .get(oldRunId) as { row_version: number }

    await expect(
      command(fixture, "restart_run", {
        runId: oldRunId,
        expectedVersion: oldRun.row_version,
        reason: "Use a clean execution",
      }),
    ).resolves.toMatchObject({ ok: true })

    const runs = fixture.database
      .prepare(
        `
      SELECT id, lifecycle, generation FROM wg_v2_runs
      WHERE work_item_id = ? ORDER BY run_number
    `,
      )
      .all(item) as Array<{ id: string; lifecycle: string; generation: number }>
    expect(runs).toEqual([
      { id: oldRunId, lifecycle: "cancelled", generation: 1 },
      { id: expect.not.stringMatching(new RegExp(`^${oldRunId}$`)), lifecycle: "running", generation: 2 },
    ])
    expect(cancellations).toEqual([`session_${oldRunId}`])
    expect(launches).toEqual([oldRunId, runs[1]!.id])
    await expect(
      fixture.runResults.recordResult(owner(), {
        runId: oldRunId as never,
        workItemId: item as never,
        leaseEpoch: 1,
        state: "result",
        summary: "Zombie completion",
        artifacts: [],
      }),
    ).resolves.toBe(false)
    expect(
      fixture.database.prepare("SELECT lifecycle FROM wg_v2_runs WHERE id = ?").get(runs[1]!.id),
    ).toEqual({ lifecycle: "running" })
  })

  it("folds Stream spend idempotently and holds budget-exhausted work in Needs-you", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "Budgeted stream",
      execution: {
        ...execution,
        budget: { amount: 1_000, unit: "tokens", window: "stream" },
        agents: [{
          name: "Builder",
          brief: "Build and verify the requested change.",
          generation: {
            harness: execution.harness,
            agent: execution.agent,
            model: execution.model,
            effort: execution.effort,
            tools: execution.tools,
            connectionIds: execution.connectionIds,
          },
        }],
        assignments: { execution: "Builder" },
      },
    })
    const streamId = resultId(stream, "streamId")
    const usageSourceId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "Generate attributed usage",
      completionContract: contract,
    }), "workItemId")
    const usageRunId = runIdFor(fixture, usageSourceId)
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 1,
      state: "paused",
      reason: "Load usage",
    })
    const item = await command(fixture, "create_work_item", {
      streamId,
      title: "Must stay held",
      completionContract: contract,
    })
    const itemId = resultId(item, "workItemId")
    const usage = {
      id: "usage_1",
      sessionId: "session_1",
      streamId,
      runId: usageRunId,
      providerId: "unknown",
      modelId: "unknown",
      inputTokens: 600,
      outputTokens: 400,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: 2_000,
    }
    expect(recordSqliteWorkGraphLlmUsage(fixture.database, owner(), usage)).toBe(true)
    expect(recordSqliteWorkGraphLlmUsage(fixture.database, owner(), usage)).toBe(false)
    const priorMasterStatus = {
      state: "attention",
      escalation: "failure_halt",
      sessionId: `ses_master_${streamId}`,
      message: "Existing master failure",
      receiptRefs: ["receipt:failure"],
      updatedAt: 1_999,
    }
    fixture.database
      .prepare("UPDATE wg_v2_streams SET master_status_json = ? WHERE id = ?")
      .run(JSON.stringify(priorMasterStatus), streamId)
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 2,
      state: "active",
      reason: "Try launch",
    })

    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(itemId),
    ).toEqual({ count: 0 })
    const held = fixture.database
      .prepare("SELECT spend_json, master_status_json FROM wg_v2_streams WHERE id = ?")
      .get(streamId) as { spend_json: string; master_status_json: string }
    expect(JSON.parse(held.spend_json)).toMatchObject({
      totalTokens: 1_000,
      asOfMessageId: "usage_1",
      dayTokens: 1_000,
      byProfile: [{ profile: "Builder", totalTokens: 1_000 }],
    })
    expect(JSON.parse(held.master_status_json)).toMatchObject({
      state: "attention",
      escalation: "budget_exhausted",
      budgetPriorStatus: priorMasterStatus,
    })
    await fixture.drainReadyStreams()
    expect(JSON.parse((fixture.database
      .prepare("SELECT spend_json FROM wg_v2_streams WHERE id = ?")
      .get(streamId) as { spend_json: string }).spend_json)).toMatchObject({
      totalTokens: 1_000,
      asOfMessageId: "usage_1",
      dayTokens: 1_000,
    })
    await expect(
      fixture.service.queries.attention.list(owner(), { limit: 10 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          kind: "master_escalation",
          streamId,
          category: "budget_exhausted",
        }),
      ],
    })
  })

  it("folds more than 5,000 equal-timestamp usage rows without skipping the cursor tail", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "Paged budget",
      execution: { ...execution, budget: { amount: 5_001, unit: "tokens", window: "stream" } },
    })
    const streamId = resultId(stream, "streamId")
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 1,
      state: "paused",
      reason: "Load usage",
    })
    const itemId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "Must wait for the complete fold",
      completionContract: contract,
    }), "workItemId")
    fixture.database.transaction(() =>
      Array.from({ length: 5_001 }, (_, index) => index).forEach((index) => {
        recordSqliteWorkGraphLlmUsage(fixture.database, owner(), {
          id: `usage_${String(index).padStart(5, "0")}`,
          sessionId: "session_paged",
          streamId,
          providerId: "unknown",
          modelId: "unknown",
          inputTokens: 1,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          createdAt: 2_000,
        })
      }),
    )()
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 2,
      state: "active",
      reason: "Fold usage",
    })
    expect(JSON.parse((fixture.database.prepare(
      "SELECT spend_json FROM wg_v2_streams WHERE id = ?",
    ).get(streamId) as { spend_json: string }).spend_json)).toMatchObject({
      totalTokens: 5_000,
      asOf: 2_000,
      asOfMessageId: "usage_04999",
    })

    await fixture.drainReadyStreams()

    expect(JSON.parse((fixture.database.prepare(
      "SELECT spend_json FROM wg_v2_streams WHERE id = ?",
    ).get(streamId) as { spend_json: string }).spend_json)).toMatchObject({
      totalTokens: 5_001,
      asOf: 2_000,
      asOfMessageId: "usage_05000",
    })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(itemId))
      .toEqual({ count: 0 })
  })

  it("enforces a known-model USD day budget", async () => {
    const fixture = setup(runtime())
    const stream = await command(fixture, "create_stream", {
      title: "USD budget",
      execution: { ...execution, budget: { amount: 0.000_001, unit: "usd", window: "day" } },
    })
    const streamId = resultId(stream, "streamId")
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 1,
      state: "paused",
      reason: "Load usage",
    })
    const itemId = resultId(await command(fixture, "create_work_item", {
      streamId,
      title: "Held by USD budget",
      completionContract: contract,
    }), "workItemId")
    recordSqliteWorkGraphLlmUsage(fixture.database, owner(), {
      id: "usage_usd",
      sessionId: "session_usd",
      streamId,
      providerId: "openai",
      modelId: "gpt-5",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: 2_000,
    })
    await command(fixture, "set_stream_lifecycle", {
      streamId,
      expectedVersion: 2,
      state: "active",
      reason: "Try launch",
    })

    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE work_item_id = ?").get(itemId))
      .toEqual({ count: 0 })
    expect(JSON.parse((fixture.database.prepare(
      "SELECT spend_json FROM wg_v2_streams WHERE id = ?",
    ).get(streamId) as { spend_json: string }).spend_json)).toMatchObject({
      totalTokens: 2,
      dayTokens: 2,
      totalUsd: expect.any(Number),
      dayUsd: expect.any(Number),
    })
  })
})

function setup(execution: WorkspaceExecutionPort, now?: () => number) {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let id = 0
  const adapter = createSqliteWorkGraphService({
    database,
    executionCapabilities: testExecutionCapabilities,
    execution,
    clock: { now: now ?? (() => 1_000 + id) },
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

/**
 * Creates an approved Work Item in a paused Stream so it is NOT auto-admitted;
 * resume the Stream (`set_stream_lifecycle` → active, expectedVersion 2) to admit
 * at a controlled point.
 */
async function createPausedItem(fixture: ReturnType<typeof setup>) {
  const stream = await command(fixture, "create_stream", { title: `Stream ${crypto.randomUUID()}`, execution })
  if (!stream.ok) throw new Error("Expected Stream")
  const streamId = resultId(stream, "streamId")
  await command(fixture, "set_stream_lifecycle", { streamId, expectedVersion: 1, state: "paused", reason: "Hold" })
  const item = await command(fixture, "create_work_item", {
    streamId,
    title: "Implement",
    completionContract: contract,
  })
  if (!item.ok) throw new Error("Expected Work Item")
  return { item: resultId(item, "workItemId"), streamId }
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

/**
 * A user-created Work Item in an active Stream is auto-admitted by the drain that
 * runs after every command, so its Run already exists once creation resolves.
 */
function runIdFor(fixture: ReturnType<typeof setup>, item: string) {
  const row = fixture.database
    .prepare("SELECT id FROM wg_v2_runs WHERE work_item_id = ? ORDER BY run_number DESC LIMIT 1")
    .get(item) as { id: string } | undefined
  if (!row) throw new Error(`No admitted Run for Work Item ${item}`)
  return row.id
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
      sessionId: `session_${input.runId}` as never,
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
  environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: "/repo" },
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
    // Human owner: created Work Items are born approved (`pending`) and auto-admit.
    actor: { type: "user", id: "owner" as never },
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
