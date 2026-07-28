import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSqliteWorkGraphActivityPorts, createSqliteWorkGraphService } from "@claxedo/workgraph"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import { createLocalWorkGraphMasterRuntime } from "./local-master-runtime"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("local WorkGraph master runtime", () => {
  test("admits one stable lease-less master Session and drains its mailbox", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context: WorkGraphContext = {
      organizationId: "organization" as never,
      ownerUserId: "owner" as never,
      actor: { type: "user", id: "owner" as never },
      requestId: "request" as never,
      access: { mode: "owner" },
    }
    const workgraph = createSqliteWorkGraphService({
      database,
      clock: { now: () => 10_000 },
      execution: {
        provisionOrAdopt: async () => { throw new Error("unused") },
        launch: async () => { throw new Error("unused") },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
        cleanup: async () => undefined,
      },
    })
    const create = await workgraph.service.execute(context, {
      operationId: "create" as never,
      command: {
        version: 1,
        type: "create_stream",
        title: "Release train",
      },
    })
    if (!create.ok) throw new Error(create.error.message)
    const streamId = String((create.value as { streamId: string }).streamId)
    database.prepare("UPDATE wg_v2_streams SET execution_defaults_json = ? WHERE id = ?").run(JSON.stringify({
      environment: { kind: "local_worktree", directory: "/repo" },
      repository: { baseRevision: "HEAD" },
      harness: "opencode",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "high",
      tools: ["bash"],
      connectionIds: ["connection-github"],
    }), streamId)
    const called = await workgraph.service.execute(context, {
      operationId: "call" as never,
      command: { version: 1, type: "call_master", streamId: streamId as never, expectedVersion: 1, message: "Land task one." },
    })
    expect(called.ok).toBe(true)
    const admit = vi.fn(async () => `ses_master_${streamId}`)
    const result = vi.fn(async () => ({ state: "succeeded" as const, summary: "Landed the ready task.", artifacts: ["diff:task-one"] }))
    const provisionOrAdopt = vi.fn(async () => ({
      id: `envelope_${streamId}` as never,
      streamId: streamId as never,
      environment: { kind: "local_worktree" as const, directory: "/repo" },
      repository: { baseRevision: "HEAD" },
      workspaceId: "workspace_master",
    }))
    const runtime = createLocalWorkGraphMasterRuntime({
      database,
      sessions: {
        admit,
        cancel: async () => undefined,
        result,
      },
      workspace: { provisionOrAdopt },
      sessionBindings: createSqliteWorkGraphActivityPorts({ database }).sessionBindings,
      execute: workgraph.service.execute,
      directory: () => "/workgraph/envelope",
      now: () => 10_000,
    })

    await expect(runtime.runDue(context)).resolves.toEqual([
      expect.objectContaining({ status: "admitted", sessionId: `ses_master_${streamId}` }),
    ])
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      runId: `master_${streamId}`,
      sessionId: `ses_master_${streamId}`,
      messageId: expect.stringMatching(/^msg_master_/),
      directory: "/workgraph/envelope",
      workspaceId: "workspace_master",
      prompt: expect.stringMatching(/Land task one\.[\s\S]*Trusted Connection handles:\n- connection-github/),
      profile: expect.objectContaining({
        tools: ["bash", "workgraph_land_candidate", "workgraph_update_stream_notes", "workgraph_notify_owner"],
      }),
    }))
    expect(provisionOrAdopt).toHaveBeenCalledWith(context, {
      streamId,
      environment: { kind: "local_worktree", directory: "/repo" },
      repository: { baseRevision: "HEAD" },
    })
    expect(database.prepare("SELECT status FROM wg_v2_master_mailbox").get()).toEqual({ status: "claimed" })
    expect(database.prepare("SELECT status FROM wg_v2_due_jobs WHERE job_type = 'master_wake' AND subject_id = ?").get(streamId)).toEqual({ status: "running" })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_events WHERE event_type = 'master_audit_recorded'").get()).toEqual({ count: 0 })
    await expect(runtime.runDue(context)).resolves.toEqual([
      expect.objectContaining({ status: "completed", sessionId: `ses_master_${streamId}` }),
    ])
    expect(result).toHaveBeenCalledWith(`ses_master_${streamId}`)
    expect(database.prepare("SELECT status FROM wg_v2_master_mailbox").get()).toEqual({ status: "consumed" })
    expect(database.prepare("SELECT status FROM wg_v2_due_jobs WHERE job_type = 'master_wake' AND subject_id = ?").get(streamId)).toEqual({ status: "completed" })
    expect(database.prepare("SELECT session_id, current_work_item_id FROM wg_v2_session_bindings").get()).toEqual({
      session_id: `ses_master_${streamId}`,
      current_work_item_id: null,
    })
    const audit = database.prepare("SELECT payload_json FROM wg_v2_events WHERE event_type = 'master_audit_recorded'").get() as { payload_json: string }
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      streamId,
      sessionId: `ses_master_${streamId}`,
      wakeTrigger: "mailbox",
      charterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      citedCharterClause: "Open draft pull requests by default.",
      modelVersion: "openai/gpt-5",
      outcome: "succeeded",
      reasoningSummary: "Landed the ready task.",
      resultingDiffs: ["diff:task-one"],
    })
    // Completion surfaces the audit's resulting diffs as the master's durable
    // receipts (Convex parity: `recordMasterTurn` stores `receiptRefs:
    // resulting_diffs` next to "Master is up to date").
    expect(JSON.parse((database.prepare(
      "SELECT master_status_json FROM wg_v2_streams WHERE id = ?",
    ).get(streamId) as { master_status_json: string }).master_status_json)).toMatchObject({
      state: "hibernating",
      message: "Master is up to date",
      receiptRefs: ["diff:task-one"],
    })

    await workgraph.service.execute(context, {
      operationId: "call-failing" as never,
      command: { version: 1, type: "call_master", streamId: streamId as never, expectedVersion: 1, message: "Retry this turn." },
    })
    let current = 20_000
    const failing = createLocalWorkGraphMasterRuntime({
      database,
      sessions: {
        admit: async () => { throw new Error("provider unavailable") },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
      },
      workspace: { provisionOrAdopt },
      sessionBindings: createSqliteWorkGraphActivityPorts({ database }).sessionBindings,
      execute: workgraph.service.execute,
      directory: () => "/workgraph/envelope",
      now: () => current,
    })
    await expect(failing.runDue(context)).resolves.toEqual([{ status: "retrying" }])
    current += 5_000
    await expect(failing.runDue(context)).resolves.toEqual([{ status: "retrying" }])
    current += 5_000
    await expect(failing.runDue(context)).resolves.toEqual([{ status: "attention" }])
    expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs WHERE job_type = 'master_wake' AND subject_id = ?").get(streamId))
      .toEqual({ status: "attention", last_error: "provider unavailable" })
    const status = database.prepare("SELECT master_status_json FROM wg_v2_streams WHERE id = ?").get(streamId) as { master_status_json: string }
    expect(JSON.parse(status.master_status_json)).toMatchObject({ state: "attention", message: expect.stringContaining("provider unavailable") })
  })

  test("preserves a newer dirty flag that arrives while an older master turn completes", async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    const context: WorkGraphContext = {
      organizationId: "organization" as never,
      ownerUserId: "owner" as never,
      actor: { type: "user", id: "owner" as never },
      requestId: "request" as never,
      access: { mode: "owner" },
    }
    const workgraph = createSqliteWorkGraphService({
      database,
      clock: { now: () => 10_000 },
      execution: {
        provisionOrAdopt: async () => { throw new Error("unused") },
        launch: async () => { throw new Error("unused") },
        cancel: async () => undefined,
        result: async () => ({ state: "running" }),
        cleanup: async () => undefined,
      },
    })
    const created = await workgraph.service.execute(context, {
      operationId: "create-race" as never,
      command: {
        version: 1,
        type: "create_stream",
        title: "Serialized settlements",
      },
    })
    if (!created.ok) throw new Error(created.error.message)
    const streamId = String((created.value as { streamId: string }).streamId)
    database.prepare("UPDATE wg_v2_streams SET execution_defaults_json = ? WHERE id = ?").run(JSON.stringify({
      environment: { kind: "local_worktree", directory: "/repo" },
      repository: { baseRevision: "HEAD" },
      harness: "opencode",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "high",
      tools: ["bash"],
      connectionIds: [],
    }), streamId)
    await workgraph.service.execute(context, {
      operationId: "wake-first" as never,
      command: { version: 1, type: "call_master", streamId: streamId as never, expectedVersion: 1, message: "Process settlement one." },
    })
    let settle: (value: { state: "succeeded"; summary: string; artifacts: string[] }) => void = () => undefined
    const result = new Promise<{ state: "succeeded"; summary: string; artifacts: string[] }>((resolve) => { settle = resolve })
    const runtime = createLocalWorkGraphMasterRuntime({
      database,
      sessions: {
        admit: async () => `ses_master_${streamId}`,
        cancel: async () => undefined,
        result: async () => result,
      },
      workspace: {
        provisionOrAdopt: async () => ({
          id: `envelope_${streamId}` as never,
          streamId: streamId as never,
          environment: { kind: "local_worktree", directory: "/repo" },
          repository: { baseRevision: "HEAD" },
          workspaceId: "workspace_master",
        }),
      },
      sessionBindings: createSqliteWorkGraphActivityPorts({ database }).sessionBindings,
      execute: workgraph.service.execute,
      directory: () => "/workgraph/envelope",
      now: () => 10_000,
    })

    await expect(runtime.runDue(context)).resolves.toEqual([
      expect.objectContaining({ status: "admitted", sessionId: `ses_master_${streamId}` }),
    ])
    const monitoring = runtime.runDue(context)
    await expect(workgraph.service.execute(context, {
      operationId: "wake-newer" as never,
      command: { version: 1, type: "call_master", streamId: streamId as never, expectedVersion: 1, message: "Process settlement two." },
    })).resolves.toMatchObject({ ok: true })
    settle({ state: "succeeded", summary: "Processed settlement one.", artifacts: ["diff:first"] })
    await expect(monitoring).resolves.toEqual([
      expect.objectContaining({ status: "completed", superseded: true, sessionId: `ses_master_${streamId}` }),
    ])
    expect(database.prepare(`
      SELECT status, payload_json FROM wg_v2_due_jobs WHERE job_type = 'master_wake' AND subject_id = ?
    `).get(streamId)).toEqual({
      status: "pending",
      payload_json: JSON.stringify({ streamId, trigger: "mailbox" }),
    })
    expect(JSON.parse((database.prepare(
      "SELECT master_status_json FROM wg_v2_streams WHERE id = ?",
    ).get(streamId) as { master_status_json: string }).master_status_json)).toMatchObject({
      state: "pending",
      message: "Master message queued",
    })
    await expect(runtime.runDue(context)).resolves.toEqual([
      expect.objectContaining({ status: "admitted", sessionId: `ses_master_${streamId}` }),
    ])
  })
})
