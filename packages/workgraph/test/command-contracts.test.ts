import { describe, expect, it } from "vitest"
import {
  ChangeEnvelopeSchema,
  CommandResultSchema,
  WorkGraphCommandRequestSchema,
  WorkGraphCommandSchema,
  WorkGraphEventEnvelopeSchema,
} from "../src/contracts"

const commandSamples = [
  {
    version: 1,
    type: "update_workgraph_defaults",
    expectedVersion: 1,
    defaults: {
      execution: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
    },
  },
  { version: 1, type: "create_work_source", title: "Launch", content: "Ship the launch" },
  {
    version: 1,
    type: "create_work_source",
    title: "Launch",
    content: "Ship the launch",
    authoring: {
      adapterId: "claxedo_docs",
      projectId: "project-1",
      documentId: "doc-1",
      snapshotId: "doc-revision-1",
      placement: "local",
      authoredAt: 1,
      authoredBy: { type: "user", id: "owner" },
      contentHash: "a".repeat(64),
    },
  },
  {
    version: 1,
    type: "revise_work_source",
    workSourceId: "source-1",
    expectedRevisionId: "revision-1",
    content: "Ship the launch safely",
  },
  { version: 1, type: "create_stream", title: "Launch", description: "Ship it" },
  {
    version: 1,
    type: "update_stream",
    streamId: "stream-1",
    expectedVersion: 2,
    title: "Launch safely",
  },
  {
    version: 1,
    type: "create_outcome",
    streamId: "stream-1",
    title: "Available",
    successCriteria: ["Production responds"],
  },
  { version: 1, type: "update_outcome", outcomeId: "outcome-1", expectedVersion: 1, title: "Generally available" },
  {
    version: 1,
    type: "create_work_item",
    streamId: "stream-1",
    outcomeId: "outcome-1",
    title: "Deploy",
    completionContract: {
      version: 1,
      mode: "all",
      requirements: [
        { id: "requirement-1", kind: "verification", description: "Smoke passes", instructions: "Open production" },
      ],
    },
  },
  { version: 1, type: "update_work_item", workItemId: "work-item-1", expectedVersion: 4, priority: 1 },
  {
    version: 1,
    type: "propose_admission",
    source: { workSourceId: "source-1", revisionId: "revision-1", contentHash: "a".repeat(64) },
  },
  { version: 1, type: "dismiss_admission", proposalId: "proposal-1", expectedVersion: 3 },
  { version: 1, type: "reopen_admission", proposalId: "proposal-1", expectedVersion: 4 },
  {
    version: 1,
    type: "confirm_admission",
    proposalId: "proposal-1",
    expectedVersion: 1,
    source: { workSourceId: "source-1", revisionId: "revision-1", contentHash: "a".repeat(64) },
    selection: { mode: "create", streamTitle: "Launch" },
  },
  { version: 1, type: "retry_admission_planning", proposalId: "proposal-1", expectedVersion: 3 },
  {
    version: 1,
    type: "set_stream_lifecycle",
    streamId: "stream-1",
    expectedVersion: 2,
    state: "paused",
    reason: "Review",
  },
  { version: 1, type: "set_stream_visibility", streamId: "stream-1", expectedVersion: 3, visibility: "archived" },
  { version: 1, type: "approve_work_item", workItemId: "work-item-1", expectedVersion: 4 },
  { version: 1, type: "reject_work_item", workItemId: "work-item-1", expectedVersion: 4, reason: "Not needed" },
  { version: 1, type: "approve_work_items", approvals: [{ workItemId: "work-item-1", expectedVersion: 4 }] },
  { version: 1, type: "cancel_attempt", attemptId: "attempt-1", expectedVersion: 1, reason: "Owner cancelled" },
  { version: 1, type: "retry_work_item", workItemId: "work-item-1", expectedVersion: 5 },
  {
    version: 1,
    type: "propose_decision",
    streamId: "stream-1",
    question: "Proceed?",
    options: [{ id: "yes", label: "Proceed" }],
    affectedWorkItemIds: ["work-item-1"],
  },
  { version: 1, type: "answer_decision", decisionId: "decision-1", expectedVersion: 1, optionId: "yes" },
  { version: 1, type: "dismiss_decision", decisionId: "decision-1", expectedVersion: 1, reason: "No longer relevant" },
  {
    version: 1,
    type: "record_evidence",
    subject: { type: "work_item", workItemId: "work-item-1" },
    evidence: { kind: "finding", summary: "Verified manually", sourceRef: "run-1" },
  },
  { version: 1, type: "close_outcome", outcomeId: "outcome-1", expectedVersion: 3, reason: "Criteria met" },
  { version: 1, type: "reopen_outcome", outcomeId: "outcome-1", expectedVersion: 4, reason: "Regression" },
  { version: 1, type: "close_stream", streamId: "stream-1", expectedVersion: 5, reason: "Delivered" },
  { version: 1, type: "delete_stream", streamId: "stream-1", expectedVersion: 5, reason: "Discard draft" },
  {
    version: 1,
    type: "set_stream_charter",
    streamId: "stream-1",
    expectedVersion: 5,
    charter: { text: "Open draft pull requests.", hash: "c".repeat(64) },
  },
  { version: 1, type: "call_master", streamId: "stream-1", expectedVersion: 5, message: "Rebase before landing." },
  {
    version: 1,
    type: "request_public_pr_confirmation",
    streamId: "stream-1",
    expectedVersion: 5,
    repository: "claxedo/app",
    title: "Release WorkGraph V2",
  },
  { version: 1, type: "confirm_public_pr", streamId: "stream-1", expectedVersion: 5 },
  {
    version: 1,
    type: "record_master_audit",
    streamId: "stream-1",
    expectedVersion: 5,
    sessionId: "ses_master_stream-1",
    wakeTrigger: "task_settled",
    charterHash: "d".repeat(64),
    citedCharterClause: "Open draft pull requests.",
    modelVersion: "openai/gpt-5",
    reasoningSummary: "Admitted a serialized turn.",
    toolCalls: [],
    resultingDiffs: ["file:diff.patch"],
    evidenceIds: [],
    outcome: "admitted",
  },
] as const

