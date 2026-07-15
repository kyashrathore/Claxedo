import { describe, expect, it } from "vitest"
import { CompleteAttemptCommandSchema, RecordAttemptCheckpointCommandSchema } from "./commands"

describe("Attempt action commands", () => {
  it("parses a scoped checkpoint and defaults evidence references", () => {
    expect(RecordAttemptCheckpointCommandSchema.parse({
      version: 1,
      type: "record_attempt_checkpoint",
      attemptId: "attempt_1",
      sessionId: "session_1",
      workspaceId: "/workspace",
      leaseEpoch: 3,
      level: "progress",
      summary: "Validated the persistence boundary",
    })).toMatchObject({ evidenceIds: [] })
  })

  it("requires completion to carry semantic output and evidence", () => {
    const command = {
      version: 1,
      type: "complete_attempt",
      attemptId: "attempt_1",
      sessionId: "session_1",
      workspaceId: "/workspace",
      leaseEpoch: 3,
      summary: "Implemented and verified the change",
      evidence: [{
        requirementId: "tests",
        evidence: { kind: "test_result", summary: "Focused tests pass", passed: true },
      }],
    }
    expect(CompleteAttemptCommandSchema.parse(command)).toMatchObject({ artifacts: [] })
    expect(() => CompleteAttemptCommandSchema.parse({ ...command, evidence: [] })).toThrow()
    expect(() => CompleteAttemptCommandSchema.parse({ ...command, streamId: "stream_1" })).toThrow()
  })
})
