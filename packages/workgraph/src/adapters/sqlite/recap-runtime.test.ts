import { describe, expect, it } from "vitest"
import BetterSqlite3 from "better-sqlite3"
import { createSqliteWorkGraphService } from "./store"
import { createSqliteRecapRuntime } from "./recap-runtime"
import { createSqliteNotificationStore } from "./notification-store"
import { createNotificationService, NotificationVersionConflictError } from "../../application/notification-service"
import type { ExecutionResult } from "../../ports"

const eightHours = 8 * 60 * 60 * 1000

describe("SQLite durable Recap runtime", () => {
  it("requires an exact Session directory before composing a Session-backed runtime", () => {
    const database = new BetterSqlite3(":memory:")
    try {
      expect(() => createSqliteRecapRuntime({
        database,
        sessions: { admit: async () => "session", result: async () => ({ state: "running" }) },
      })).toThrow("requires an explicit Session directory")
    } finally {
      database.close()
    }
  })

  it("derives empty Stream Recap settings from effective execution with eight quiet hours", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await expect(workgraph.execute(context, {
        operationId: "set_defaults" as never,
        command: {
          version: 1,
          type: "update_workgraph_defaults",
          expectedVersion: 1,
          defaults: {
            execution: generationExecution,
            recap: {
              quietHours: 2,
              model: { providerId: "anthropic", modelId: "claude-root" },
              effort: "low",
            },
          },
        },
      })).resolves.toMatchObject({ ok: true })
      await workgraph.execute(context, {
        operationId: "create_stream" as never,
        command: { version: 1, type: "create_stream", title: "Inherited recap" },
      })
      database.prepare("UPDATE wg_v2_streams SET recap_defaults_json = '{}'").run()
      const stream = database.prepare("SELECT id FROM wg_v2_streams").get() as { id: string }
      const sequence = (database.prepare("SELECT MAX(sequence) AS sequence FROM wg_v2_events").get() as { sequence: number })
        .sequence
      database.prepare(`
        INSERT INTO wg_v2_due_jobs
          (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status,
           payload_json, last_error, created_at, updated_at)
        VALUES (?, ?, 'stale_recap_configuration', ?, 'recap', ?, ?, 'failed', ?, ?, ?, ?)
      `).run(
        context.organizationId,
        context.ownerUserId,
        stream.id,
        `${stream.id}:${sequence}`,
        now,
        JSON.stringify({
          streamId: stream.id,
          fromSequence: 1,
          toSequence: sequence,
          quietSince: now,
          configurationRequirement: { type: "generation", purpose: "recap", scope: { type: "stream", streamId: stream.id } },
        }),
        "Recap requires explicit Stream model, effort, and quietHours configuration",
        now,
        now,
      )
      const runtime = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions: successfulSessions("Inherited recap"), sessionDirectory: "/repo" })

      now += 8 * 60 * 60 * 1000 - 1
      expect(await runtime.scheduleDue(context)).toBe(0)
      expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs WHERE id = 'stale_recap_configuration'").get()).toEqual({
        status: "completed",
        last_error: null,
      })
      now += 1
      expect(await runtime.scheduleDue(context)).toBe(1)
      expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs WHERE id = 'stale_recap_configuration'").get()).toEqual({
        status: "pending",
        last_error: null,
      })
      await expect(runtime.runDue(context)).resolves.toMatchObject({ state: "completed" })
      expect(JSON.parse(
        (database.prepare("SELECT generation_profile_json FROM wg_v2_recaps").get() as { generation_profile_json: string })
          .generation_profile_json,
      )).toEqual({ model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" })
    } finally {
      database.close()
    }
  })

  it("does not apply changed WorkGraph quiet hours to existing explicit Stream Recap configuration", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await workgraph.execute(context, {
        operationId: "create_existing_stream" as never,
        command: { version: 1, type: "create_stream", title: "Existing activity", recap: generationRecap },
      })
      now += 4 * 60 * 60 * 1000
      await workgraph.execute(context, {
        operationId: "lower_quiet_period" as never,
        command: {
          version: 1,
          type: "update_workgraph_defaults",
          expectedVersion: 1,
          defaults: { execution: {}, recap: { quietHours: 2 } },
        },
      })
      const runtime = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions: successfulSessions("Ship Cloud: stream created."), sessionDirectory: "/repo" })
      expect(await runtime.scheduleDue(context)).toBe(0)
      now += 4 * 60 * 60 * 1000
      expect(await runtime.scheduleDue(context)).toBe(1)
    } finally {
      database.close()
    }
  })


  it("schedules after eight quiet hours, claims once, and persists an incremental Recap", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      const created = await workgraph.execute(context, {
        operationId: "create_stream" as never,
        command: { version: 1, type: "create_stream", title: "Ship Cloud", recap: generationRecap },
      })
      expect(created.ok).toBe(true)
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value
        ? String(created.value.streamId)
        : ""
      const runtime = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions: successfulSessions("Ship Cloud: stream created."), sessionDirectory: "/repo" })
      const beforePublication = await workgraph.queries.snapshot.page(context, { limit: 1 })
      const streamChangesBefore = await workgraph.queries.changes.listStream(context, { streamId: streamId as never })
      expect(beforePublication.nextCursor).toBeDefined()
      expect(streamChangesBefore.at(-1)?.cursor).toBeDefined()

      expect(await runtime.scheduleDue(context)).toBe(0)
      now += eightHours
      expect(await runtime.scheduleDue(context)).toBe(1)
      expect(await runtime.scheduleDue(context)).toBe(0)
      await expect(runtime.runDue(context)).resolves.toMatchObject({ state: "completed" })
      await expect(runtime.runDue(context)).resolves.toEqual({ state: "idle" })

      await expect(workgraph.queries.snapshot.page(context, { after: beforePublication.nextCursor!, limit: 1 }))
        .rejects.toMatchObject({ code: "cursor_invalid", reason: "invalidated" })
      const publicationChanges = await workgraph.queries.changes.list(context, { after: beforePublication.snapshotCursor })
      expect(publicationChanges).toEqual([
        expect.objectContaining({
          resource: expect.objectContaining({ type: "recap" }),
          event: expect.objectContaining({
            type: "recap_published",
            payload: expect.objectContaining({ streamId }),
          }),
        }),
      ])
      expect(publicationChanges[0]?.event).not.toHaveProperty("streamId")
      await expect(workgraph.queries.changes.listStream(context, {
        streamId: streamId as never,
        after: streamChangesBefore.at(-1)!.cursor,
      })).resolves.toHaveLength(1)
      expect(await runtime.scheduleDue(context)).toBe(0)

      const snapshot = await workgraph.queries.snapshot.page(context, { limit: 50 })
      expect(snapshot.records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          recordType: "recap",
          streamId,
          activityRange: { fromSequence: 1, toSequence: 1, quietSince: 1_000 },
          summary: expect.stringContaining("Ship Cloud"),
          generation: expect.objectContaining({ state: "succeeded" }),
        }),
      ]))
      expect(database.prepare("SELECT status FROM wg_v2_due_jobs").get()).toEqual({ status: "completed" })
    } finally {
      database.close()
    }
  })

  it("keeps a transient provider failure durable, then retries through a successful ordinary Session without duplicating Recaps", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      await workgraph.execute(context, {
        operationId: "create_stream" as never,
        command: { version: 1, type: "create_stream", title: "Recover", recap: generationRecap },
      })
      now += eightHours
      let attempt = 0
      const sessions = {
        async admit(input: { sessionId?: string }) { return String(input.sessionId) },
        async result() {
          attempt += 1
          if (attempt === 1) return { state: "failed" as const, message: "provider unavailable" }
          return { state: "succeeded" as const, summary: JSON.stringify({ summary: "Recovered", actionableReferences: [] }), artifacts: [] }
        },
      }
      const first = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions, sessionDirectory: "/repo" })
      await first.scheduleDue(context)
      await expect(first.runDue(context))
        .resolves.toMatchObject({ state: "failed" })
      expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs").get())
        .toEqual({ status: "failed", last_error: "Recap Session failed: provider unavailable" })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 0 })

      now += 60_000
      const second = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-b", sessions, sessionDirectory: "/repo" })
      await expect(second.runDue(context)).resolves.toMatchObject({ state: "completed" })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it("publishes exactly one owner-scoped notification atomically with an actionable Recap and reads it with CAS", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      const created = await workgraph.execute(context, {
        operationId: "create_actionable_stream" as never,
        command: { version: 1, type: "create_stream", title: "Needs approval", recap: generationRecap },
      })
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value
        ? String(created.value.streamId)
        : ""
      now += eightHours
      const runtime = createSqliteRecapRuntime({
        database,
        clock: { now: () => now },
        workerId: "worker-a",
        sessionDirectory: "/repo",
        sessions: successfulSessions("Approval remains.", [{ type: "stream", id: streamId }]),
      })
      await runtime.scheduleDue(context)
      await expect(runtime.runDue(context)).resolves.toMatchObject({ state: "completed" })
      await expect(runtime.runDue(context)).resolves.toEqual({ state: "idle" })

      const notifications = createNotificationService(createSqliteNotificationStore(database))
      const page = await notifications.list(context, { state: "unread" })
      expect(page).toMatchObject({
        notifications: [{
          ownerUserId: "owner",
          version: 1,
          kind: "actionable_recap",
          state: "unread",
          streamId,
        }],
        hasMore: false,
      })
      expect(page.notifications[0]?.recapId).toMatch(/^recap_/)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 1 })
      await expect(createNotificationService(createSqliteNotificationStore(database)).list({ ...context, ownerUserId: "other" as never }))
        .resolves.toMatchObject({ notifications: [] })

      const notification = page.notifications[0]!
      await expect(notifications.markRead(context, { id: notification.id, expectedVersion: 1 })).resolves.toMatchObject({
        state: "read",
        version: 2,
        readAt: expect.any(Number),
      })
      await expect(notifications.markRead(context, { id: notification.id, expectedVersion: 1 }))
        .rejects.toBeInstanceOf(NotificationVersionConflictError)
    } finally {
      database.close()
    }
  })

  it("marks an actionable notification read without consulting another organization for the same owner and Recap ID", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const context = owner()
      const other = { ...context, organizationId: "other_organization" as never }
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities }).service
      const first = await workgraph.execute(context, {
        operationId: "create_first_collision_stream" as never,
        command: { version: 1, type: "create_stream", title: "First organization" },
      })
      const second = await workgraph.execute(other, {
        operationId: "create_second_collision_stream" as never,
        command: { version: 1, type: "create_stream", title: "Second organization" },
      })
      const firstStream = first.ok && first.value && typeof first.value === "object" && "streamId" in first.value
        ? String(first.value.streamId)
        : ""
      const secondStream = second.ok && second.value && typeof second.value === "object" && "streamId" in second.value
        ? String(second.value.streamId)
        : ""
      const insertRecap = database.prepare(`
        INSERT INTO wg_v2_recaps
          (organization_id, owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since, summary,
           actionable_references_json, generation_profile_json, provenance_json, generation_result_json, created_at)
        VALUES (?, ?, 'recap_collision', ?, 1, 1, 1000, 'Collision', '[]', ?, ?, ?, 1000)
      `)
      insertRecap.run(
        context.organizationId,
        context.ownerUserId,
        firstStream,
        JSON.stringify({ model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" }),
        JSON.stringify({ actor: context.actor }),
        JSON.stringify({ state: "succeeded", generatedAt: 1_000, method: "agent_session", sessionId: "session_first" }),
      )
      insertRecap.run(
        other.organizationId,
        other.ownerUserId,
        secondStream,
        JSON.stringify({ model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" }),
        JSON.stringify({ actor: other.actor }),
        JSON.stringify({ state: "succeeded", method: "deterministic_fallback" }),
      )
      database.prepare(`
        INSERT INTO wg_v2_notifications
          (organization_id, owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
        VALUES (?, ?, 'notification_collision', 'actionable_recap', 'unread', ?, 'recap_collision', 1000, 1000)
      `).run(context.organizationId, context.ownerUserId, firstStream)

      await expect(createNotificationService(createSqliteNotificationStore(database)).markRead(context, {
        id: "notification_collision" as never,
        expectedVersion: 1,
      })).resolves.toMatchObject({ state: "read", version: 2 })
    } finally {
      database.close()
    }
  })

  it("does not publish a notification for a non-actionable Recap", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      await workgraph.execute(context, {
        operationId: "create_informational_stream" as never,
        command: { version: 1, type: "create_stream", title: "Informational", recap: generationRecap },
      })
      now += eightHours
      const runtime = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions: successfulSessions("Everything is current."), sessionDirectory: "/repo" })
      await runtime.scheduleDue(context)
      await runtime.runDue(context)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("uses a durable Session identity, exact activity range, prior Recap, and inherited Recap profile", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    const admissions: Array<Record<string, unknown>> = []
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await workgraph.execute(context, {
        operationId: "recap_defaults" as never,
        command: {
          version: 1,
          type: "update_workgraph_defaults",
          expectedVersion: 1,
          defaults: { execution: generationExecution, recap: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" } },
        },
      })
      const created = await workgraph.execute(context, {
        operationId: "session_stream" as never,
        command: { version: 1, type: "create_stream", title: "Session recap", recap: generationRecap },
      })
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value
        ? String(created.value.streamId)
        : ""
      const sessions = {
        async admit(input: Record<string, unknown>) {
          admissions.push(input)
          return String(input.sessionId)
        },
        async result() {
          return { state: "succeeded" as const, summary: JSON.stringify({ summary: "The first range needs attention.", actionableReferences: [{ type: "stream", id: streamId }] }), artifacts: [] }
        },
      }
      now += eightHours
      const first = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-a", sessions, sessionDirectory: "/repo" })
      await first.scheduleDue(context)
      await expect(first.runDue(context)).resolves.toMatchObject({ state: "completed" })
      const firstRecap = database.prepare("SELECT id FROM wg_v2_recaps").get() as { id: string }

      await workgraph.execute(context, {
        operationId: "second_activity" as never,
        command: { version: 1, type: "update_stream", streamId: streamId as never, expectedVersion: 1, description: "Second range" },
      })
      now += eightHours
      await first.scheduleDue(context)
      await expect(first.runDue(context)).resolves.toMatchObject({ state: "completed" })

      expect(admissions).toHaveLength(2)
      expect(admissions[0]).toMatchObject({
        directory: "/repo",
        profile: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high", tools: [] },
      })
      expect(String(admissions[0]?.prompt)).toContain("Activity range: 1-1")
      expect(String(admissions[0]?.prompt)).toContain("Previous recap: none")
      expect(String(admissions[1]?.prompt)).toContain("Activity range: 2-2")
      expect(String(admissions[1]?.prompt)).toContain(`\"id\":\"${firstRecap.id}\"`)
      const generations = database.prepare("SELECT generation_result_json FROM wg_v2_recaps ORDER BY activity_end_sequence").all() as Array<{ generation_result_json: string }>
      expect(generations.map((row) => JSON.parse(row.generation_result_json))).toEqual([
        expect.objectContaining({ method: "agent_session", sessionId: admissions[0]?.sessionId }),
        expect.objectContaining({ method: "agent_session", sessionId: admissions[1]?.sessionId }),
      ])
      const latestRecap = database.prepare("SELECT id FROM wg_v2_recaps ORDER BY activity_end_sequence DESC LIMIT 1").get() as { id: string }
      await expect(workgraph.query(context, "streams", "read", { streamId: streamId as never })).resolves.toMatchObject({
        activity: { lastRecapId: latestRecap.id },
      })
    } finally {
      database.close()
    }
  })

  it("retries settled Session and parse failures with new identities before publishing one valid Recap", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    const sessionIds: string[] = []
    let result = 0
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      await workgraph.execute(context, { operationId: "retry_stream" as never, command: { version: 1, type: "create_stream", title: "Retry Session", recap: generationRecap } })
      now += eightHours
      const runtime = () => createSqliteRecapRuntime({
        database,
        clock: { now: () => now },
        workerId: `worker-${result}`,
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) { sessionIds.push(String(input.sessionId)); return String(input.sessionId) },
          async result() {
            result += 1
            if (result === 1) return { state: "failed" as const, message: "provider unavailable" }
            if (result === 2) return { state: "succeeded" as const, summary: "not json", artifacts: [] }
            return { state: "succeeded" as const, summary: JSON.stringify({ summary: "Recovered", actionableReferences: [] }), artifacts: [] }
          },
        },
      })
      const first = runtime()
      await first.scheduleDue(context)
      const failed = await first.runDue(context)
      expect(failed.state).toBe("failed")
      expect(failed.state === "failed" && failed.error).toEqual(expect.objectContaining({ message: "Recap Session failed: provider unavailable" }))
      now += 60_000
      const rejected = await runtime().runDue(context)
      expect(rejected.state).toBe("failed")
      expect(rejected.state === "failed" && rejected.error).toEqual(expect.objectContaining({ message: expect.stringContaining("Unexpected token") }))
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 0 })
      now += 60_000
      await expect(runtime().runDue(context)).resolves.toMatchObject({ state: "completed", output: { summary: "Recovered" } })
      expect(new Set(sessionIds).size).toBe(3)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("adopts the same pending Session after worker restart without duplicating its Recap or notification", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    let resultReads = 0
    const admissions: string[] = []
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      const created = await workgraph.execute(context, { operationId: "restart_stream" as never, command: { version: 1, type: "create_stream", title: "Restart", recap: generationRecap } })
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value ? String(created.value.streamId) : ""
      now += eightHours
      const sessions = {
        async admit(input: { sessionId?: string }) { admissions.push(String(input.sessionId)); return String(input.sessionId) },
        async result() {
          resultReads += 1
          if (resultReads === 1) return { state: "running" as const }
          return { state: "succeeded" as const, summary: JSON.stringify({ summary: "Recovered after restart", actionableReferences: [{ type: "stream", id: streamId }] }), artifacts: [] }
        },
      }
      const first = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-before-restart", sessions, sessionDirectory: "/repo" })
      await first.scheduleDue(context)
      await expect(first.runDue(context)).resolves.toMatchObject({ state: "running" })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 0 })

      await expect(workgraph.execute(context, {
        operationId: "change_generation_after_admission" as never,
        command: {
          version: 1,
          type: "update_workgraph_defaults",
          expectedVersion: 2,
          defaults: {
            execution: {
              ...generationExecution,
              model: { providerId: "openai", modelId: "gpt-5.1" },
              effort: "maximum",
            },
            recap: {},
          },
        },
      })).resolves.toMatchObject({ ok: true })

      now += 5 * 60 * 1000
      const restarted = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "worker-after-restart", sessions, sessionDirectory: "/repo" })
      await expect(restarted.runDue(context)).resolves.toMatchObject({ state: "completed" })
      await expect(restarted.runDue(context)).resolves.toEqual({ state: "idle" })
      expect(admissions).toHaveLength(1)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 1 })
      expect(JSON.parse(
        (database.prepare("SELECT generation_profile_json FROM wg_v2_recaps").get() as { generation_profile_json: string })
          .generation_profile_json,
      )).toEqual({ model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" })
    } finally {
      database.close()
    }
  })

  it("reconciles an indeterminate admission with the same durable Session identity instead of publishing fallback", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    const admissions: string[] = []
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      await workgraph.execute(context, { operationId: "indeterminate_stream" as never, command: { version: 1, type: "create_stream", title: "Reconcile admission", recap: generationRecap } })
      now += eightHours
      const sessions = {
        classifyAdmissionError: () => "indeterminate" as const,
        async admit(input: { sessionId?: string }) {
          admissions.push(String(input.sessionId))
          if (admissions.length === 1) throw new Error("response lost after durable admission")
          return String(input.sessionId)
        },
        async result() {
          return { state: "succeeded" as const, summary: JSON.stringify({ summary: "Reconciled", actionableReferences: [] }), artifacts: [] }
        },
      }
      const first = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "reconcile-before-restart", sessions, sessionDirectory: "/repo" })
      await first.scheduleDue(context)
      await expect(first.runDue(context)).resolves.toMatchObject({ state: "running" })
      now += 5 * 60 * 1000
      const restarted = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "reconcile-after-restart", sessions, sessionDirectory: "/repo" })
      await expect(restarted.runDue(context)).resolves.toMatchObject({
        state: "completed",
        output: { summary: "Reconciled", generation: { method: "agent_session", sessionId: admissions[0] } },
      })
      expect(admissions).toHaveLength(2)
      expect(new Set(admissions).size).toBe(1)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
      expect(JSON.parse((database.prepare("SELECT generation_result_json FROM wg_v2_recaps").get() as { generation_result_json: string }).generation_result_json))
        .toMatchObject({ method: "agent_session", sessionId: admissions[0] })
    } finally {
      database.close()
    }
  })

  it("fences a stale worker that finishes after another worker publishes the adopted Session", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    let releaseFirst!: (result: ExecutionResult) => void
    let signalFirstRead!: () => void
    const firstResult = new Promise<ExecutionResult>((resolve) => { releaseFirst = resolve })
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve })
    let resultReads = 0
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      const created = await workgraph.execute(context, { operationId: "stale_worker_stream" as never, command: { version: 1, type: "create_stream", title: "Lease fencing", recap: generationRecap } })
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value ? String(created.value.streamId) : ""
      const succeeded = {
        state: "succeeded" as const,
        summary: JSON.stringify({ summary: "One publication", actionableReferences: [{ type: "stream", id: streamId }] }),
        artifacts: [],
      }
      const sessions = {
        async admit(input: { sessionId?: string }) { return String(input.sessionId) },
        async result() {
          resultReads += 1
          if (resultReads === 1) {
            signalFirstRead()
            return firstResult
          }
          return succeeded
        },
      }
      now += eightHours
      const stale = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "stale-worker", sessions, sessionDirectory: "/repo" })
      await stale.scheduleDue(context)
      const staleRun = stale.runDue(context)
      await firstRead

      now += 5 * 60 * 1000
      const current = createSqliteRecapRuntime({ database, clock: { now: () => now }, workerId: "current-worker", sessions, sessionDirectory: "/repo" })
      await expect(current.runDue(context)).resolves.toMatchObject({ state: "completed" })
      releaseFirst(succeeded)
      await expect(staleRun).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({ message: "Recap job is not durably claimed" }),
      })

      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 1 })
      expect(database.prepare("SELECT status FROM wg_v2_due_jobs").get()).toEqual({ status: "completed" })
    } finally {
      database.close()
    }
  })

  it("projects stored non-Session Recaps as non-authoritative without changing their summary or exposing actionability", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => 1_000 } }).service
      const created = await workgraph.execute(context, { operationId: "legacy_stream" as never, command: { version: 1, type: "create_stream", title: "Legacy", recap: generationRecap } })
      const streamId = created.ok && created.value && typeof created.value === "object" && "streamId" in created.value ? String(created.value.streamId) : ""
      database.prepare(`
        INSERT INTO wg_v2_recaps
          (organization_id, owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since, summary,
           actionable_references_json, generation_profile_json, provenance_json, generation_result_json, created_at)
        VALUES (?, ?, 'recap_legacy', ?, 1, 1, 1000, 'Original stored summary', ?, ?, ?, ?, 2000)
      `).run(
        context.organizationId,
        context.ownerUserId,
        streamId,
        JSON.stringify([{ type: "stream", id: streamId }]),
        JSON.stringify({ model: { providerId: "claxedo", modelId: "activity-recap-v1" }, effort: "medium" }),
        JSON.stringify({ actor: context.actor }),
        JSON.stringify({ state: "succeeded", generatedAt: 2_000, method: "deterministic_fallback" }),
      )
      database.prepare(`
        INSERT INTO wg_v2_recaps
          (organization_id, owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since, summary,
           actionable_references_json, generation_profile_json, provenance_json, generation_result_json, created_at)
        VALUES (?, ?, 'recap_incomplete', ?, 2, 2, 1000, 'Incomplete legacy failure', '[]', '{}', ?, '{"state":"failed"}', 2001)
      `).run(context.organizationId, context.ownerUserId, streamId, JSON.stringify({ actor: context.actor }))
      database.prepare(`
        INSERT INTO wg_v2_notifications
          (organization_id, owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
        VALUES (?, ?, 'notification_legacy', 'actionable_recap', 'unread', ?, 'recap_legacy', 2000, 2000)
      `).run(context.organizationId, context.ownerUserId, streamId)

      const snapshot = await workgraph.queries.snapshot.page(context, { limit: 20 })
      expect(snapshot).toMatchObject({
        records: expect.arrayContaining([expect.objectContaining({
          recordType: "recap",
          id: "recap_legacy",
          summary: "Original stored summary",
          actionableReferences: [],
          generation: expect.objectContaining({
            state: "invalidated",
            source: "retired_non_session_generation",
            reason: "Retired deterministic Recap fallback is non-authoritative",
          }),
        })]),
      })
      const recap = snapshot.records.find((record) => record.recordType === "recap" && record.id === "recap_legacy")
      if (!recap || recap.recordType !== "recap") throw new Error("Expected the invalidated legacy Recap")
      expect(recap.generation).not.toHaveProperty("invalidatedAt")
      expect(snapshot.records).toContainEqual(expect.objectContaining({
        recordType: "recap",
        id: "recap_incomplete",
        summary: "Incomplete legacy failure",
        actionableReferences: [],
        generation: {
          state: "invalidated",
          reason: "Incomplete legacy Recap generation metadata is non-authoritative",
          source: "retired_incomplete_generation",
        },
      }))
      await expect(createNotificationService(createSqliteNotificationStore(database)).list(context))
        .resolves.toMatchObject({ notifications: [] })
      expect(database.prepare("SELECT summary, actionable_references_json FROM wg_v2_recaps WHERE id = 'recap_legacy'").get())
        .toEqual({ summary: "Original stored summary", actionable_references_json: JSON.stringify([{ type: "stream", id: streamId }]) })
    } finally {
      database.close()
    }
  })

  it("does not admit a Recap Session until the required generation profile is explicitly configured", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    let admissions = 0
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      const created = await workgraph.execute(context, {
        operationId: "unconfigured_stream" as never,
        command: { version: 1, type: "create_stream", title: "Requires configuration" },
      })
      if (!created.ok || !created.value || typeof created.value !== "object" || !("streamId" in created.value)) {
        throw new Error("Expected unconfigured Stream creation")
      }
      const streamId = String(created.value.streamId) as never
      now += eightHours
      const runtime = createSqliteRecapRuntime({
        database,
        clock: { now: () => now },
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) {
            admissions += 1
            return String(input.sessionId)
          },
          async result() {
            return {
              state: "succeeded" as const,
              summary: JSON.stringify({ summary: "Configured", actionableReferences: [] }),
              artifacts: [],
            }
          },
        },
      })
      await runtime.scheduleDue(context)

      await expect(runtime.runDue(context)).resolves.toEqual({ state: "idle" })
      expect(admissions).toBe(0)
      expect(database.prepare("SELECT status, CAST(due_at AS REAL) AS due_at, last_error FROM wg_v2_due_jobs").get()).toEqual({
        status: "failed",
        due_at: Number.MAX_SAFE_INTEGER,
        last_error: "Recap requires explicit Stream model, effort, and quietHours configuration",
      })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 0 })
      await expect(workgraph.query(context, "attention", "list", { limit: 10 })).resolves.toMatchObject({
        total: 1,
        items: [{
          kind: "configuration_required",
          requirement: {
            type: "generation",
            purpose: "recap",
            scope: { type: "stream", streamId: expect.any(String) },
          },
        }],
      })

      await configureGeneration(workgraph, context)
      await expect(workgraph.execute(context, {
        operationId: "configure_stream_recap" as never,
        command: {
          version: 1,
          type: "update_stream",
          streamId,
          expectedVersion: 1,
          recap: generationRecap,
        },
      })).resolves.toMatchObject({ ok: true })
      now += eightHours
      expect(await runtime.scheduleDue(context)).toBe(1)
      await expect(runtime.runDue(context)).resolves.toMatchObject({ state: "completed" })
      expect(admissions).toBe(1)
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it("exhausts unavailable Session admission as durable attention without publishing a Recap or notification", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const context = owner()
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      await configureGeneration(workgraph, context)
      await workgraph.execute(context, { operationId: "unavailable_stream" as never, command: { version: 1, type: "create_stream", title: "Unavailable runtime", recap: generationRecap } })
      now += eightHours
      const runtime = createSqliteRecapRuntime({
        database,
        clock: { now: () => now },
        sessionDirectory: "/repo",
        sessions: {
          classifyAdmissionError: () => "unavailable" as const,
          async admit() { throw new Error("Session runtime unavailable") },
          async result() { throw new Error("result must not be read") },
        },
      })
      await runtime.scheduleDue(context)
      for (const expectedStatus of ["failed", "failed", "attention"]) {
        const result = await runtime.runDue(context)
        expect(result).toMatchObject({ state: expectedStatus, error: expect.objectContaining({ message: "Session runtime unavailable" }) })
        expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs").get())
          .toEqual({ status: expectedStatus, last_error: "Session runtime unavailable" })
        now += 60_000
      }
      await expect(runtime.runDue(context)).resolves.toEqual({ state: "idle" })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_recaps").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_notifications").get()).toEqual({ count: 0 })
      await expect(workgraph.queries.snapshot.page(context, { limit: 20 })).resolves.toMatchObject({
        records: expect.arrayContaining([expect.objectContaining({
          recordType: "stream",
          memory: expect.objectContaining({ summary: "Recap generation needs attention", attention: expect.objectContaining({ type: "recap_failed", reason: "Session runtime unavailable" }) }),
        })]),
      })
    } finally {
      database.close()
    }
  })
})