describe("WorkGraph command contracts", () => {
  it("accepts the complete version-one command vocabulary", () => {
    commandSamples.forEach((command) => expect(WorkGraphCommandSchema.parse(command)).toEqual(command))
  })

  it("keeps owner selection and credentials outside every command DTO", () => {
    commandSamples.forEach((command) => {
      expect(WorkGraphCommandSchema.safeParse({ ...command, ownerUserId: "another-user" }).success).toBe(false)
      expect(WorkGraphCommandSchema.safeParse({ ...command, apiKey: "secret" }).success).toBe(false)
    })

    expect(
      WorkGraphCommandSchema.safeParse({
        version: 1,
        type: "create_work_item",
        streamId: "stream-1",
        title: "Deploy",
        connection: { connectionId: "connection-1", token: "secret" },
      }).success,
    ).toBe(false)
    expect(
      WorkGraphCommandSchema.safeParse({
        ...commandSamples[12],
        selection: { mode: "existing", streamId: "stream-1", ownerUserId: "another-user" },
      }).success,
    ).toBe(false)
    expect(
      WorkGraphCommandSchema.safeParse({
        version: 1,
        type: "confirm_admission",
        proposalId: "proposal-1",
        source: { workSourceId: "source-1", revisionId: "revision-1", contentHash: "a".repeat(64) },
        selection: { mode: "create", streamTitle: "Launch" },
      }).success,
    ).toBe(false)
    expect(
      WorkGraphCommandSchema.safeParse({
        ...commandSamples[13],
        selection: { mode: "replace", streamId: "stream-1" },
      }).success,
    ).toBe(false)
    expect(
      WorkGraphCommandSchema.safeParse({
        ...commandSamples[13],
        selection: {
          mode: "replace",
          streamId: "stream-1",
          workItems: [{ workItemId: "work-item-1", expectedVersion: 2 }],
        },
      }).success,
    ).toBe(true)
    expect(WorkGraphCommandSchema.safeParse({ ...commandSamples[0], version: 2 }).success).toBe(false)
  })

  it("keeps execution targets on Streams instead of WorkGraph, Outcome, or Task defaults", () => {
    const target = {
      environment: { kind: "local_worktree", directory: "/repo" },
      repository: { baseRevision: "HEAD" },
    }
    expect(WorkGraphCommandSchema.safeParse({
      version: 1,
      type: "create_stream",
      title: "Targeted",
      execution: target,
    }).success).toBe(true)
    expect(WorkGraphCommandSchema.safeParse({
      ...commandSamples[0],
      defaults: { execution: target },
    }).success).toBe(false)
    expect(WorkGraphCommandSchema.safeParse({
      ...commandSamples[6],
      execution: target,
    }).success).toBe(false)
    expect(WorkGraphCommandSchema.safeParse({
      ...commandSamples[8],
      execution: target,
    }).success).toBe(false)
  })

  it("wraps mutations in an operation ID without accepting caller identity", () => {
    expect(WorkGraphCommandRequestSchema.parse({ operationId: "operation-1", command: commandSamples[0] })).toEqual({
      operationId: "operation-1",
      command: commandSamples[0],
    })
    expect(
      WorkGraphCommandRequestSchema.safeParse({
        operationId: "operation-1",
        ownerId: "another-user",
        command: commandSamples[0],
      }).success,
    ).toBe(false)
  })

  it("normalizes success and typed command failures around committed cursors", () => {
    expect(
      CommandResultSchema.parse({
        ok: true,
        operationId: "operation-1",
        cursor: "17",
        value: { streamId: "stream-1" },
      }),
    ).toEqual({
      ok: true,
      operationId: "operation-1",
      cursor: "17",
      value: { streamId: "stream-1" },
    })
    expect(
      CommandResultSchema.parse({
        ok: false,
        operationId: "operation-1",
        error: {
          code: "version_conflict",
          message: "Expected version 2",
          retryable: true,
          details: { expectedVersion: 2 },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "version_conflict" } })
  })

  it("carries actor and provenance through ordered event and change envelopes", () => {
    const provenance = {
      actor: { type: "agent", id: "agent-1" },
      operationId: "operation-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      causationId: "event-0",
    }
    const event = {
      schemaVersion: 1,
      id: "event-1",
      ownerUserId: "owner-1",
      streamId: "stream-1",
      sequence: 7,
      type: "stream_updated",
      payload: { title: "Launch" },
      provenance,
      occurredAt: 100,
    }
    expect(WorkGraphEventEnvelopeSchema.parse(event)).toEqual(event)
    expect(
      WorkGraphEventEnvelopeSchema.safeParse({ ...event, payload: { connection: { token: "secret" } } }).success,
    ).toBe(false)
    for (const key of ["accessToken", "refresh_token", "cookie", "privateKey", "client-secret"]) {
      expect(
        WorkGraphEventEnvelopeSchema.safeParse({ ...event, payload: { connection: { [key]: "secret" } } }).success,
      ).toBe(false)
    }
    expect(
      ChangeEnvelopeSchema.parse({
        cursor: "18",
        ownerUserId: "owner-1",
        resource: { type: "stream", id: "stream-1" },
        event,
      }),
    ).toMatchObject({ cursor: "18", event: { id: "event-1" } })
  })
})
