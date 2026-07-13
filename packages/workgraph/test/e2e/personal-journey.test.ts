import { createHash } from "node:crypto"
import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import {
  createIntakeService,
  createSourceViewService,
  createSqliteIntakeStores,
  createSqliteRecapRuntime,
  createSqliteSourcePlanningRuntime,
  createSqliteWorkGraphService,
  listSqliteReconcilableAttempts,
  recordSemanticAttemptResult,
  renewSqliteAttemptLease,
  type ConnectionsPort,
  type WorkspaceExecutionPort,
} from "../../src"
import type { SourceIssueConnector } from "../../src/connectors/interface"
import type {
  AdmissionAgentPlan,
  CompletionContract,
  ConnectionID,
  OperationID,
  StreamID,
  WorkGraphContext,
  WorkGraphPublicRecord,
  WorkSourceRevisionRef,
} from "../../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("canonical personal WorkGraph journey", () => {
  it("keeps one owner journey coherent through admission, concurrent execution, decisions, evidence, intake, and lifecycle cleanup", async () => {
    const fixture = setup()

    const source = await fixture.execute("create_work_source", {
      title: "Launch plan",
      content: "Ship Claxedo Cloud, verify it, and preserve every consequential decision.",
    })
    const sourceRef = {
      workSourceId: resultId(source, "workSourceId"),
      revisionId: resultId(source, "revisionId"),
      contentHash: createHash("sha256").update("Ship Claxedo Cloud, verify it, and preserve every consequential decision.").digest("hex"),
    } as WorkSourceRevisionRef
    const proposal = await fixture.execute("propose_admission", { source: sourceRef })
    await fixture.planAdmission({
      source: sourceRef,
      suggestedPlacement: { mode: "new_stream", streamTitle: "Ship Claxedo Cloud" },
      placementMatches: [],
      proposedOutcomes: [{ key: "launch", title: "Cloud is launched", successCriteria: ["Core journey passes"], execution: {} }],
      proposedWorkItems: [
        { key: "backend", outcomeKey: "launch", title: "Ship backend", dependencyKeys: [], completionContract: completion("backend-proof"), execution: {} },
        { key: "frontend", outcomeKey: "launch", title: "Ship frontend", dependencyKeys: [], completionContract: completion("frontend-proof"), execution: {} },
        { key: "announce", outcomeKey: "launch", title: "Announce launch", dependencyKeys: ["backend"], completionContract: completion("announce-proof"), execution: {} },
      ],
      duplicateMatches: [],
    })
    const admitted = await fixture.execute("confirm_admission", {
      proposalId: resultId(proposal, "proposalId"),
      expectedVersion: 3,
      source: sourceRef,
      selection: { mode: "create", streamTitle: "Ship Claxedo Cloud" },
      outcomes: [{ proposalKey: "launch", title: "Cloud is launched", successCriteria: ["Core journey passes"] }],
      workItems: [
        { proposalKey: "backend", outcomeProposalKey: "launch", title: "Ship backend", completionContract: completion("backend-proof") },
        { proposalKey: "frontend", outcomeProposalKey: "launch", title: "Ship frontend", completionContract: completion("frontend-proof") },
        { proposalKey: "announce", outcomeProposalKey: "launch", title: "Announce launch", dependencyProposalKeys: ["backend"], completionContract: completion("announce-proof") },
      ],
    })
    const streamId = resultId(admitted, "streamId") as StreamID
    const initial = await fixture.snapshot()
    const outcome = record(initial, "outcome", (candidate) => candidate.streamId === streamId)
    const backend = record(initial, "work_item", (candidate) => candidate.title === "Ship backend")
    const frontend = record(initial, "work_item", (candidate) => candidate.title === "Ship frontend")
    const announce = record(initial, "work_item", (candidate) => candidate.title === "Announce launch")
    expect(announce.dependencyIds).toEqual([backend.id])

    expect(await fixture.execute("update_stream", {
      streamId,
      expectedVersion: 1,
      execution: profile,
    })).toMatchObject({ ok: true })
    const execution = await fixture.execute("execute_stream", { streamId, executionMode: "supervised" })
    expect(execution).toMatchObject({ ok: true })
    const attemptIds = resultIds(execution, "attemptIds")
    expect(attemptIds).toHaveLength(2)
    expect(fixture.runtime.provisioned).toEqual([streamId, streamId])
    expect(new Set(fixture.runtime.envelopes)).toEqual(new Set([`envelope:${streamId}`]))

    const decision = await fixture.execute("propose_decision", {
      streamId,
      question: "Which rollout should the backend use?",
      options: [{ id: "gradual", label: "Gradual" }, { id: "instant", label: "Instant" }],
      recommendationOptionId: "gradual",
      affectedWorkItemIds: [backend.id],
    })
    const running = await fixture.snapshot()
    expect(running.records.filter((candidate) => candidate.recordType === "attempt").map((attempt) => attempt.state)).toEqual(["running", "running"])
    expect(record(running, "decision", (candidate) => candidate.id === resultId(decision, "decisionId"))).toMatchObject({ state: "pending", affectedWorkItemIds: [backend.id] })
    expect(record(running, "work_item", (candidate) => candidate.id === frontend.id).state).toBe("active")

    expect(await fixture.execute("answer_decision", {
      decisionId: resultId(decision, "decisionId"),
      expectedVersion: 1,
      optionId: "gradual",
    })).toMatchObject({ ok: true })
    fixture.runtime.succeedAll()
    await fixture.reconcile()
    const settled = await fixture.snapshot()
    expect(settled.records.filter((candidate) => candidate.recordType === "attempt")).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "result", result: expect.objectContaining({ artifactRefs: expect.arrayContaining(["commit:e2e"]) }) }),
      expect.objectContaining({ state: "result", result: expect.objectContaining({ artifactRefs: expect.arrayContaining(["commit:e2e"]) }) }),
    ]))
    expect(record(settled, "work_item", (candidate) => candidate.id === backend.id).state).toBe("result_ready")
    expect(record(settled, "work_item", (candidate) => candidate.id === frontend.id).state).toBe("result_ready")

    for (const [workItemId, requirementId] of [[backend.id, "backend-proof"], [frontend.id, "frontend-proof"]] as const) {
      expect(await fixture.execute("record_evidence", {
        subject: { type: "work_item", workItemId },
        requirementId,
        evidence: { kind: "test_result", summary: `${requirementId} passed`, passed: true, command: "bun test" },
      })).toMatchObject({ ok: true })
      await expect(fixture.adapter.service.query(owner(), "workItems", "read", { workItemId })).resolves.toMatchObject({ completionSatisfied: true })
    }

    const intakeStores = createSqliteIntakeStores(fixture.database)
    const sourceViews = createSourceViewService({ store: intakeStores.sourceViews, connections, ids: sequence("view"), clock: fixture.clock })
    const sourceView = await sourceViews.create(owner(), {
      teamConnectionId,
      provider: "github",
      providerUserId: "owner-gh",
      filters: { repo: "claxedo/claxedo" },
    })
    const intake = createIntakeService({
      ...intakeStores,
      commands: { execute: (context, request) => fixture.adapter.service.execute(context, request) },
      connections,
      connectors: { get: () => sourceConnector },
      ids: sequence("candidate"),
      clock: fixture.clock,
    })
    const refreshed = await intake.refresh(owner(), sourceView.id)
    expect(refreshed.candidates).toHaveLength(1)
    await expect(intake.stage(owner(), refreshed.candidates[0]!.id)).resolves.toMatchObject({ state: "staged", title: "Discovered follow-up" })

    const disposable = await fixture.execute("create_stream", { title: "Disposable spike" })
    const disposableId = resultId(disposable, "streamId")
    expect(await fixture.execute("delete_stream", { streamId: disposableId, expectedVersion: 1, reason: "Spike is no longer useful" })).toMatchObject({ ok: true })
    expect((await fixture.snapshot()).records.some((candidate) => candidate.recordType === "stream" && candidate.id === disposableId)).toBe(false)

    expect(await fixture.execute("record_evidence", {
      subject: { type: "work_item", workItemId: backend.id },
      evidence: { kind: "integration", summary: "Preview published", effect: "published", reference: "https://preview.example/e2e" },
    })).toMatchObject({ ok: true })
    expect(await fixture.execute("delete_stream", { streamId, expectedVersion: 2, reason: "Try destructive cleanup" })).toMatchObject({ ok: false, error: { code: "close_required" } })
    expect(await fixture.execute("close_stream", { streamId, expectedVersion: 2, reason: "Launch record retained" })).toMatchObject({ ok: true })
    const closed = await fixture.snapshot()
    expect(record(closed, "stream", (candidate) => candidate.id === streamId)).toMatchObject({ lifecycleState: "closed", durableEffectCount: 1 })
    expect(record(closed, "work_item", (candidate) => candidate.id === announce.id)).toMatchObject({ state: "abandoned", abandonReason: "Launch record retained" })
    expect(outcome.id).toBeTruthy()
  })

  it("promotes evidence-satisfied result_ready work into completed semantic work before closing its Outcome", async () => {
    const fixture = setup()
    const streamId = resultId(await fixture.execute("create_stream", { title: "Completion contract" }), "streamId")
    const outcomeId = resultId(await fixture.execute("create_outcome", { streamId, title: "Shipped", successCriteria: ["Verified"] }), "outcomeId")
    const workItemId = resultId(await fixture.execute("create_work_item", {
      streamId,
      outcomeId,
      title: "Verify",
      completionContract: completion("proof"),
      execution: profile,
    }), "workItemId")
    await fixture.execute("execute_work_item", { workItemId, executionMode: "supervised" })
    fixture.runtime.succeedAll()
    await fixture.reconcile()
    await fixture.execute("record_evidence", {
      subject: { type: "work_item", workItemId },
      requirementId: "proof",
      evidence: { kind: "test_result", summary: "Verified", passed: true },
    })
    expect(record(await fixture.snapshot(), "work_item", (candidate) => candidate.id === workItemId).state).toBe("completed")
    await fixture.execute("record_evidence", {
      subject: { type: "outcome", outcomeId },
      evidence: { kind: "owner_confirmation", summary: "Accepted", confirmed: true },
    })
    expect(record(await fixture.snapshot(), "outcome", (candidate) => candidate.id === outcomeId).state).toBe("ready_to_close")
    expect(await fixture.execute("close_outcome", { outcomeId, expectedVersion: 2, reason: "All work verified" })).toMatchObject({ ok: true })
  })

  it("persists a background recap after eight quiet hours without requiring a foreground request", async () => {
    const fixture = setup()
    const streamId = resultId(await fixture.execute("create_stream", { title: "Quiet stream" }), "streamId")
    fixture.advance(8 * 60 * 60 * 1000 + 1)
    await fixture.backgroundTick()
    expect(record(await fixture.snapshot(), "recap", (candidate) => candidate.streamId === streamId)).toMatchObject({
      summary: expect.any(String),
      actionableReferences: expect.any(Array),
    })
  })
})

