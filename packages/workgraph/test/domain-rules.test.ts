import { describe, expect, it } from "vitest"
import {
  AttemptDtoSchema,
  CompletionContractSchema,
  EvidenceDtoSchema,
  ExecutionProfileDefaultsSchema,
  type CompletionContract,
  type EvidenceDto,
} from "../src/contracts"
import {
  completeOutcome,
  completeWorkItem,
  evaluateCompletionContract,
  reopenOutcome,
} from "../src/domain/completion"
import { createAttemptAdmissionSnapshot } from "../src/domain/attempt"
import { evaluateDecisionReadiness } from "../src/domain/decision-readiness"
import { resolveExecutionProfile } from "../src/domain/execution-profile"
import { streamRemovalEligibility } from "../src/domain/lifecycle"
import {
  transitionAttempt,
  transitionDecision,
  transitionOutcome,
  transitionStream,
  transitionStreamVisibility,
  transitionWorkItem,
} from "../src/domain/transitions"

describe("WorkGraph domain rules", () => {
  it("accepts Stream lifecycle transitions and returns a typed error for an invalid transition", () => {
    expect(transitionStream("active", "paused")).toEqual({ ok: true, state: "paused" })
    expect(transitionStream("closed", "active")).toEqual({
      ok: false,
      error: {
        code: "invalid_transition",
        entity: "stream",
        from: "closed",
        to: "active",
      },
    })
    expect(transitionStreamVisibility("visible", "archived")).toEqual({ ok: true, state: "archived" })
    expect(transitionStreamVisibility("archived", "archived")).toMatchObject({
      ok: false,
      error: { entity: "stream_visibility" },
    })
  })

  it("enforces Outcome, Work Item, Attempt, and Decision lifecycle boundaries", () => {
    expect(transitionOutcome("active", "ready_to_close")).toEqual({ ok: true, state: "ready_to_close" })
    expect(transitionOutcome("ready_to_close", "completed")).toMatchObject({ ok: false, error: { entity: "outcome" } })
    expect(transitionOutcome("completed", "active")).toMatchObject({ ok: false, error: { entity: "outcome" } })

    expect(transitionWorkItem("active", "result_ready")).toEqual({ ok: true, state: "result_ready" })
    expect(transitionWorkItem("result_ready", "completed")).toMatchObject({ ok: false, error: { entity: "work_item" } })
    expect(transitionWorkItem("completed", "active")).toMatchObject({ ok: false, error: { entity: "work_item" } })

    expect(transitionAttempt("admitted", "placing")).toEqual({ ok: true, state: "placing" })
    expect(transitionAttempt("placing", "running")).toEqual({ ok: true, state: "running" })
    expect(transitionAttempt("running", "result")).toEqual({ ok: true, state: "result" })
    expect(transitionAttempt("result", "running")).toMatchObject({ ok: false, error: { entity: "attempt" } })

    expect(transitionDecision("proposed", "pending")).toEqual({ ok: true, state: "pending" })
    expect(transitionDecision("pending", "answered")).toEqual({ ok: true, state: "answered" })
    expect(transitionDecision("answered", "pending")).toMatchObject({ ok: false, error: { entity: "decision" } })
  })

  it("reports preflight removal advice while reserving the atomic race for storage", () => {
    expect(streamRemovalEligibility(0)).toEqual({ eligible: true, action: "delete" })
    expect(streamRemovalEligibility(1)).toEqual({
      eligible: false,
      action: "close",
      error: { code: "close_required", durableEffectCount: 1 },
    })
    expect(streamRemovalEligibility(17)).toMatchObject({ eligible: false, error: { durableEffectCount: 17 } })
    expect(() => streamRemovalEligibility(-1)).toThrow("durableEffectCount")
    expect(() => streamRemovalEligibility(1.5)).toThrow("durableEffectCount")
  })

  it("satisfies an all-mode completion contract only from matching positive evidence", () => {
    const contract = completionContract("all")
    const result = evaluateCompletionContract(contract, { type: "work_item", workItemId: "item_01" }, [
      testEvidence({ id: "evidence_pass", requirementId: "requirement_test", passed: true, recordedAt: 1 }),
      reviewEvidence({ id: "evidence_review", requirementId: "requirement_review", verdict: "approved", recordedAt: 2 }),
      integrationEvidence({ id: "evidence_merge", requirementId: "requirement_merge", recordedAt: 3 }),
    ])

    expect(result).toEqual({
      subject: { type: "work_item", workItemId: "item_01" },
      satisfied: true,
      requirementResults: [
        { requirementId: "requirement_test", satisfied: true, evidenceId: "evidence_pass" },
        { requirementId: "requirement_review", satisfied: true, evidenceId: "evidence_review" },
        { requirementId: "requirement_merge", satisfied: true, evidenceId: "evidence_merge" },
      ],
    })
  })

  it("uses the latest evidence per requirement so contradictory evidence reopens completion", () => {
    const result = evaluateCompletionContract(completionContract("all"), { type: "work_item", workItemId: "item_01" }, [
      testEvidence({ id: "passing", requirementId: "requirement_test", passed: true, recordedAt: 1 }),
      testEvidence({ id: "failing", requirementId: "requirement_test", passed: false, recordedAt: 4 }),
      reviewEvidence({ id: "approved", requirementId: "requirement_review", verdict: "approved", recordedAt: 2 }),
      integrationEvidence({ id: "merged", requirementId: "requirement_merge", recordedAt: 3 }),
      testEvidence({ id: "unbound", passed: true, recordedAt: 10 }),
    ])

    expect(result).toEqual({
      subject: { type: "work_item", workItemId: "item_01" },
      satisfied: false,
      requirementResults: [
        { requirementId: "requirement_test", satisfied: false, evidenceId: "failing" },
        { requirementId: "requirement_review", satisfied: true, evidenceId: "approved" },
        { requirementId: "requirement_merge", satisfied: true, evidenceId: "merged" },
      ],
    })
  })

  it("supports any-mode contracts while rejecting evidence of the wrong semantic kind", () => {
    const contract = CompletionContractSchema.parse({
      version: 1,
      mode: "any",
      requirements: [
        { id: "requirement_artifact", kind: "artifact", description: "Build artifact exists" },
        { id: "requirement_owner", kind: "owner_confirmation", description: "Owner accepts it" },
      ],
    })
    const wrongKind = testEvidence({ id: "wrong", requirementId: "requirement_artifact", passed: true, recordedAt: 1 })
    const ownerConfirmation = EvidenceDtoSchema.parse({
      id: "confirmed",
      subject: { type: "work_item", workItemId: "item_01" },
      requirementId: "requirement_owner",
      kind: "owner_confirmation",
      confirmed: true,
      summary: "Accepted",
      recordedAt: 2,
      recordedBy: { type: "user", id: "user_01" },
    })

    expect(evaluateCompletionContract(contract, { type: "work_item", workItemId: "item_01" }, [wrongKind, ownerConfirmation])).toEqual({
      subject: { type: "work_item", workItemId: "item_01" },
      satisfied: true,
      requirementResults: [
        { requirementId: "requirement_artifact", satisfied: false, evidenceId: "wrong" },
        { requirementId: "requirement_owner", satisfied: true, evidenceId: "confirmed" },
      ],
    })
  })

  it("binds evidence to the evaluated subject and breaks timestamp ties by evidence ID", () => {
    const otherSubject = testEvidence({ id: "z_other", requirementId: "requirement_test", passed: false, recordedAt: 5 })
    const tiedFirst = testEvidence({ id: "a_pass", requirementId: "requirement_test", passed: true, recordedAt: 5 })
    const tiedLast = testEvidence({ id: "z_fail", requirementId: "requirement_test", passed: false, recordedAt: 5 })
    const result = evaluateCompletionContract(
      CompletionContractSchema.parse({
        version: 1,
        mode: "all",
        requirements: [{ id: "requirement_test", kind: "test", description: "Tests pass" }],
      }),
      { type: "work_item", workItemId: "item_01" },
      [
        { ...otherSubject, subject: { type: "work_item", workItemId: "item_02" } },
        tiedFirst,
        tiedLast,
      ] as EvidenceDto[],
    )

    expect(result).toEqual({
      subject: { type: "work_item", workItemId: "item_01" },
      satisfied: false,
      requirementResults: [{ requirementId: "requirement_test", satisfied: false, evidenceId: "z_fail" }],
    })
  })

  it("enforces machine-readable requirement qualifiers", () => {
    const contract = CompletionContractSchema.parse({
      version: 1,
      mode: "all",
      requirements: [
        { id: "test", kind: "test", description: "Qualified test", command: "bun test" },
        { id: "artifact", kind: "artifact", description: "Qualified artifact", artifactType: "application/zip" },
        { id: "review", kind: "review", description: "Qualified review", reviewerRole: "security" },
        { id: "integration", kind: "integration", description: "Qualified integration", target: "refs/heads/dev" },
      ],
    })
    const evidence = [
      { ...testEvidence({ id: "test_e", requirementId: "test", passed: true, recordedAt: 1 }), command: "bun typecheck" },
      EvidenceDtoSchema.parse({ id: "artifact_e", subject: { type: "work_item", workItemId: "item_01" }, requirementId: "artifact", kind: "artifact", artifactRef: "artifact://1", mediaType: "text/plain", summary: "Built", recordedAt: 1, recordedBy: { type: "agent", id: "agent_01" } }),
      EvidenceDtoSchema.parse({ id: "review_e", subject: { type: "work_item", workItemId: "item_01" }, requirementId: "review", kind: "review", verdict: "approved", reviewer: "general", summary: "Approved", recordedAt: 1, recordedBy: { type: "agent", id: "agent_01" } }),
      EvidenceDtoSchema.parse({ id: "integration_e", subject: { type: "work_item", workItemId: "item_01" }, requirementId: "integration", kind: "integration", effect: "other", reference: "refs/heads/main", summary: "Integrated", recordedAt: 1, recordedBy: { type: "agent", id: "agent_01" } }),
    ] as EvidenceDto[]

    expect(evaluateCompletionContract(contract, { type: "work_item", workItemId: "item_01" }, evidence).requirementResults)
      .toEqual(contract.requirements.map((requirement, index) => ({ requirementId: requirement.id, satisfied: false, evidenceId: evidence[index].id })))
  })

  it("requires semantic completion guards for work items and outcomes and records close/reopen provenance", () => {
    const workItemEvaluation = evaluateCompletionContract(
      CompletionContractSchema.parse({ version: 1, mode: "all", requirements: [{ id: "owner", kind: "owner_confirmation", description: "Owner accepts" }] }),
      { type: "work_item", workItemId: "item_01" },
      [EvidenceDtoSchema.parse({ id: "work_owner", subject: { type: "work_item", workItemId: "item_01" }, requirementId: "owner", kind: "owner_confirmation", confirmed: true, summary: "Accepted", recordedAt: 7, recordedBy: { type: "user", id: "user_01" } })],
    )
    expect(completeWorkItem({ workItemId: "item_01", state: "result_ready", evaluation: workItemEvaluation })).toEqual({ ok: true, state: "completed" })
    expect(completeWorkItem({ workItemId: "item_01", state: "active", evaluation: workItemEvaluation })).toMatchObject({ ok: false, error: { code: "result_not_ready" } })

    const ownerEvidence = EvidenceDtoSchema.parse({ id: "outcome_owner", subject: { type: "outcome", outcomeId: "outcome_01" }, requirementId: "owner", kind: "owner_confirmation", confirmed: true, summary: "Ship it", recordedAt: 11, recordedBy: { type: "user", id: "user_01" } })
    const completed = completeOutcome({ outcomeId: "outcome_01", ownerUserId: "user_01", state: "ready_to_close", childStates: ["completed", "abandoned"], ownerConfirmation: ownerEvidence, closedAt: 12, closedBy: { type: "user", id: "user_01" } })
    expect(completed).toEqual({ ok: true, state: "completed", provenance: { ownerConfirmationEvidenceId: "outcome_owner", closedAt: 12, closedBy: { type: "user", id: "user_01" } } })
    expect(completeOutcome({ outcomeId: "outcome_01", ownerUserId: "user_01", state: "ready_to_close", childStates: ["active"], ownerConfirmation: ownerEvidence, closedAt: 12, closedBy: { type: "user", id: "user_01" } })).toMatchObject({ ok: false, error: { code: "unfinished_work_items" } })
    expect(reopenOutcome({ state: "completed", reopenedAt: 13, reopenedBy: { type: "user", id: "user_01" }, reason: "Criteria changed" })).toEqual({ ok: true, state: "reopened", provenance: { reopenedAt: 13, reopenedBy: { type: "user", id: "user_01" }, reason: "Criteria changed" } })
  })

  it("blocks only Decision-affected work and its transitive dependents", () => {
    expect(evaluateDecisionReadiness({
      workItems: [
        { id: "a", dependencyIds: [] },
        { id: "b", dependencyIds: ["a"] },
        { id: "c", dependencyIds: ["b"] },
        { id: "unrelated", dependencyIds: [] },
      ],
      pendingDecisions: [{ id: "decision_1", affectedWorkItemIds: ["a"] }],
    })).toEqual([
      { workItemId: "a", ready: false, blockingDecisionIds: ["decision_1"] },
      { workItemId: "b", ready: false, blockingDecisionIds: ["decision_1"] },
      { workItemId: "c", ready: false, blockingDecisionIds: ["decision_1"] },
      { workItemId: "unrelated", ready: true, blockingDecisionIds: [] },
    ])
  })

  it("resolves each execution setting from the nearest WorkGraph hierarchy level with provenance", () => {
    const result = resolveExecutionProfile({
      workgraph: ExecutionProfileDefaultsSchema.parse({
        environment: { kind: "local_worktree", presetId: "standard" },
        repository: { remoteUrl: "https://example.com/acme/repo.git", baseRevision: "dev" },
        harness: "opencode",
        agent: "developer",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "medium",
        tools: ["shell"],
        connectionIds: ["connection_default"],
        isolation: "stream",
        cleanup: "destroy_on_close",
        integration: "manual",
      }),
      stream: ExecutionProfileDefaultsSchema.parse({
        environment: { kind: "hosted_workspace", presetId: "large" },
        cleanup: "retain",
        integration: "pull_request",
      }),
      outcome: ExecutionProfileDefaultsSchema.parse({
        model: { providerId: "anthropic", modelId: "claude-sonnet" },
        effort: "high",
      }),
      workItem: ExecutionProfileDefaultsSchema.parse({
        agent: "reviewer",
        tools: ["shell", "browser"],
        connectionIds: [],
        isolation: "child",
      }),
    })

    expect(result).toMatchObject({
      ok: true,
      profile: {
        environment: { kind: "hosted_workspace", presetId: "large" },
        repository: { remoteUrl: "https://example.com/acme/repo.git", baseRevision: "dev" },
        harness: "opencode",
        agent: "reviewer",
        model: { providerId: "anthropic", modelId: "claude-sonnet" },
        effort: "high",
        tools: ["shell", "browser"],
        connectionIds: [],
        isolation: "child",
        cleanup: "retain",
        integration: "pull_request",
      },
      provenance: {
        environment: "stream",
        repository: "workgraph",
        harness: "workgraph",
        agent: "work_item",
        model: "outcome",
        effort: "outcome",
        tools: "work_item",
        connectionIds: "work_item",
        isolation: "work_item",
        cleanup: "stream",
        integration: "stream",
      },
    })
    if (!result.ok) throw new Error("expected a resolved profile")
    expect(Object.isFrozen(result.profile)).toBe(true)
    expect(Object.isFrozen(result.profile.environment)).toBe(true)
    expect(Object.isFrozen(result.profile.tools)).toBe(true)
    expect(Object.isFrozen(result.provenance)).toBe(true)
  })

  it("returns a typed list of unresolved required execution fields", () => {
    expect(resolveExecutionProfile({ workgraph: { harness: "opencode" } })).toEqual({
      ok: false,
      error: {
        code: "incomplete_execution_profile",
        missingFields: [
          "environment",
          "agent",
          "model",
          "effort",
          "tools",
          "connectionIds",
          "isolation",
          "cleanup",
          "integration",
        ],
      },
    })
  })

  it("requires a repository for local worktree execution", () => {
    const defaults = ExecutionProfileDefaultsSchema.parse({ environment: { kind: "local_worktree" }, harness: "opencode", agent: "developer", model: { providerId: "openai", modelId: "gpt-5" }, effort: "medium", tools: [], connectionIds: [], isolation: "stream", cleanup: "retain", integration: "manual" })
    expect(resolveExecutionProfile({ workgraph: defaults })).toEqual({ ok: false, error: { code: "incomplete_execution_profile", missingFields: ["repository"] } })
  })

  it("creates a serializable immutable Attempt admission snapshot with resolved provenance", () => {
    const resolved = resolveExecutionProfile({ workgraph: ExecutionProfileDefaultsSchema.parse({ environment: { kind: "hosted_workspace" }, harness: "opencode", agent: "developer", model: { providerId: "openai", modelId: "gpt-5" }, effort: "medium", tools: [], connectionIds: [], isolation: "stream", cleanup: "retain", integration: "manual" }) })
    if (!resolved.ok) throw new Error("expected resolved profile")
    const snapshot = createAttemptAdmissionSnapshot({ attempt: AttemptDtoSchema.parse({ recordType: "attempt", schemaVersion: 1, ownerUserId: "user_01", version: 3, createdAt: 1, updatedAt: 1, provenance: { actor: { type: "agent", id: "agent_01" }, operationId: "operation_01" }, id: "attempt_01", streamId: "stream_01", workItemId: "item_01", attemptNumber: 1, state: "admitted", resolvedExecution: resolved.profile, admittedAt: 1, sourceRevisionRefs: [] }), executionProvenance: resolved.provenance })
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(snapshot.attempt.version).toBe(3)
    expect(snapshot.executionProvenance.environment).toBe("workgraph")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.executionProvenance)).toBe(true)
  })
})

