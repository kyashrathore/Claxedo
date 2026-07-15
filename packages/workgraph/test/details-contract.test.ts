import { describe, expect, test } from "vitest"
import {
  AttemptDetailDtoSchema,
  WorkItemAttemptPageCursorError,
  createWorkItemAttemptPageCursor,
  readWorkItemAttemptPageCursor,
} from "../src/contracts/details"

describe("WorkGraph detail contracts", () => {
  test("round-trips an owner- and Work Item-bound Attempt cursor", () => {
    const cursor = createWorkItemAttemptPageCursor({
      organizationId: "organization_a",
      ownerUserId: "owner_a",
      workItemId: "item_a",
      attemptNumber: 2,
      attemptId: "attempt_2",
    })
    expect(readWorkItemAttemptPageCursor(cursor, "organization_a", "owner_a", "item_a")).toEqual({
      attemptNumber: 2,
      attemptId: "attempt_2",
    })
    expect(() => readWorkItemAttemptPageCursor(cursor, "organization_a", "owner_b", "item_a"))
      .toThrowError(expect.objectContaining<Partial<WorkItemAttemptPageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readWorkItemAttemptPageCursor(cursor, "organization_a", "owner_a", "item_b"))
      .toThrowError(expect.objectContaining<Partial<WorkItemAttemptPageCursorError>>({ reason: "work_item_mismatch" }))
  })

  test("admits only explicit stored execution references", () => {
    const attempt = {
      recordType: "attempt",
      schemaVersion: 1,
      ownerUserId: "owner_a",
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      provenance: { actor: { type: "user", id: "owner_a" } },
      id: "attempt_a",
      streamId: "stream_a",
      workItemId: "item_a",
      attemptNumber: 1,
      state: "running",
      resolvedExecution: {
        environment: { kind: "local_worktree" },
        harness: "codex",
        agent: "developer",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: [],
        connectionIds: [],
      },
      admittedAt: 1,
      sourceRevisionRefs: [],
    }
    expect(AttemptDetailDtoSchema.parse({ attempt, executionReferences: { sessionId: "session_a" } }))
      .toMatchObject({ executionReferences: { sessionId: "session_a" } })
    expect(() => AttemptDetailDtoSchema.parse({ attempt, executionReferences: {} })).toThrow()
  })
})
