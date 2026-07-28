import { describe, expect, it } from "vitest"
import { CompleteRunCommandSchema, RecordRunCheckpointCommandSchema } from "./commands"

describe("Run action commands", () => {
  it("parses a scoped checkpoint and defaults evidence references", () => {
    expect(RecordRunCheckpointCommandSchema.parse({
      version: 1,
      type: "record_run_checkpoint",
      runId: "run_1",
      sessionId: "session_1",
      workspaceId: "/workspace",
      generation: 3,
      level: "progress",
      summary: "Validated the persistence boundary",
    })).toMatchObject({ evidenceIds: [] })
  })

  it("requires completion to carry semantic output and evidence", () => {
    const command = {
      version: 1,
      type: "complete_run",
      runId: "run_1",
      sessionId: "session_1",
      workspaceId: "/workspace",
      generation: 3,
      summary: "Implemented and verified the change",
      evidence: [{
        requirementId: "tests",
        evidence: { kind: "test_result", summary: "Focused tests pass", passed: true },
      }],
    }
    expect(CompleteRunCommandSchema.parse(command)).toMatchObject({ artifacts: [] })
    expect(() => CompleteRunCommandSchema.parse({ ...command, evidence: [] })).toThrow()
    expect(() => CompleteRunCommandSchema.parse({ ...command, streamId: "stream_1" })).toThrow()
  })
})