function completionContract(mode: "all" | "any"): CompletionContract {
  return CompletionContractSchema.parse({
    version: 1,
    mode,
    requirements: [
      { id: "requirement_test", kind: "test", description: "Tests pass" },
      { id: "requirement_review", kind: "review", description: "Review approved" },
      { id: "requirement_merge", kind: "integration", description: "Merged" },
    ],
  })
}

function testEvidence(input: {
  id: string
  requirementId?: string
  passed: boolean
  recordedAt: number
}): EvidenceDto {
  return EvidenceDtoSchema.parse({
    id: input.id,
    subject: { type: "work_item", workItemId: "item_01" },
    requirementId: input.requirementId,
    kind: "test_result",
    passed: input.passed,
    summary: input.passed ? "Passed" : "Failed",
    recordedAt: input.recordedAt,
    recordedBy: { type: "agent", id: "agent_01" },
  })
}

function reviewEvidence(input: {
  id: string
  requirementId: string
  verdict: "approved" | "changes_requested"
  recordedAt: number
}): EvidenceDto {
  return EvidenceDtoSchema.parse({
    id: input.id,
    subject: { type: "work_item", workItemId: "item_01" },
    requirementId: input.requirementId,
    kind: "review",
    verdict: input.verdict,
    summary: input.verdict,
    recordedAt: input.recordedAt,
    recordedBy: { type: "agent", id: "reviewer_01" },
  })
}

function integrationEvidence(input: { id: string; requirementId: string; recordedAt: number }): EvidenceDto {
  return EvidenceDtoSchema.parse({
    id: input.id,
    subject: { type: "work_item", workItemId: "item_01" },
    requirementId: input.requirementId,
    kind: "integration",
    effect: "merged",
    reference: "https://example.com/pull/1",
    durableEffectReceiptId: "receipt_01",
    summary: "Merged",
    recordedAt: input.recordedAt,
    recordedBy: { type: "agent", id: "agent_01" },
  })
}
