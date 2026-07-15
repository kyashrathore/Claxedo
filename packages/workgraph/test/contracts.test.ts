import { describe, expect, expectTypeOf, it } from "vitest"
import {
  AttemptStateSchema,
  CompletionContractSchema,
  DecisionStateSchema,
  EvidenceDtoSchema,
  ExecutionProfileDefaultsSchema,
  IntakeStateSchema,
  OutcomeStateSchema,
  OwnerUserIDSchema,
  ResolvedExecutionProfileSchema,
  StreamLifecycleStateSchema,
  StreamVisibilitySchema,
  WorkSourceDtoSchema,
  WorkSourceRevisionDtoSchema,
  WorkGraphContextSchema,
  WorkItemStateSchema,
  type OwnerUserID,
  type WorkGraphContext,
} from "../src/contracts"

describe("WorkGraph contracts", () => {
  it("accepts a trusted owner context and rejects unknown or empty identity fields", () => {
    const context = WorkGraphContextSchema.parse({
      organizationId: "organization_01",
      ownerUserId: "user_01",
      actor: { type: "agent", id: "agent_01" },
      requestId: "request_01",
      access: { mode: "owner" },
    })

    expect(context.ownerUserId).toBe("user_01")
    expect(() => WorkGraphContextSchema.parse({ ...context, ownerUserId: "" })).toThrow()
    expect(() => WorkGraphContextSchema.parse({ ...context, selectedOwnerUserId: "user_02" })).toThrow()
    expectTypeOf(context).toEqualTypeOf<WorkGraphContext>()
    expectTypeOf(OwnerUserIDSchema.parse("user_01")).toEqualTypeOf<OwnerUserID>()
  })

  it("validates the complete public lifecycle vocabulary", () => {
    expect(StreamLifecycleStateSchema.options).toEqual(["active", "paused", "closed", "reopened"])
    expect(StreamVisibilitySchema.parse("archived")).toBe("archived")
    expect(OutcomeStateSchema.parse("ready_to_close")).toBe("ready_to_close")
    expect(WorkItemStateSchema.parse("integration_needed")).toBe("integration_needed")
    expect(AttemptStateSchema.parse("placing")).toBe("placing")
    expect(DecisionStateSchema.parse("answered")).toBe("answered")
    expect(IntakeStateSchema.parse("merged")).toBe("merged")
    expect(() => WorkItemStateSchema.parse("done")).toThrow()
  })

  it("distinguishes inheritable execution defaults from a complete immutable Attempt profile", () => {
    expect(ExecutionProfileDefaultsSchema.parse({ model: { providerId: "openai", modelId: "gpt-5" } })).toEqual({
      model: { providerId: "openai", modelId: "gpt-5" },
    })

    const profile = ResolvedExecutionProfileSchema.parse({
      environment: { kind: "local_worktree" },
      repository: { remoteUrl: "https://example.com/claxedo.git", baseRevision: "dev" },
      harness: "opencode",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "high",
      tools: ["shell", "browser"],
      connectionIds: ["connection_01"],
    })

    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.environment)).toBe(true)
    expect(Object.isFrozen(profile.repository)).toBe(true)
    expect(Object.isFrozen(profile.model)).toBe(true)
    expect(Object.isFrozen(profile.tools)).toBe(true)
    expect(Object.isFrozen(profile.connectionIds)).toBe(true)
    expect(Reflect.set(profile.model, "providerId", "other")).toBe(false)
    expect(Reflect.set(profile.tools, "0", "other")).toBe(false)
    expect(profile.model.providerId).toBe("openai")
    expect(profile.tools[0]).toBe("shell")
    expect(() => ResolvedExecutionProfileSchema.parse({ ...profile, harness: undefined })).toThrow()
  })

  it("binds manual source text to an exact immutable revision DTO", () => {
    const revision = WorkSourceRevisionDtoSchema.parse({
      id: "revision_01",
      workSourceId: "source_01",
      revisionNumber: 1,
      content: "Ship the personal WorkGraph.",
      contentHash: "a".repeat(64),
      origin: { kind: "manual" },
      createdAt: 1_720_000_000_000,
      createdBy: { type: "user", id: "user_01" },
    })
    const source = WorkSourceDtoSchema.parse({
      id: "source_01",
      ownerUserId: "user_01",
      title: "WorkGraph goal",
      latestRevisionId: revision.id,
      revisionCount: 1,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    })

    expect(source.latestRevisionId).toBe(revision.id)
    expect(revision.content).toBe("Ship the personal WorkGraph.")
    expect(() => WorkSourceRevisionDtoSchema.parse({ ...revision, contentHash: "not-a-hash" })).toThrow()
    expect(() => WorkSourceRevisionDtoSchema.parse({ ...revision, content: " \n\t " })).toThrow()
    expect(WorkSourceRevisionDtoSchema.parse({ ...revision, content: "  preserve me  " }).content).toBe("  preserve me  ")
    expect(() => WorkSourceDtoSchema.parse({ ...source, revisionCount: 0 })).toThrow()
  })

  it("validates completion requirements and provenance-bearing evidence without treating an Attempt result as completion", () => {
    const contract = CompletionContractSchema.parse({
      version: 1,
      mode: "all",
      requirements: [
        { id: "requirement_tests", kind: "test", description: "Core E2E passes", command: "bun test" },
        { id: "requirement_merge", kind: "integration", description: "Change is merged", target: "dev" },
      ],
    })
    const evidence = EvidenceDtoSchema.parse({
      id: "evidence_01",
      subject: { type: "work_item", workItemId: "item_01" },
      requirementId: contract.requirements[0]?.id,
      kind: "test_result",
      passed: true,
      command: "bun test",
      summary: "Core E2E passed",
      recordedAt: 1_720_000_000_000,
      recordedBy: { type: "agent", id: "agent_01" },
    })

    expect(contract.requirements).toHaveLength(2)
    expect(evidence.kind).toBe("test_result")
    expect(() => CompletionContractSchema.parse({ ...contract, requirements: [] })).toThrow()
    expect(() =>
      CompletionContractSchema.parse({
        ...contract,
        requirements: [contract.requirements[0], contract.requirements[0]],
      }),
    ).toThrow()
    expect(
      ["merged", "published", "accepted_external_write"].map(
        (effect) =>
          EvidenceDtoSchema.safeParse({
            id: `evidence_${effect}`,
            subject: evidence.subject,
            requirementId: contract.requirements[1]?.id,
            kind: "integration",
            effect,
            reference: "https://example.com/change/1",
            summary: "Durable integration completed",
            recordedAt: evidence.recordedAt,
            recordedBy: evidence.recordedBy,
          }).success,
      ),
    ).toEqual([false, false, false])
    expect(
      EvidenceDtoSchema.parse({
        id: "evidence_merge",
        subject: evidence.subject,
        requirementId: contract.requirements[1]?.id,
        kind: "integration",
        effect: "merged",
        reference: "https://example.com/pull/1",
        durableEffectReceiptId: "receipt_01",
        summary: "Change merged",
        recordedAt: evidence.recordedAt,
        recordedBy: evidence.recordedBy,
      }).kind,
    ).toBe("integration")
    expect(
      EvidenceDtoSchema.parse({
        id: "evidence_other",
        subject: evidence.subject,
        kind: "integration",
        effect: "other",
        reference: "workspace://artifact",
        summary: "Workspace artifact retained",
        recordedAt: evidence.recordedAt,
        recordedBy: evidence.recordedBy,
      }).kind,
    ).toBe("integration")
    expect(() => EvidenceDtoSchema.parse({ ...evidence, providerToken: "secret" })).toThrow()
  })
})