function owner() {
  return {
    organizationId: "organization" as never,
    ownerUserId: "owner" as never,
    actor: { type: "system" as const, id: "recap_worker" as never },
    requestId: "recap_request" as never,
    access: { mode: "owner" as const },
  }
}

async function configureGeneration(
  workgraph: ReturnType<typeof createSqliteWorkGraphService>["service"],
  context: ReturnType<typeof owner>,
) {
  const result = await workgraph.execute(context, {
    operationId: "configure_generation" as never,
    command: {
      version: 1,
      type: "update_workgraph_defaults",
      expectedVersion: 1,
      defaults: { execution: generationExecution, recap: {} },
    },
  })
  if (!result.ok) throw new Error(`Could not configure generation: ${result.error.message}`)
}

const generationExecution = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "dev" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["read"],
  connectionIds: [],
}

const generationRecap = {
  quietHours: 8,
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
}

function successfulSessions(summary: string, actionableReferences: readonly { type: string; id: string }[] = []) {
  return {
    async admit(input: { sessionId?: string }) { return String(input.sessionId) },
    async result() {
      return { state: "succeeded" as const, summary: JSON.stringify({ summary, actionableReferences }), artifacts: [] }
    },
  }
}
import { testExecutionCapabilities } from "../../../test/test-execution-capabilities"
