import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import {
  createSqliteWorkGraphActivityPorts,
  createSqliteWorkGraphArchivePort,
  createSqliteWorkGraphService,
} from "../src"
import type { CompletionContract, OperationID, StreamID, WorkGraphContext, WorkItemID } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []
const completionContract = {
  version: 1,
  mode: "all",
  requirements: [{ id: branded("owner"), kind: "owner_confirmation", description: "Owner accepts" }],
} satisfies CompletionContract
const resolvedExecution = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite WorkGraph activity and attached Sessions", () => {
  it("binds one Session, attaches ready Tasks, deduplicates checkpoints, and pages unified activity", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let now = 10
    let id = 0
    const service = createSqliteWorkGraphService({
      database,
      clock: { now: () => ++now },
      ids: { next: (kind) => `${kind}_${++id}` },
    }).service
    const ports = createSqliteWorkGraphActivityPorts({
      database,
      clock: { now: () => ++now },
      ids: { next: (kind) => `${kind}_activity_${++id}` },
    })
    const streamId = resultId(await execute(service, "stream", {
      type: "create_stream",
      title: "Ledger",
    }), "streamId") as StreamID
    const first = resultId(await execute(service, "first", {
      type: "create_work_item",
      streamId,
      title: "First",
      completionContract,
    }), "workItemId") as WorkItemID
    const second = resultId(await execute(service, "second", {
      type: "create_work_item",
      streamId,
      title: "Second",
      completionContract,
    }), "workItemId") as WorkItemID

    const binding = await ports.sessionBindings.bind(owner(), {
      operationId: operation("bind"),
      streamId,
      sessionId: "session_project",
      projectId: "project_local",
    })
    await expect(ports.sessionBindings.bind(owner("other"), {
      operationId: operation("foreign_bind"),
      streamId,
      sessionId: "session_project",
      projectId: "project_local",
    })).rejects.toMatchObject({ code: "not_found" })
    const attached = await ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_first"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId: first,
      resolvedExecution,
    })
    expect(attached).toMatchObject({ currentWorkItemId: first, currentRunId: expect.any(String), version: 2 })
    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_first"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId: first,
      resolvedExecution,
    })).resolves.toEqual(attached)
    expect(database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(first))
      .toEqual({ lifecycle: "active" })
    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_second_early"),
      bindingId: binding.id,
      expectedVersion: 2,
      workItemId: second,
      resolvedExecution,
    })).rejects.toMatchObject({ code: "invalid_transition" })

    const checkpoint = await ports.sessionBindings.recordCheckpoint(owner(), {
      operationId: operation("checkpoint_once"),
      bindingId: binding.id,
      level: "progress",
      summary: "Validated the first boundary",
      evidenceIds: [],
    })
    await expect(ports.sessionBindings.recordCheckpoint(owner(), {
      operationId: operation("checkpoint_once"),
      bindingId: binding.id,
      level: "progress",
      summary: "Validated the first boundary",
      evidenceIds: [],
    })).resolves.toEqual(checkpoint)
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_agent_checkpoints").get()).toEqual({ count: 1 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_changes WHERE resource_type = 'agent_checkpoint'").get())
      .toEqual({ count: 1 })

    const firstPage = await ports.activity.list(owner(), { workItemId: first, granularity: "progress", limit: 2 })
    expect(firstPage.entries).toHaveLength(2)
    expect(firstPage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "checkpoint", summary: "Validated the first boundary" }),
      expect.objectContaining({ category: "run" }),
    ]))
    expect(firstPage).toMatchObject({ hasMore: true, nextCursor: expect.any(String) })
    await ports.sessionBindings.recordCheckpoint(owner(), {
      operationId: operation("checkpoint_newer"),
      bindingId: binding.id,
      level: "milestone",
      summary: "A newer boundary",
      evidenceIds: [],
    })
    const secondPage = await ports.activity.list(owner(), {
      workItemId: first,
      granularity: "progress",
      after: firstPage.nextCursor,
      limit: 10,
    })
    expect(secondPage.entries).not.toContainEqual(expect.objectContaining({ summary: "A newer boundary" }))
    const milestones = await ports.activity.list(owner(), { workItemId: first, granularity: "milestones", limit: 20 })
    expect(milestones.entries.every((entry) => entry.importance === "milestones")).toBe(true)

    database.prepare("UPDATE wg_v2_work_items SET lifecycle = 'completed' WHERE id = ?").run(first)
    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_second_run_running"),
      bindingId: binding.id,
      expectedVersion: 2,
      workItemId: second,
      resolvedExecution,
    })).rejects.toMatchObject({ code: "invalid_transition" })
    database.prepare("UPDATE wg_v2_runs SET lifecycle = 'result', finished_at = ? WHERE id = ?")
      .run(++now, attached.currentRunId)
    const moved = await ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_second"),
      bindingId: binding.id,
      expectedVersion: 2,
      workItemId: second,
      resolvedExecution,
    })
    expect(moved).toMatchObject({ currentWorkItemId: second, version: 3 })

    database.prepare("UPDATE wg_v2_runs SET lifecycle = 'result', finished_at = ? WHERE id = ?")
      .run(++now, moved.currentRunId)
    await expect(ports.sessionBindings.release(owner(), {
      operationId: operation("release"),
      bindingId: binding.id,
      expectedVersion: 3,
    })).resolves.toMatchObject({ state: "released", releasedAt: expect.any(Number), version: 4 })
  })

  it("round-trips bindings and checkpoints through the canonical archive", async () => {
    const source = new BetterSqlite3(":memory:")
    const target = new BetterSqlite3(":memory:")
    databases.push(source, target)
    let id = 0
    const service = createSqliteWorkGraphService({ database: source, ids: { next: (kind) => `${kind}_${++id}` } }).service
    const ports = createSqliteWorkGraphActivityPorts({ database: source, ids: { next: (kind) => `${kind}_activity_${++id}` } })
    const streamId = resultId(await execute(service, "archive_stream", { type: "create_stream", title: "Archive" }), "streamId") as StreamID
    const workItemId = resultId(await execute(service, "archive_task", {
      type: "create_work_item",
      streamId,
      title: "Task",
      completionContract,
    }), "workItemId") as WorkItemID
    const binding = await ports.sessionBindings.bind(owner(), {
      operationId: operation("archive_bind"),
      streamId,
      sessionId: "session_archive",
      projectId: "project_archive",
    })
    await ports.sessionBindings.attachTask(owner(), {
      operationId: operation("archive_attach"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId,
      resolvedExecution,
    })
    await ports.sessionBindings.recordCheckpoint(owner(), {
      operationId: operation("archive_checkpoint"),
      bindingId: binding.id,
      level: "progress",
      summary: "Archive this boundary",
      evidenceIds: [],
    })
    source.prepare("UPDATE wg_v2_runs SET lifecycle = 'result', finished_at = 20 WHERE execution_kind = 'attached'").run()

    const archive = await createSqliteWorkGraphArchivePort(source).export(owner())
    expect(archive.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session_binding", id: binding.id }),
      expect.objectContaining({ kind: "agent_checkpoint" }),
      expect.objectContaining({ kind: "run", value: expect.objectContaining({ executionKind: "attached" }) }),
    ]))
    await createSqliteWorkGraphArchivePort(target).restore(owner(), {
      operationId: operation("archive_restore"),
      archive,
    })
    await expect(createSqliteWorkGraphArchivePort(target).export(owner())).resolves.toMatchObject({ records: archive.records })
  })

  it("uses the same Decision and active-Run readiness fences as managed execution", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let id = 0
    const service = createSqliteWorkGraphService({ database, ids: { next: (kind) => `${kind}_${++id}` } }).service
    const ports = createSqliteWorkGraphActivityPorts({ database, ids: { next: (kind) => `${kind}_activity_${++id}` } })
    const streamId = resultId(await execute(service, "ready_stream", { type: "create_stream", title: "Readiness" }), "streamId") as StreamID
    const workItemId = resultId(await execute(service, "ready_task", {
      type: "create_work_item",
      streamId,
      title: "Guarded Task",
      completionContract,
    }), "workItemId") as WorkItemID
    const binding = await ports.sessionBindings.bind(owner(), {
      operationId: operation("ready_bind"),
      streamId,
      sessionId: "session_ready",
      projectId: "project_ready",
    })
    const decisionId = resultId(await execute(service, "ready_decision", {
      type: "propose_decision",
      streamId,
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      affectedWorkItemIds: [workItemId],
    }), "decisionId")

    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_with_decision"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId,
      resolvedExecution,
    })).rejects.toMatchObject({ code: "not_ready", message: "Work Item requires a pending Decision" })
    await execute(service, "answer_ready_decision", {
      type: "answer_decision",
      decisionId,
      expectedVersion: 1,
      optionId: "yes",
    })
    database.prepare(`
      INSERT INTO wg_v2_runs
        (organization_id, owner_user_id, id, stream_id, work_item_id, run_number, lifecycle,
         resolved_execution_profile_json, created_at, updated_at)
      VALUES (?, ?, 'managed_running', ?, ?, 1, 'running', '{}', 1, 1)
    `).run(owner().organizationId, owner().ownerUserId, streamId, workItemId)
    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_with_run"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId,
      resolvedExecution,
    })).rejects.toMatchObject({ code: "not_ready", message: "Work Item already has an active Run" })
    database.prepare("UPDATE wg_v2_runs SET lifecycle = 'failed', finished_at = 2 WHERE id = 'managed_running'").run()
    await expect(ports.sessionBindings.attachTask(owner(), {
      operationId: operation("attach_after_ready"),
      bindingId: binding.id,
      expectedVersion: 1,
      workItemId,
      resolvedExecution,
    })).resolves.toMatchObject({ currentWorkItemId: workItemId, currentRunId: expect.any(String) })
  })

  it("removes attached activity state when a disposable Stream is deleted", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let id = 0
    const service = createSqliteWorkGraphService({ database, ids: { next: (kind) => `${kind}_${++id}` } }).service
    const ports = createSqliteWorkGraphActivityPorts({ database, ids: { next: (kind) => `${kind}_activity_${++id}` } })
    const streamId = resultId(await execute(service, "delete_stream_create", { type: "create_stream", title: "Disposable" }), "streamId") as StreamID
    const workItemId = resultId(await execute(service, "delete_stream_task", {
      type: "create_work_item",
      streamId,
      title: "Disposable Task",
      completionContract,
    }), "workItemId") as WorkItemID
    const binding = await ports.sessionBindings.bind(owner(), {
      operationId: operation("delete_stream_bind"),
      streamId,
      sessionId: "session_disposable",
      projectId: "project_disposable",
    })
    const attached = await ports.sessionBindings.attachTask(owner(), {
      operationId: operation("delete_stream_attach"),
      bindingId: binding.id,
      expectedVersion: binding.version,
      workItemId,
      resolvedExecution,
    })
    await ports.sessionBindings.recordCheckpoint(owner(), {
      operationId: operation("delete_stream_checkpoint"),
      bindingId: binding.id,
      level: "progress",
      summary: "Disposable checkpoint",
      evidenceIds: [],
    })
    database.prepare("UPDATE wg_v2_runs SET lifecycle = 'result', finished_at = 20 WHERE id = ?")
      .run(attached.currentRunId)
    const version = database.prepare("SELECT row_version FROM wg_v2_streams WHERE id = ?").get(streamId) as { row_version: number }

    await expect(execute(service, "delete_stream_execute", {
      type: "delete_stream",
      streamId,
      expectedVersion: version.row_version,
      reason: "Disposable",
    })).resolves.toMatchObject({ ok: true })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams WHERE id = ?").get(streamId)).toEqual({ count: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_session_bindings WHERE stream_id = ?").get(streamId)).toEqual({ count: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_agent_checkpoints WHERE stream_id = ?").get(streamId)).toEqual({ count: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_runs WHERE stream_id = ?").get(streamId)).toEqual({ count: 0 })
  })
})

async function execute(
  service: ReturnType<typeof createSqliteWorkGraphService>["service"],
  operationId: string,
  command: Record<string, unknown>,
) {
  return service.execute(owner(), {
    operationId: operation(operationId),
    command: { version: 1, ...command },
  } as never)
}

function resultId(result: Awaited<ReturnType<typeof execute>>, key: string) {
  if (!result.ok || typeof result.value !== "object" || !result.value || Array.isArray(result.value)) {
    throw new Error(`Expected ${key}`)
  }
  return String(result.value[key])
}

function owner(value = "owner"): WorkGraphContext {
  return {
    organizationId: branded("organization"),
    ownerUserId: branded(value),
    actor: { type: "user", id: branded(value) },
    requestId: branded(`request_${value}`),
    access: { mode: "owner" },
  }
}

function operation(value: string) {
  return branded<OperationID>(value)
}

function branded<Type>(value: string) {
  return value as Type
}
