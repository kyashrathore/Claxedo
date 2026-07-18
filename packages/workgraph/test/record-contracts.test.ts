import { describe, expect, it } from "vitest"
import {
  AdmissionProposalDtoSchema,
  AttemptDtoSchema,
  DecisionDtoSchema,
  OutcomeDtoSchema,
  OrderedSnapshotReferenceSchema,
  StreamDtoSchema,
  WorkGraphSnapshotPageSchema,
  WorkGraphDefaultsDtoSchema,
  WorkItemDtoSchema,
} from "../src/contracts/records"

const actor = { type: "agent" as const, id: "agent_01" }
const provenance = { actor, operationId: "operation_01" }
const timestamps = { createdAt: 1_720_000_000_000, updatedAt: 1_720_000_000_001 }
const execution = {
  environment: { kind: "local_worktree" as const },
  repository: { remoteUrl: "https://example.com/claxedo.git", baseRevision: "dev" },
  harness: "opencode",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["shell"],
  connectionIds: ["connection_01"],
}

describe("public WorkGraph record contracts", () => {
  it("validates strict owner-bound WorkGraph execution defaults", () => {
    const defaults = WorkGraphDefaultsDtoSchema.parse({
      recordType: "workgraph",
      schemaVersion: 1,
      id: "workgraph_default",
      ownerUserId: "user_01",
      version: 2,
      defaults: {
        execution: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
      },
      provenance,
      ...timestamps,
    })

    expect(defaults.defaults.execution.effort).toBe("high")
    expect(() => WorkGraphDefaultsDtoSchema.parse({ ...defaults, ownerUserId: "" })).toThrow()
    expect(() => WorkGraphDefaultsDtoSchema.parse({ ...defaults, credential: "secret" })).toThrow()
  })

  it("validates strict owner-bound Stream, Outcome, and Work Item records", () => {
    const stream = StreamDtoSchema.parse({
      recordType: "stream",
      schemaVersion: 1,
      id: "stream_01",
      ownerUserId: "user_01",
      version: 3,
      title: "Ship WorkGraph",
      description: "Personal AI work organization",
      lifecycleState: "active",
      visibility: "visible",
      pinned: true,
      executionDefaults: { effort: "high" },
      activity: { lastActivityAt: timestamps.updatedAt },
      durableEffectCount: 0,
      sourceRevisionRefs: [],
      provenance,
      ...timestamps,
    })
    const outcome = OutcomeDtoSchema.parse({
      recordType: "outcome",
      schemaVersion: 1,
      id: "outcome_01",
      ownerUserId: "user_01",
      streamId: stream.id,
      version: 1,
      title: "Public contracts ship",
      state: "active",
      successCriteria: ["Focused tests pass"],
      evidenceIds: [],
      sourceRevisionRefs: [],
      provenance,
      ...timestamps,
    })
    const item = WorkItemDtoSchema.parse({
      recordType: "work_item",
      schemaVersion: 1,
      id: "item_01",
      ownerUserId: "user_01",
      streamId: stream.id,
      outcomeId: outcome.id,
      version: 1,
      title: "Define records",
      state: "active",
      priority: 1,
      dependencyIds: [],
      sourceRevisionRefs: [],
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "requirement_01", kind: "test", description: "Tests pass" }],
      },
      evidenceIds: [],
      provenance,
      ...timestamps,
    })

    expect(item.outcomeId).toBe(outcome.id)
    expect(() => StreamDtoSchema.parse({ ...stream, credential: "secret" })).toThrow()
    expect(() => OutcomeDtoSchema.parse({ ...outcome, ownerUserId: "" })).toThrow()
    expect(() => WorkItemDtoSchema.parse({ ...item, version: 0 })).toThrow()
  })

  it("stores an immutable resolved execution snapshot on every Attempt", () => {
    const attempt = AttemptDtoSchema.parse({
      recordType: "attempt",
      schemaVersion: 1,
      id: "attempt_01",
      ownerUserId: "user_01",
      streamId: "stream_01",
      workItemId: "item_01",
      version: 1,
      attemptNumber: 1,
      state: "running",
      resolvedExecution: execution,
      admittedAt: timestamps.createdAt,
      startedAt: timestamps.updatedAt,
      sourceRevisionRefs: [],
      provenance,
      ...timestamps,
    })

    expect(Object.isFrozen(attempt)).toBe(true)
    expect(Object.isFrozen(attempt.resolvedExecution)).toBe(true)
    expect(Reflect.set(attempt.resolvedExecution.model, "modelId", "other")).toBe(false)
    expect(() => AttemptDtoSchema.parse({ ...attempt, resolvedExecution: { ...execution, model: undefined } })).toThrow()
  })

  it("captures Decision options and validates their recommendation", () => {
    const decision = DecisionDtoSchema.parse({
      recordType: "decision",
      schemaVersion: 1,
      id: "decision_01",
      ownerUserId: "user_01",
      streamId: "stream_01",
      version: 1,
      state: "pending",
      question: "Which integration path?",
      options: [
        { id: "pull_request", label: "Pull request", description: "Review before merge" },
        { id: "direct", label: "Direct" },
      ],
      recommendationOptionId: "pull_request",
      rationale: "Preserves review",
      affectedWorkItemIds: ["item_01"],
      sourceRevisionRefs: [],
      provenance,
      ...timestamps,
    })
    expect(decision.options).toHaveLength(2)
    expect(() => DecisionDtoSchema.parse({ ...decision, recommendationOptionId: "missing" })).toThrow()
  })

  it("binds admission proposals to exact source revisions and validates ordered snapshot pages", () => {
    const source = { workSourceId: "source_01", revisionId: "revision_02", contentHash: "a".repeat(64) }
    const proposal = AdmissionProposalDtoSchema.parse({
      recordType: "admission_proposal",
      schemaVersion: 1,
      id: "proposal_01",
      ownerUserId: "user_01",
      version: 1,
      state: "proposed",
      source,
      previousSource: { ...source, revisionId: "revision_01", contentHash: "b".repeat(64) },
      diffSummary: "Adds hosted persistence",
      generation: { method: "agent_session", sessionId: "session_01", generatedAt: timestamps.updatedAt },
      suggestedPlacement: { mode: "existing", streamId: "stream_01" },
      placementMatches: [],
      proposedOutcomes: [{ key: "outcome_cloud", title: "Cloud persistence", successCriteria: ["Convex passes"], execution: {} }],
      proposedWorkItems: [{
        key: "item_convex",
        outcomeKey: "outcome_cloud",
        title: "Implement Convex",
        dependencyKeys: [],
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{ id: "convex_done", kind: "owner_confirmation", description: "Owner accepts Convex persistence" }],
        },
        execution: {},
      }],
      duplicateMatches: [],
      provenance,
      ...timestamps,
    })
    const reference = OrderedSnapshotReferenceSchema.parse({
      sequence: 12,
      resource: { type: "admission_proposal", id: proposal.id },
      version: proposal.version,
    })
    const page = WorkGraphSnapshotPageSchema.parse({
      snapshotCursor: "cursor_12",
      records: [proposal],
      references: [reference],
      hasMore: false,
      capturedAt: timestamps.updatedAt,
    })

    expect(page.records[0]?.recordType).toBe("admission_proposal")
    expect(() => AdmissionProposalDtoSchema.parse({ ...proposal, source: { ...source, contentHash: "bad" } })).toThrow()
    expect(() => WorkGraphSnapshotPageSchema.parse({ ...page, apiToken: "secret" })).toThrow()
  })
})
