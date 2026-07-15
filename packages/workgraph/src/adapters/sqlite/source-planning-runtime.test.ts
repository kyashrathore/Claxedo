import { createHash } from "node:crypto"
import BetterSqlite3 from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { readChangeCursor, type AdmissionAgentPlan, type WorkGraphContext, type WorkSourceRevisionRef } from "../../contracts"
import { createSqliteWorkGraphService } from "./store"
import { createSqliteSourcePlanningRuntime } from "./source-planning-runtime"

describe("SQLite durable source planning runtime", () => {
  it("requires an exact Session directory before composing a Session-backed runtime", () => {
    const database = new BetterSqlite3(":memory:")
    try {
      expect(() => createSqliteSourcePlanningRuntime({
        database,
        sessions: { admit: async () => "session", result: async () => ({ state: "running" }) },
      })).toThrow("requires an explicit Session directory")
    } finally {
      database.close()
    }
  })

  it("surfaces incomplete WorkGraph generation configuration without admitting a Session", async () => {
    const database = new BetterSqlite3(":memory:")
    let admissions = 0
    try {
      const workgraph = service(database)
      const source = await createSource(workgraph, false)
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        sessionDirectory: "/repo",
        sessions: {
          async admit() {
            admissions += 1
            throw new Error("Session admission must not be attempted")
          },
          async result() {
            throw new Error("Session result must not be read")
          },
        },
      })

      await expect(runtime.runDue(owner())).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("Source planning generation profile is incomplete"),
        }),
      })
      expect(admissions).toBe(0)
      expect(database.prepare("SELECT status FROM wg_v2_due_jobs WHERE subject_id = ?").get(source.proposalId))
        .toEqual({ status: "failed" })
      expect(await admission(database, source.proposalId)).toMatchObject({ state: "planning_failed" })
      await expect(workgraph.query(owner(), "attention", "list", { limit: 10 })).resolves.toMatchObject({
        total: 1,
        items: [{
          kind: "configuration_required",
          requirement: {
            type: "generation",
            purpose: "source_planning",
            scope: { type: "workgraph" },
          },
        }],
      })
    } finally {
      database.close()
    }
  })

  it("resumes one idempotent Session and publishes a strict agent plan", async () => {
    const database = new BetterSqlite3(":memory:")
    let state: "running" | "succeeded" = "running"
    const admissions: Array<Record<string, unknown>> = []
    try {
      const workgraph = service(database)
      const source = await createSource(workgraph)
      const baseline = await workgraph.query(owner(), "snapshot", "page", { limit: 50 }) as { snapshotCursor: string }
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        workerId: "planner-a",
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) {
            admissions.push(input)
            return String(input.sessionId)
          },
          async result() {
            if (state === "running") return { state: "running" }
            return {
              state: "succeeded",
              summary: JSON.stringify(plan(source.ref)),
              artifacts: [],
            }
          },
        },
      })
      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "running" })
      expect(admissions).toEqual([expect.objectContaining({
        attemptId: expect.stringMatching(/^source_plan_job_/),
        sessionId: expect.stringMatching(/^ses_workgraph_source_plan_job_.*_1$/),
        directory: "/repo",
        prompt: expect.stringContaining(JSON.stringify(source.ref)),
      })])
      state = "succeeded"
      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "completed", sessionId: admissions[0]?.sessionId })
      expect(admissions).toHaveLength(1)
      const proposal = await admission(database, source.proposalId)
      expect(proposal).toMatchObject({
        state: "proposed",
        version: 3,
        generation: { method: "agent_session", sessionId: admissions[0]?.sessionId },
        proposedOutcomes: [expect.objectContaining({ title: "Cloud is shipped", execution: { effort: "high" } })],
        proposedWorkItems: [expect.objectContaining({
          title: "Deploy cloud",
          execution: { effort: "medium" },
          completionContract: expect.objectContaining({ version: 1 }),
        })],
      })
      const changes = await workgraph.query(owner(), "changes", "list", { after: baseline.snapshotCursor as never })
      const baselinePosition = readChangeCursor(baseline.snapshotCursor, owner().organizationId, owner().ownerUserId)
      expect(changes.map((change) => readChangeCursor(change.cursor, owner().organizationId, owner().ownerUserId)))
        .toEqual([baselinePosition + 1, baselinePosition + 2])
      expect(changes).toEqual([
        expect.objectContaining({
          resource: { type: "admission_proposal", id: source.proposalId },
          event: expect.objectContaining({
            type: "admission_proposal_updated",
            payload: expect.objectContaining({
              proposalId: source.proposalId,
              version: 2,
              generation: expect.objectContaining({ method: "planning", attempt: 1 }),
            }),
          }),
        }),
        expect.objectContaining({
          resource: { type: "admission_proposal", id: source.proposalId },
          event: expect.objectContaining({
            type: "admission_proposal_updated",
            payload: expect.objectContaining({
              proposalId: source.proposalId,
              version: 3,
              generation: { method: "agent_session", sessionId: admissions[0]?.sessionId },
            }),
          }),
        }),
      ])
      const changesBefore = (database.prepare("SELECT COUNT(*) AS count FROM wg_v2_changes").get() as { count: number }).count
      await expect(workgraph.execute(owner(), {
        operationId: "stale-confirmation" as never,
        command: {
          version: 1,
          type: "confirm_admission",
          proposalId: source.proposalId as never,
          expectedVersion: 1,
          source: source.ref,
          selection: { mode: "create", streamTitle: "Stale fallback" },
          outcomes: [{ proposalKey: "stale-outcome", title: "Stale outcome", successCriteria: ["Never created"] }],
          workItems: [{
            proposalKey: "stale-item",
            outcomeProposalKey: "stale-outcome",
            title: "Stale item",
            completionContract: { version: 1, mode: "all", requirements: [{ id: "stale" as never, kind: "owner_confirmation", description: "Never created" }] },
          }],
        },
      })).resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_outcomes").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_record_source_revisions").get()).toEqual({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_changes").get()).toEqual({ count: changesBefore })
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "proposed",
        version: 3,
        generation: { method: "agent_session", sessionId: admissions[0]?.sessionId },
      })
      expect(database.prepare("SELECT status FROM wg_v2_due_jobs WHERE subject_id = ?").get(source.proposalId)).toEqual({ status: "completed" })
    } finally {
      database.close()
    }
  })

  it("publishes an exact existing-Stream placement when bounded planning evidence names a target", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const workgraph = service(database)
      const target = await workgraph.execute(owner(), {
        operationId: "target-stream" as never,
        command: { version: 1, type: "create_stream", title: "Existing launch Stream" },
      })
      if (!target.ok) throw new Error("target Stream failed")
      const targetStreamId = (target.value as { streamId: string }).streamId
      const source = await createSource(workgraph, true, targetStreamId)
      const output = plan(source.ref)
      output.suggestedPlacement = { mode: "existing", streamId: targetStreamId as never }
      let prompt = ""
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) { prompt = input.prompt; return String(input.sessionId) },
          async result() { return { state: "succeeded", summary: JSON.stringify(output), artifacts: [] } },
        },
      })

      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "completed" })
      expect(prompt).toContain(`"targetStreamId":"${targetStreamId}"`)
      expect(prompt).toContain("suggestedPlacement must be existing with that exact Stream ID")
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "proposed",
        suggestedPlacement: { mode: "existing", streamId: targetStreamId },
      })
    } finally {
      database.close()
    }
  })

  it.each([
    ["a new Stream", { mode: "new_stream", streamTitle: "Incorrect replacement" }],
    ["a different Stream", { mode: "existing", streamId: "stream_different" }],
  ] as const)("rejects %s when bounded planning evidence names an exact target", async (_label, suggestedPlacement) => {
    const database = new BetterSqlite3(":memory:")
    try {
      const workgraph = service(database)
      const target = await workgraph.execute(owner(), {
        operationId: "target-stream" as never,
        command: { version: 1, type: "create_stream", title: "Existing launch Stream" },
      })
      if (!target.ok) throw new Error("target Stream failed")
      const targetStreamId = (target.value as { streamId: string }).streamId
      const source = await createSource(workgraph, true, targetStreamId)
      const output = plan(source.ref)
      output.suggestedPlacement = suggestedPlacement as AdmissionAgentPlan["suggestedPlacement"]
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) { return String(input.sessionId) },
          async result() { return { state: "succeeded", summary: JSON.stringify(output), artifacts: [] } },
        },
      })

      await expect(runtime.runDue(owner())).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({ message: "Source planning result did not honor the exact target Stream" }),
      })
      const failed = await admission(database, source.proposalId)
      expect(failed).toMatchObject({
        state: "planning_failed",
        generation: expect.objectContaining({
          method: "planning_failed",
          reason: "Source planning result did not honor the exact target Stream",
        }),
      })
      expect(failed).not.toHaveProperty("suggestedPlacement")
      expect(failed).not.toHaveProperty("proposedOutcomes")
      expect(database.prepare("SELECT status, last_error FROM wg_v2_due_jobs WHERE subject_id = ?").get(source.proposalId)).toEqual({
        status: "failed",
        last_error: "Source planning result did not honor the exact target Stream",
      })
    } finally {
      database.close()
    }
  })

  it("fences a settled Session when the exact source revision was revised", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const workgraph = service(database)
      const source = await createSource(workgraph)
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        workerId: "planner-a",
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) { return String(input.sessionId) },
          async result() { return { state: "running" } },
        },
      })
      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "running" })
      await workgraph.execute(owner(), {
        operationId: "revise" as never,
        command: { version: 1, type: "revise_work_source", workSourceId: source.ref.workSourceId, expectedRevisionId: source.ref.revisionId, content: "Revised plan" },
      })
      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "stale" })
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "planning_failed",
        version: 3,
        generation: {
          method: "planning_failed",
          attempt: 1,
          reason: "Source revision or proposal is no longer current",
          retryable: false,
          failedAt: expect.any(Number),
        },
      })
      expect(database.prepare("SELECT status FROM wg_v2_due_jobs WHERE subject_id = ?").get(source.proposalId)).toEqual({ status: "cancelled" })
    } finally {
      database.close()
    }
  })

  it("reconciles a lost admission response after restart with the same Session and message identity", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    const identities: Array<{ attemptId: string; sessionId?: string }> = []
    try {
      const source = await createSource(createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service)
      const sessions = {
        classifyAdmissionError: () => "indeterminate" as const,
        async admit(input: { attemptId: string; sessionId?: string }) {
          identities.push({ attemptId: input.attemptId, sessionId: input.sessionId })
          if (identities.length === 1) throw new Error("response lost after durable admission")
          return String(input.sessionId)
        },
        async result() {
          return { state: "succeeded" as const, summary: JSON.stringify(plan(source.ref)), artifacts: [] }
        },
      }
      const beforeRestart = createSqliteSourcePlanningRuntime({ database, clock: { now: () => now }, workerId: "planner-before", sessions, sessionDirectory: "/repo" })
      await expect(beforeRestart.runDue(owner())).resolves.toMatchObject({ state: "running" })
      const durable = JSON.parse((database.prepare("SELECT payload_json FROM wg_v2_due_jobs").get() as { payload_json: string }).payload_json)
      expect(durable).toMatchObject({ sessionId: identities[0]?.sessionId, sessionAdmissionConfirmed: false })

      now += 5 * 60 * 1000
      const afterRestart = createSqliteSourcePlanningRuntime({ database, clock: { now: () => now }, workerId: "planner-after", sessions, sessionDirectory: "/repo" })
      await expect(afterRestart.runDue(owner())).resolves.toMatchObject({ state: "completed", sessionId: identities[0]?.sessionId })
      expect(identities).toEqual([identities[0], identities[0]])
      expect(await admission(database, source.proposalId)).toMatchObject({ generation: { method: "agent_session", sessionId: identities[0]?.sessionId } })
    } finally {
      database.close()
    }
  })

  it("bounds unavailable Session planning at three attempts, then permits an explicit version-fenced retry", async () => {
    const database = new BetterSqlite3(":memory:")
    let now = 1_000
    try {
      const workgraph = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities, clock: { now: () => now } }).service
      const source = await createSource(workgraph)
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        clock: { now: () => now },
        sessionDirectory: "/repo",
        sessions: {
          classifyAdmissionError: () => "unavailable",
          async admit() { throw new Error("Session V2 is disabled") },
          async result() { throw new Error("result must not be read") },
        },
      })
      for (const attempt of [1, 2, 3]) {
        await expect(runtime.runDue(owner())).resolves.toMatchObject({
          state: "failed",
          retryScheduled: attempt < 3,
          error: expect.objectContaining({ message: "Session V2 is disabled" }),
        })
        expect(await admission(database, source.proposalId)).toMatchObject({
          state: "planning_failed",
          version: attempt * 3,
          generation: {
            method: "planning_failed",
            attempt,
            reason: "Session V2 is disabled",
            retryable: true,
            failedAt: now,
          },
        })
        now += 60_000
      }
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "planning_failed",
        version: 9,
        generation: { method: "planning_failed", attempt: 3, retryable: true },
      })
      expect(database.prepare("SELECT status, last_error, payload_json FROM wg_v2_due_jobs").get()).toEqual({
        status: "failed_terminal",
        last_error: "Session V2 is disabled",
        payload_json: JSON.stringify({ proposalId: source.proposalId, source: source.ref, automaticFailureCount: 3 }),
      })

      const request = {
        operationId: "retry-planning" as never,
        command: { version: 1 as const, type: "retry_admission_planning" as const, proposalId: source.proposalId as never, expectedVersion: 9 },
      }
      const retried = await workgraph.execute(owner(), request)
      expect(retried).toMatchObject({ ok: true })
      await expect(workgraph.execute(owner(), request)).resolves.toEqual(retried)
      await expect(workgraph.execute(owner(), {
        operationId: "stale-retry-planning" as never,
        command: { ...request.command, expectedVersion: 9 },
      })).resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } })
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "planning",
        version: 10,
        generation: { method: "planning", attempt: 3, queuedAt: now },
      })
      expect(database.prepare("SELECT status, last_error, payload_json FROM wg_v2_due_jobs").get()).toEqual({
        status: "pending",
        last_error: null,
        payload_json: JSON.stringify({ proposalId: source.proposalId, source: source.ref, automaticFailureCount: 0 }),
      })
    } finally {
      database.close()
    }
  })

  it("rejects a two-node dependency cycle from the agent result", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const source = await createSource(service(database))
      const output = plan(source.ref)
      output.proposedWorkItems.push({
        ...output.proposedWorkItems[0]!,
        key: "verify",
        title: "Verify",
        dependencyKeys: ["deploy"],
      })
      output.proposedWorkItems[0]!.dependencyKeys = ["verify"]
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        sessionDirectory: "/repo",
        sessions: {
          async admit(input) { return String(input.sessionId) },
          async result() { return { state: "succeeded", summary: JSON.stringify(output), artifacts: [] } },
        },
      })
      await expect(runtime.runDue(owner())).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({ message: "Source planning result contains a dependency cycle" }),
      })
      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "planning_failed",
        version: 3,
        generation: {
          method: "planning_failed",
          attempt: 1,
          reason: "Source planning result contains a dependency cycle",
          retryable: true,
        },
      })
    } finally {
      database.close()
    }
  })

  it("invalidates a legacy non-Session proposal and requeues only its exact immutable source", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const source = await createSource(service(database))
      database.prepare(`
        UPDATE wg_v2_admission_proposals SET lifecycle = 'proposed', proposed_work_json = ?
        WHERE owner_user_id = ? AND id = ?
      `).run(JSON.stringify({
        source: source.ref,
        suggestedPlacement: { mode: "new_stream", streamTitle: "Legacy" },
        outcomes: [{ proposalKey: "legacy", title: "Legacy output" }],
        workItems: [],
        generation: { method: "deterministic_fallback", reason: "legacy" },
      }), owner().ownerUserId, source.proposalId)

      createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities })

      expect(await admission(database, source.proposalId)).toMatchObject({
        state: "planning_failed",
        version: 2,
        source: source.ref,
        generation: {
          method: "planning_failed",
          attempt: 0,
          reason: "Retired deterministic or incomplete admission plan is non-authoritative",
          retryable: true,
          invalidatedAt: expect.any(Number),
        },
      })
      expect(await admission(database, source.proposalId)).not.toHaveProperty("proposedOutcomes")
      expect(database.prepare("SELECT status, payload_json FROM wg_v2_due_jobs WHERE subject_id = ?").get(source.proposalId)).toEqual({
        status: "pending",
        payload_json: JSON.stringify({ proposalId: source.proposalId, source: source.ref, automaticFailureCount: 0 }),
      })
    } finally {
      database.close()
    }
  })
})

