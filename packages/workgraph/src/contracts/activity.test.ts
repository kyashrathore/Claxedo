import { describe, expect, it } from "vitest"
import {
  AgentCheckpointDtoSchema,
  SessionBindingDtoSchema,
  TaskActivityEntrySchema,
  TaskActivityListInputSchema,
  TaskActivityPageCursorError,
  createTaskActivityPageCursor,
  readTaskActivityPageCursor,
} from "./activity"

const provenance = { actor: { type: "agent" as const, id: branded("agent") }, operationId: branded("operation") }

describe("bounded Task activity contracts", () => {
  it("defaults activity reads to progress and binds cursors to tenant, Task, and granularity", () => {
    expect(TaskActivityListInputSchema.parse({ workItemId: "task", limit: 25 })).toMatchObject({
      granularity: "progress",
    })
    const cursor = createTaskActivityPageCursor({
      organizationId: "organization",
      ownerUserId: "owner",
      workItemId: "task",
      granularity: "progress",
      occurredAt: 10,
      entryId: "checkpoint:one",
    })
    expect(readTaskActivityPageCursor(cursor, "organization", "owner", "task", "progress")).toEqual({
      occurredAt: 10,
      entryId: "checkpoint:one",
    })
    expect(() => readTaskActivityPageCursor(cursor, "organization", "other", "task", "progress"))
      .toThrow(expect.objectContaining<Partial<TaskActivityPageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readTaskActivityPageCursor(cursor, "organization", "owner", "task", "milestones"))
      .toThrow(expect.objectContaining<Partial<TaskActivityPageCursorError>>({ reason: "granularity_mismatch" }))
  })

  it("represents attached Session bindings without permitting a Run outside a Task", () => {
    const active = {
      recordType: "session_binding" as const,
      schemaVersion: 1 as const,
      ownerUserId: branded("owner"),
      id: branded("binding"),
      version: 1,
      streamId: branded("stream"),
      sessionId: "session",
      projectId: "project",
      currentWorkItemId: branded("task"),
      currentRunId: branded("run"),
      state: "active" as const,
      boundAt: 1,
      createdAt: 1,
      updatedAt: 1,
      provenance,
    }
    expect(SessionBindingDtoSchema.parse(active)).toMatchObject(active)
    expect(() => SessionBindingDtoSchema.parse({
      ...active,
      currentWorkItemId: undefined,
    })).toThrow("A bound Run requires a current Work Item")
    expect(() => SessionBindingDtoSchema.parse({
      ...active,
      state: "released",
    })).toThrow("Released bindings require releasedAt")
  })

  it("stores concise authored checkpoints and rejects raw transcript-shaped fields", () => {
    const checkpoint = {
      recordType: "agent_checkpoint" as const,
      schemaVersion: 1 as const,
      ownerUserId: branded("owner"),
      id: branded("checkpoint"),
      version: 1,
      streamId: branded("stream"),
      workItemId: branded("task"),
      runId: branded("run"),
      sessionBindingId: branded("binding"),
      level: "progress" as const,
      summary: "Validated the storage boundary",
      evidenceIds: [branded("evidence")],
      occurredAt: 2,
      createdAt: 2,
      updatedAt: 2,
      provenance,
    }
    expect(AgentCheckpointDtoSchema.parse(checkpoint)).toMatchObject(checkpoint)
    expect(() => AgentCheckpointDtoSchema.parse({ ...checkpoint, transcript: "private reasoning" })).toThrow()
    expect(() => AgentCheckpointDtoSchema.parse({ ...checkpoint, summary: "x".repeat(1_001) })).toThrow()
    expect(() => AgentCheckpointDtoSchema.parse({
      ...checkpoint,
      evidenceIds: Array.from({ length: 101 }, (_, index) => branded(`evidence_${index}`)),
    })).toThrow()
  })

  it("normalizes canonical facts without carrying messages, commands, or reasoning", () => {
    const entry = {
      id: "run:run:running",
      streamId: branded("stream"),
      workItemId: branded("task"),
      category: "run" as const,
      importance: "progress" as const,
      summary: "Execution started",
      occurredAt: 3,
      actor: { type: "system" as const, id: branded("runtime") },
      source: { type: "run" as const, id: branded("run") },
    }
    expect(TaskActivityEntrySchema.parse(entry)).toMatchObject(entry)
    expect(() => TaskActivityEntrySchema.parse({ ...entry, shellCommand: "git status" })).toThrow()
    expect(() => TaskActivityEntrySchema.parse({ ...entry, message: "raw Session message" })).toThrow()
  })
})

function branded<Type>(value: string) {
  return value as Type
}