function setup() {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let now = 1_000
  let id = 0
  let operation = 0
  let generationConfigured = false
  const runtime = controlledExecution()
  const adapter = createSqliteWorkGraphService({ database, execution: runtime.port, clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` } })
  const recaps = createSqliteRecapRuntime({
    database,
    clock: { now: () => now },
    workerId: "e2e_recap",
    sessions: {
      async admit(input) { return String(input.sessionId) },
      async result() {
        return { state: "succeeded" as const, summary: JSON.stringify({ summary: "The Stream is current.", actionableReferences: [] }), artifacts: [] }
      },
    },
  })
  const execute = (type: string, command: Record<string, unknown>) => adapter.service.execute(owner(), {
    operationId: branded<OperationID>(`operation_${++operation}`),
    command: { version: 1, type, ...command },
  } as never)
  const configureGeneration = async () => {
    if (generationConfigured) return
    const result = await execute("update_workgraph_defaults", {
      expectedVersion: 1,
      defaults: {
        execution: profile,
        recap: { model: profile.model, effort: profile.effort },
      },
    })
    if (!result.ok) throw new Error(`Expected explicit WorkGraph generation configuration: ${result.error.message}`)
    generationConfigured = true
  }
  return {
    database,
    adapter,
    runtime,
    execute,
    clock: { now: () => now },
    advance: (milliseconds: number) => { now += milliseconds },
    backgroundTick: async () => {
      await configureGeneration()
      await recaps.scheduleDue(owner())
      await recaps.runDue(owner())
    },
    planAdmission: async (plan: AdmissionAgentPlan) => {
      await configureGeneration()
      const runtime = createSqliteSourcePlanningRuntime({
        database,
        clock: { now: () => now },
        workerId: "e2e-source-planner",
        sessions: {
          async admit(input) { return String(input.sessionId) },
          async result() { return { state: "succeeded", summary: JSON.stringify(plan), artifacts: [] } },
        },
      })
      await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "completed" })
    },
    snapshot: () => adapter.service.query(owner(), "snapshot", "page", { limit: 500 }),
    reconcile: async () => Promise.all(listSqliteReconcilableAttempts(database, owner()).map(async (attempt) => {
      const renewal = renewSqliteAttemptLease(database, owner(), {
        attemptId: attempt.attemptId,
        expectedLeaseEpoch: attempt.leaseEpoch,
        occurredAt: now++,
        durationMs: 300_000,
      })
      if (!renewal) return
      const result = await runtime.port.result(owner(), { attemptId: attempt.attemptId, sessionId: attempt.sessionId })
      if (result.state !== "succeeded") return
      const integrated = await runtime.port.integrateResult(owner(), {
        streamId: attempt.streamId,
        workItemId: attempt.workItemId,
        attemptId: attempt.attemptId,
        sessionId: attempt.sessionId,
        envelopeId: attempt.envelopeId,
        ...(attempt.childIsolationId ? { childIsolationId: attempt.childIsolationId as never } : {}),
        profile: JSON.parse(attempt.profileJson),
        result,
      })
      return recordSemanticAttemptResult(
        owner(),
        { ...attempt, leaseEpoch: renewal.leaseEpoch },
        { state: "succeeded", ...integrated },
        adapter.attemptResults,
      )
    })),
  }
}

function controlledExecution() {
  const results = new Map<string, "running" | "succeeded">()
  const provisioned: string[] = []
  const envelopes: string[] = []
  const port: WorkspaceExecutionPort = {
    provisionOrAdopt: async (_context, input) => {
      provisioned.push(input.streamId)
      const id = `envelope:${input.streamId}` as never
      envelopes.push(id)
      return { id, streamId: input.streamId, environment: input.environment, repository: input.repository, workspaceId: `/tmp/${id}` }
    },
    createChildIsolation: async () => { throw new Error("Canonical journey uses one Stream envelope") },
    launch: async (_context, input) => {
      const sessionId = `session:${input.attemptId}` as never
      results.set(sessionId, "running")
      return { sessionId, envelopeId: input.envelopeId }
    },
    cancel: async (_context, input) => { results.delete(input.sessionId) },
    result: async (_context, input) => results.get(input.sessionId) === "succeeded"
      ? { state: "succeeded", summary: "Execution completed", artifacts: ["commit:e2e"] }
      : { state: "running" },
    integrateResult: async (_context, input) => ({ summary: input.result.summary, artifacts: input.result.artifacts }),
    cleanup: async () => undefined,
  }
  return { port, provisioned, envelopes, succeedAll: () => results.forEach((_value, key) => results.set(key, "succeeded")) }
}

const profile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
  isolation: "stream" as const,
  cleanup: "destroy_on_close" as const,
  integration: "manual" as const,
}

function completion(id: string): CompletionContract {
  return { version: 1, mode: "all", requirements: [{ id: branded(id), kind: "test", description: "The focused test passes" }] }
}

function resultId(result: Awaited<ReturnType<ReturnType<typeof setup>["execute"]>>, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Expected ${key}`)
  const value = result.value[key]
  if (typeof value !== "string") throw new Error(`Expected ${key}`)
  return value
}

function resultIds(result: Awaited<ReturnType<ReturnType<typeof setup>["execute"]>>, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Expected ${key}`)
  const value = result.value[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`Expected ${key}`)
  return value as string[]
}

function record<Type extends WorkGraphPublicRecord["recordType"]>(
  snapshot: { records: WorkGraphPublicRecord[] },
  type: Type,
  predicate: (candidate: Extract<WorkGraphPublicRecord, { recordType: Type }>) => boolean,
) {
  const candidate = snapshot.records.find((entry): entry is Extract<WorkGraphPublicRecord, { recordType: Type }> => entry.recordType === type && predicate(entry as never))
  if (!candidate) throw new Error(`Expected ${type} record`)
  return candidate
}

const teamConnectionId = branded<ConnectionID>("team-github")
const connections: ConnectionsPort = {
  resolveCapabilities: async () => [{
    id: teamConnectionId,
    integrationId: "github",
    capability: "work-source",
    scope: "team",
    withAuthorization: async (use) => use({ token: "live-only", tokenType: "bearer" }),
    reportAuthFailure: async () => undefined,
  }],
}
const sourceConnector: SourceIssueConnector = {
  provider: "github",
  list: async () => ({ issues: [{ externalId: "42", externalKey: "CLA-42", title: "Discovered follow-up", body: "Found while an agent was executing", status: "open", updatedAt: 2_000, revision: "rev-1" }] }),
  comment: async () => undefined,
  update: async () => undefined,
}

function sequence(prefix: string) {
  let id = 0
  return { next: () => `${prefix}_${++id}` }
}

function owner(): WorkGraphContext {
  return { ownerUserId: branded("owner"), actor: { type: "user", id: branded("owner") }, requestId: branded("request"), access: { mode: "owner" } }
}

function branded<Type = string>(value: string) { return value as Type }