async function createSource(workgraph: ReturnType<typeof service>, configure = true, targetStreamId?: string) {
  if (configure) {
    const configured = await workgraph.execute(owner(), {
      operationId: "generation_defaults" as never,
      command: {
        version: 1,
        type: "update_workgraph_defaults",
        expectedVersion: 1,
        defaults: { execution: generationExecution, recap: {} },
      },
    })
    if (!configured.ok) throw new Error("generation defaults failed")
  }
  const content = "- Deploy cloud\n- Verify launch"
  const created = await workgraph.execute(owner(), {
    operationId: "source" as never,
    command: { version: 1, type: "create_work_source", title: "Ship cloud", content },
  })
  if (!created.ok) throw new Error("source failed")
  const source = created.value as { workSourceId: string; revisionId: string }
  const ref = { ...source, contentHash: createHash("sha256").update(content).digest("hex") } as WorkSourceRevisionRef
  const proposed = await workgraph.execute(owner(), {
    operationId: "proposal" as never,
    command: {
      version: 1,
      type: "propose_admission",
      source: ref,
      ...(targetStreamId ? { targetStreamId: targetStreamId as never } : {}),
    },
  })
  if (!proposed.ok) throw new Error("proposal failed")
  return { ref, proposalId: (proposed.value as { proposalId: string }).proposalId }
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

async function admission(database: BetterSqlite3.Database, proposalId: string) {
  const snapshot = await service(database).query(owner(), "snapshot", "page", { limit: 50 }) as { records: Array<Record<string, unknown>> }
  return snapshot.records.find((record) => record.recordType === "admission_proposal" && record.id === proposalId)
}

function service(database: BetterSqlite3.Database) {
  return createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities }).service
}

function owner(): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: "owner" as never,
    actor: { type: "user", id: "owner" as never },
    requestId: "request" as never,
    access: { mode: "owner" },
  }
}

function plan(source: WorkSourceRevisionRef): AdmissionAgentPlan {
  return {
    source,
    suggestedPlacement: { mode: "new_stream", streamTitle: "Ship cloud" },
    placementMatches: [],
    proposedOutcomes: [{ key: "cloud", title: "Cloud is shipped", successCriteria: ["Production is healthy"], execution: { effort: "high" } }],
    proposedWorkItems: [{
      key: "deploy",
      outcomeKey: "cloud",
      title: "Deploy cloud",
      dependencyKeys: [],
      completionContract: { version: 1, mode: "all", requirements: [{ id: "healthy" as never, kind: "owner_confirmation", description: "Owner verifies production" }] },
      execution: { effort: "medium" },
    }],
    duplicateMatches: [],
  }
}
import { testExecutionCapabilities } from "../../../test/test-execution-capabilities"
