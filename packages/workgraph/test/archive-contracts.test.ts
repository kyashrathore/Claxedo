import { describe, expect, it } from "vitest"
import {
  WorkGraphArchiveRestoreError,
  WorkGraphArchiveRecordKindSchema,
  WorkGraphArchiveSchema,
  hashWorkGraphArchive,
  validateWorkGraphArchive,
} from "../src/contracts/archive"
import { WorkGraphEventTypeSchema } from "../src/contracts/events"

describe("WorkGraph archive contract", () => {
  it("admits recovered Attempt lease history as a canonical semantic event", () => {
    expect(WorkGraphEventTypeSchema.parse("attempt_lease_recovered")).toBe("attempt_lease_recovered")
  })

  it("defines a usable strict semantic value for every portable record kind", async () => {
    const archive = value(canonicalRecords())
    expect(new Set(archive.records.map((record) => record.kind))).toEqual(
      new Set(WorkGraphArchiveRecordKindSchema.options),
    )
    await expect(validateWorkGraphArchive(archive)).resolves.toEqual(WorkGraphArchiveSchema.parse(archive))
  })

  it("accepts canonical backend-neutral values and verifies immutable source content", async () => {
    const archive = value([
      {
        kind: "work_source_revision",
        id: "revision_1",
        value: {
          schemaVersion: 1,
          workSourceId: "source_1",
          revisionNumber: 1,
          content: "hello",
          contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          origin: { kind: "manual" },
          createdAt: 1,
          createdBy: { type: "user", id: "user_1" },
        },
      },
    ])

    await expect(validateWorkGraphArchive(archive)).resolves.toEqual(WorkGraphArchiveSchema.parse(archive))
  })

  it("rejects source content that does not match its public contentHash", async () => {
    await expect(
      validateWorkGraphArchive(
        value([
          {
            kind: "work_source_revision",
            id: "revision_1",
            value: {
              schemaVersion: 1,
              workSourceId: "source_1",
              revisionNumber: 1,
              content: "changed",
              contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              origin: { kind: "manual" },
              createdAt: 1,
              createdBy: { type: "user", id: "user_1" },
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ reason: "malformed" })
  })

  it("rejects incomplete semantics and SQLite or Convex physical vocabulary", async () => {
    for (const record of [
      { kind: "stream", id: "stream_1", value: { state: "active" } },
      { kind: "stream", id: "stream_1", value: { lifecycle: "active", purpose: "Ship" } },
      { kind: "attempt", id: "attempt_1", value: { lifecycle: "running", resolvedExecutionProfile: {} } },
      { kind: "recap", id: "recap_1", value: { activityStartSequence: 1, activityEndSequence: 2 } },
      { kind: "stream", id: "stream_1", value: { owner_user_id: "owner_1" } },
    ]) {
      await expect(validateWorkGraphArchive(value([record]))).rejects.toMatchObject({ reason: "malformed" })
    }
  })

  it("rejects archived Work Items with duplicate completion requirement IDs", async () => {
    const records = canonicalRecords().map((record) =>
      record.kind === "work_item"
        ? {
            ...record,
            value: {
              ...record.value,
              completionContract: {
                version: 1,
                mode: "all",
                requirements: [
                  { id: "done", kind: "artifact", description: "Deployment artifact" },
                  { id: "done", kind: "test", description: "Deployment test" },
                ],
              },
            },
          }
        : record,
    )

    await expect(validateWorkGraphArchive(value(records))).rejects.toMatchObject({ reason: "malformed" })
  })

  it("accepts a canonical change-feed record and rejects physical change columns", async () => {
    const canonical = value([
      {
        kind: "change",
        id: "change_1",
        value: {
          schemaVersion: 1,
          cursor: "7",
          eventId: "event_1",
          operationId: "operation_1",
          resource: { type: "stream", id: "stream_1" },
          changeType: "stream_updated",
          payload: { streamId: "stream_1" },
          createdAt: 7,
        },
      },
    ])

    await expect(validateWorkGraphArchive(canonical)).resolves.toEqual(WorkGraphArchiveSchema.parse(canonical))
    await expect(
      validateWorkGraphArchive(
        value([
          {
            kind: "change",
            id: "change_1",
            value: {
              schema_version: 1,
              cursor: 7,
              event_id: "event_1",
              operation_id: "operation_1",
              resource_type: "stream",
              resource_id: "stream_1",
              change_type: "stream_updated",
              payload: {},
              created_at: 7,
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ reason: "malformed" })
  })

  it("requires replacement reset completion timestamps to match reset state", async () => {
    const reference = {
      workSourceId: "source_1",
      revisionId: "revision_1",
      contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    }
    const reset = {
      proposalId: "proposal_1",
      previousSource: reference,
      source: reference,
      requestedAt: 1,
    }
    const archive = (replacementReset: Record<string, unknown>) =>
      value(
        canonicalRecords().map((record) =>
          record.kind === "stream" ? { ...record, value: { ...record.value, replacementReset } } : record,
        ),
      )

    await expect(validateWorkGraphArchive(archive({ ...reset, state: "completed" }))).rejects.toMatchObject({
      reason: "malformed",
    })
    await expect(
      validateWorkGraphArchive(archive({ ...reset, state: "pending", completedAt: 2 })),
    ).rejects.toMatchObject({ reason: "malformed" })
    await expect(
      validateWorkGraphArchive(archive({ ...reset, state: "completed", completedAt: 2 })),
    ).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          kind: "stream",
          value: expect.objectContaining({
            replacementReset: expect.objectContaining({ state: "completed", completedAt: 2 }),
          }),
        }),
      ]),
    })
  })

  it("exposes explicit portable restore refusal reasons", () => {
    for (const reason of ["not_quiescent", "dependency_unavailable", "target_incompatible"] as const) {
      expect(new WorkGraphArchiveRestoreError(reason)).toMatchObject({
        code: "archive_restore_rejected",
        reason,
      })
    }
  })

  it("rejects duplicate, noncanonical, owner-bearing, adapter-bearing, and secret-bearing records", async () => {
    const cases = [
      value([
        { kind: "stream", id: "stream_1", value: {} },
        { kind: "stream", id: "stream_1", value: {} },
      ]),
      value([
        { kind: "stream", id: "stream_2", value: {} },
        { kind: "stream", id: "stream_1", value: {} },
      ]),
      value([{ kind: "stream", id: "stream_1", value: { ownerUserId: "another-user" } }]),
      value([{ kind: "stream", id: "stream_1", value: { storage: { _id: "convex-row" } } }]),
      value([{ kind: "source_view", id: "view_1", value: { accessToken: "secret" } }]),
      value([{ kind: "source_view", id: "view_1", value: { header: "Bearer secret-value" } }]),
    ]

    for (const archive of cases) {
      await expect(validateWorkGraphArchive(archive)).rejects.toBeInstanceOf(WorkGraphArchiveRestoreError)
    }
  })

  it("hashes equivalent object-key order identically", async () => {
    const fields = {
      schemaVersion: 1,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      provenance: { actor: { type: "user", id: "user_1" } },
      workgraphId: "workgraph_default",
      title: "Ship",
      lifecycleState: "active",
      visibility: "visible",
      pinned: false,
      executionDefaults: {},
      recapDefaults: {},
      activity: { lastActivityAt: 1, recapDueAt: 2 },
      durableEffectCount: 0,
      sourceRevisionRefs: [],
    }
    const first = WorkGraphArchiveSchema.parse(value([{ kind: "stream", id: "stream_1", value: fields }]))
    const second = WorkGraphArchiveSchema.parse(
      value([{ kind: "stream", id: "stream_1", value: { ...fields, activity: { recapDueAt: 2, lastActivityAt: 1 } } }]),
    )

    await expect(hashWorkGraphArchive(first)).resolves.toBe(await hashWorkGraphArchive(second))
  })
})

function value(records: Array<{ kind: string; id: string; value: Record<string, unknown> }>) {
  return {
    version: 1,
    organizationId: "organization_1",
    ownerUserId: "owner_1",
    exportedAt: 1,
    records,
  }
}

function canonicalRecords() {
  const publicRecord = {
    schemaVersion: 1,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    provenance: { actor: { type: "user", id: "user_1" } },
  }
  const storedMutable = { schemaVersion: 1, version: 1, createdAt: 1, updatedAt: 1 }
  const source = {
    workSourceId: "source_1",
    revisionId: "revision_1",
    contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  }
  const resolvedExecution = {
    environment: { kind: "hosted_workspace" },
    harness: "opencode",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: [],
    connectionIds: [],
  }
  return [
    {
      kind: "admission_proposal",
      id: "proposal_1",
      value: {
        ...publicRecord,
        workgraphId: "workgraph_default",
        proposalKind: "source",
        state: "proposed",
        source,
        generation: { method: "agent_session", sessionId: "session_plan", generatedAt: 1 },
        planningEvidence: { placementMatches: [], duplicateMatches: [] },
        suggestedPlacement: { mode: "new_stream", streamTitle: "Ship" },
        placementMatches: [],
        proposedOutcomes: [],
        proposedWorkItems: [],
        duplicateMatches: [],
      },
    },
    {
      kind: "attempt",
      id: "attempt_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        workItemId: "work_item_1",
        attemptNumber: 1,
        state: "result",
        resolvedExecution,
        admittedAt: 1,
        startedAt: 1,
        finishedAt: 2,
        result: { summary: "Finished", artifactRefs: ["artifact_1"], finishedAt: 2 },
        sourceRevisionRefs: [source],
      },
    },
    {
      kind: "agent_checkpoint",
      id: "checkpoint_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        workItemId: "work_item_1",
        attemptId: "attempt_1",
        sessionBindingId: "binding_1",
        level: "progress",
        summary: "Validated the release boundary",
        evidenceIds: ["evidence_1"],
        occurredAt: 1,
      },
    },
    {
      kind: "change",
      id: "change_1",
      value: {
        schemaVersion: 1,
        cursor: "1",
        eventId: "event_1",
        operationId: "operation_1",
        streamId: "stream_1",
        resource: { type: "stream", id: "stream_1" },
        changeType: "stream_created",
        payload: { streamId: "stream_1" },
        createdAt: 1,
      },
    },
    {
      kind: "completed_external_effect",
      id: "external_effect_1",
      value: {
        schemaVersion: 1,
        operationId: "operation_1",
        effectType: "intake_external_sync",
        idempotencyKey: "external_sync_1",
        payload: { candidateId: "candidate_1", effect: "accepted" },
        status: "completed",
        availableAt: 1,
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    },
    {
      kind: "decision",
      id: "decision_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        state: "pending",
        proposedBy: { type: "agent", id: "agent_1" },
        question: "Ship now?",
        options: [{ id: "yes", label: "Yes" }],
        affectedWorkItemIds: ["work_item_1"],
        sourceRevisionRefs: [source],
      },
    },
    {
      kind: "decision_work_item",
      id: "decision_work_item_1",
      value: { schemaVersion: 1, createdAt: 1, decisionId: "decision_1", workItemId: "work_item_1" },
    },
    {
      kind: "durable_effect_receipt",
      id: "receipt_1",
      value: {
        schemaVersion: 1,
        createdAt: 1,
        streamId: "stream_1",
        attemptId: "attempt_1",
        effectKind: "pull_request",
        idempotencyKey: "effect_1",
        externalReference: { url: "https://example.com/pr/1" },
        provenance: publicRecord.provenance,
      },
    },
    {
      kind: "event",
      id: "event_1",
      value: {
        schemaVersion: 1,
        streamId: "stream_1",
        sequence: 1,
        type: "stream_created",
        payload: { streamId: "stream_1" },
        provenance: {
          actor: { type: "user", id: "user_1" },
          operationId: "operation_1",
          requestId: "request_1",
        },
        occurredAt: 1,
      },
    },
    {
      kind: "evidence",
      id: "evidence_1",
      value: {
        schemaVersion: 1,
        kind: "finding",
        subject: { type: "work_item", workItemId: "work_item_1" },
        summary: "Found the cause",
        recordedAt: 1,
        recordedBy: { type: "agent", id: "agent_1" },
      },
    },
    {
      kind: "external_identity",
      id: "identity_1",
      value: {
        schemaVersion: 1,
        createdAt: 1,
        updatedAt: 1,
        intakeCandidateId: "candidate_1",
        provider: "github",
        teamConnectionId: "connection_1",
        externalId: "issue_1",
        metadata: {},
      },
    },
    {
      kind: "intake_candidate",
      id: "candidate_1",
      value: {
        ...storedMutable,
        workgraphId: "workgraph_default",
        candidateKind: "session",
        sessionId: "session_1",
        title: "Brainstorm",
        body: "Plan the launch",
        state: "unorganized",
      },
    },
    {
      kind: "migration_intake",
      id: "migration_1",
      value: {
        ...storedMutable,
        legacyTable: "runs_current",
        legacyRecordId: "run_1",
        intakeKind: "work_mapping_review",
        reason: "Needs owner mapping",
        rawReference: { runId: "run_1" },
        status: "pending_review",
      },
    },
    {
      kind: "notification",
      id: "notification_1",
      value: {
        schemaVersion: 1,
        version: 1,
        kind: "actionable_recap",
        state: "unread",
        streamId: "stream_1",
        recapId: "recap_1",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    {
      kind: "operation_result",
      id: "operation_1",
      value: {
        schemaVersion: 1,
        createdAt: 1,
        commandType: "create_stream",
        requestHash: "0".repeat(64),
        resultStatus: 200,
        result: { ok: true, operationId: "operation_1", cursor: "1", value: { streamId: "stream_1" } },
        changeCursor: "1",
      },
    },
    {
      kind: "outcome",
      id: "outcome_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        title: "Release",
        state: "active",
        successCriteria: ["Deployed"],
        evidenceIds: [],
        sourceRevisionRefs: [source],
      },
    },
    {
      kind: "recap",
      id: "recap_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        activityRange: { fromSequence: 1, toSequence: 1, quietSince: 1 },
        summary: "Release is ready",
        actionableReferences: [{ type: "work_item", id: "work_item_1" }],
        generation: {
          state: "succeeded",
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "medium",
          generatedAt: 2,
          method: "agent_session",
          sessionId: "session_recap",
        },
        sourceRevisionRefs: [source],
      },
    },
    {
      kind: "record_source_revision",
      id: "record_source_1",
      value: {
        schemaVersion: 1,
        createdAt: 1,
        recordType: "stream",
        recordId: "stream_1",
        workSourceId: "source_1",
        sourceRevisionId: "revision_1",
        ordinal: 0,
      },
    },
    {
      kind: "runtime_effect",
      id: "runtime_effect_1",
      value: {
        schemaVersion: 1,
        effectKind: "command",
        resourceType: "stream",
        resourceId: "stream_1",
        idempotencyKey: "operation_1",
        payload: { streamId: "stream_1" },
        state: "completed",
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      },
    },
    {
      kind: "session_binding",
      id: "binding_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        sessionId: "session_1",
        projectId: "project_1",
        currentWorkItemId: "work_item_1",
        currentAttemptId: "attempt_1",
        state: "active",
        boundAt: 1,
      },
    },
    {
      kind: "source_view",
      id: "source_view_1",
      value: {
        ...storedMutable,
        workgraphId: "workgraph_default",
        teamConnectionId: "connection_1",
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "claxedo/claxedo" },
        syncPolicy: "announce",
        status: "active",
      },
    },
    {
      kind: "stream",
      id: "stream_1",
      value: {
        ...publicRecord,
        workgraphId: "workgraph_default",
        title: "Ship",
        lifecycleState: "active",
        visibility: "visible",
        pinned: false,
        executionDefaults: {},
        recapDefaults: {},
        activity: { lastActivityAt: 1, recapDueAt: 2 },
        durableEffectCount: 1,
        sourceRevisionRefs: [source],
      },
    },
    {
      kind: "terminal_scheduled_job",
      id: "scheduled_job_1",
      value: {
        schemaVersion: 1,
        version: 1,
        streamId: "stream_1",
        jobType: "recap",
        subjectId: "stream_1:1",
        dueAt: 1,
        status: "completed",
        payload: { sessionId: "session_recap" },
        leaseEpoch: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    },
    {
      kind: "work_item",
      id: "work_item_1",
      value: {
        ...publicRecord,
        streamId: "stream_1",
        outcomeId: "outcome_1",
        title: "Deploy",
        state: "result_ready",
        priority: 0,
        dependencyIds: ["work_item_2"],
        sourceRevisionRefs: [source],
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{ id: "done", kind: "artifact", description: "Deployment artifact" }],
        },
        evidenceIds: ["evidence_1"],
      },
    },
    {
      kind: "work_item_dependency",
      id: "dependency_1",
      value: {
        schemaVersion: 1,
        createdAt: 1,
        workItemId: "work_item_1",
        dependsOnWorkItemId: "work_item_2",
        dependencyKind: "blocks",
      },
    },
    {
      kind: "work_source",
      id: "source_1",
      value: {
        ...storedMutable,
        workgraphId: "workgraph_default",
        title: "Launch plan",
        sourceKind: "manual",
        metadata: {},
        latestRevisionId: "revision_1",
        revisionCount: 1,
      },
    },
    {
      kind: "work_source_revision",
      id: "revision_1",
      value: {
        schemaVersion: 1,
        workSourceId: "source_1",
        revisionNumber: 1,
        content: "hello",
        contentHash: source.contentHash,
        origin: { kind: "manual" },
        createdAt: 1,
        createdBy: { type: "user", id: "user_1" },
      },
    },
    {
      kind: "workgraph",
      id: "workgraph_default",
      value: { ...publicRecord, defaults: { execution: {}, recap: {} } },
    },
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}
