import { describe, expect, test } from "vitest"
import {
  RunDetailDtoSchema,
  WorkItemRunPageCursorError,
  createWorkItemRunPageCursor,
  readWorkItemRunPageCursor,
} from "../src/contracts/details"

describe("WorkGraph detail contracts", () => {
  test("round-trips an owner- and Work Item-bound Run cursor", () => {
    const cursor = createWorkItemRunPageCursor({
      organizationId: "organization_a",
      ownerUserId: "owner_a",
      workItemId: "item_a",
      runNumber: 2,
      runId: "run_2",
    })
    expect(readWorkItemRunPageCursor(cursor, "organization_a", "owner_a", "item_a")).toEqual({
      runNumber: 2,
      runId: "run_2",
    })
    expect(() => readWorkItemRunPageCursor(cursor, "organization_a", "owner_b", "item_a"))
      .toThrowError(expect.objectContaining<Partial<WorkItemRunPageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readWorkItemRunPageCursor(cursor, "organization_a", "owner_a", "item_b"))
      .toThrowError(expect.objectContaining<Partial<WorkItemRunPageCursorError>>({ reason: "work_item_mismatch" }))
  })

  test("admits only explicit stored execution references", () => {
    const run = {
      recordType: "run",
      schemaVersion: 1,
      ownerUserId: "owner_a",
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      provenance: { actor: { type: "user", id: "owner_a" } },
      id: "run_a",
      streamId: "stream_a",
      workItemId: "item_a",
      runNumber: 1,
      generation: 1,
      state: "running",
      resolvedExecution: {
        environment: { kind: "local_worktree", placement: "shared" },
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
    expect(RunDetailDtoSchema.parse({ run, executionReferences: { sessionId: "session_a" } }))
      .toMatchObject({ executionReferences: { sessionId: "session_a" } })
    expect(() => RunDetailDtoSchema.parse({ run, executionReferences: {} })).toThrow()
  })
})
