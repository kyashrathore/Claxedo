import { z } from "zod"
import { WorkGraphActorSchema } from "./context"
import {
  AgentCheckpointIDSchema,
  RunIDSchema,
  DecisionIDSchema,
  DurableEffectReceiptIDSchema,
  EvidenceIDSchema,
  OperationIDSchema,
  OwnerUserIDSchema,
  SessionBindingIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
} from "./ids"
import { ResolvedExecutionProfileSchema } from "./execution"

const text = z.string().trim().min(1)
const summary = text.max(1_000)
const timestamp = z.number().int().nonnegative()

export const StreamActivityGranularitySchema = z.enum(["milestones", "progress", "detailed"])
export type StreamActivityGranularity = z.infer<typeof StreamActivityGranularitySchema>
export const DEFAULT_STREAM_ACTIVITY_GRANULARITY: StreamActivityGranularity = "progress"

export const SessionBindingStateSchema = z.enum(["active", "released"])
export type SessionBindingState = z.infer<typeof SessionBindingStateSchema>

export const SessionBindingDtoSchema = z
  .strictObject({
    recordType: z.literal("session_binding"),
    schemaVersion: z.literal(1),
    ownerUserId: OwnerUserIDSchema,
    id: SessionBindingIDSchema,
    version: z.number().int().positive(),
    streamId: StreamIDSchema,
    sessionId: text.max(512),
    projectId: text.max(512),
    currentWorkItemId: WorkItemIDSchema.optional(),
    currentRunId: RunIDSchema.optional(),
    state: SessionBindingStateSchema,
    boundAt: timestamp,
    releasedAt: timestamp.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: z.strictObject({ actor: WorkGraphActorSchema, operationId: OperationIDSchema.optional() }),
  })
  .superRefine((binding, context) => {
    if (binding.currentRunId && !binding.currentWorkItemId) {
      context.addIssue({
        code: "custom",
        path: ["currentRunId"],
        message: "A bound Run requires a current Work Item",
      })
    }
    if ((binding.state === "released") === (binding.releasedAt !== undefined)) return
    context.addIssue({
      code: "custom",
      path: ["releasedAt"],
      message: "Released bindings require releasedAt and active bindings cannot have it",
    })
  })
export type SessionBindingDto = z.infer<typeof SessionBindingDtoSchema>

export const AgentCheckpointLevelSchema = z.enum(["milestone", "progress", "detail"])
export type AgentCheckpointLevel = z.infer<typeof AgentCheckpointLevelSchema>

export const AgentCheckpointDtoSchema = z.strictObject({
  recordType: z.literal("agent_checkpoint"),
  schemaVersion: z.literal(1),
  ownerUserId: OwnerUserIDSchema,
  id: AgentCheckpointIDSchema,
  version: z.number().int().positive(),
  streamId: StreamIDSchema,
  workItemId: WorkItemIDSchema,
  runId: RunIDSchema,
  sessionBindingId: SessionBindingIDSchema,
  level: AgentCheckpointLevelSchema,
  summary,
  evidenceIds: z.array(EvidenceIDSchema).max(100),
  occurredAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance: z.strictObject({ actor: WorkGraphActorSchema, operationId: OperationIDSchema.optional() }),
})
export type AgentCheckpointDto = z.infer<typeof AgentCheckpointDtoSchema>

export const TaskActivitySourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("event"), id: text }),
  z.strictObject({ type: z.literal("run"), id: RunIDSchema }),
  z.strictObject({ type: z.literal("checkpoint"), id: AgentCheckpointIDSchema }),
  z.strictObject({ type: z.literal("decision"), id: DecisionIDSchema }),
  z.strictObject({ type: z.literal("evidence"), id: EvidenceIDSchema }),
  z.strictObject({ type: z.literal("external_effect"), id: DurableEffectReceiptIDSchema }),
])
export type TaskActivitySource = z.infer<typeof TaskActivitySourceSchema>

export const TaskActivityEntrySchema = z.strictObject({
  id: text.max(1_024),
  streamId: StreamIDSchema,
  workItemId: WorkItemIDSchema,
  category: z.enum(["lifecycle", "run", "checkpoint", "decision", "evidence", "external_effect"]),
  importance: StreamActivityGranularitySchema,
  summary,
  occurredAt: timestamp,
  actor: WorkGraphActorSchema,
  source: TaskActivitySourceSchema,
})
export type TaskActivityEntry = z.infer<typeof TaskActivityEntrySchema>

export const TaskActivityPageCursorSchema = z.string().trim().min(1).max(1_024).brand("TaskActivityPageCursor")
export type TaskActivityPageCursor = z.infer<typeof TaskActivityPageCursorSchema>

export const TaskActivityListInputSchema = z.strictObject({
  workItemId: WorkItemIDSchema,
  granularity: StreamActivityGranularitySchema.default(DEFAULT_STREAM_ACTIVITY_GRANULARITY),
  after: TaskActivityPageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type TaskActivityListInput = z.infer<typeof TaskActivityListInputSchema>

export const TaskActivityPageSchema = z
  .strictObject({
    entries: z.array(TaskActivityEntrySchema),
    hasMore: z.boolean(),
    nextCursor: TaskActivityPageCursorSchema.optional(),
  })
  .superRefine((page, context) => {
    if (page.hasMore === Boolean(page.nextCursor)) return
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "An activity cursor is required exactly when more entries exist",
    })
  })
export type TaskActivityPage = z.infer<typeof TaskActivityPageSchema>

export const BindSessionInputSchema = z.strictObject({
  operationId: OperationIDSchema,
  streamId: StreamIDSchema,
  sessionId: text.max(512),
  projectId: text.max(512),
})
export type BindSessionInput = z.infer<typeof BindSessionInputSchema>

export const AttachSessionTaskInputSchema = z.strictObject({
  operationId: OperationIDSchema,
  bindingId: SessionBindingIDSchema,
  expectedVersion: z.number().int().positive(),
  workItemId: WorkItemIDSchema,
  resolvedExecution: ResolvedExecutionProfileSchema,
})
export type AttachSessionTaskInput = z.infer<typeof AttachSessionTaskInputSchema>

export const RecordAgentCheckpointInputSchema = z.strictObject({
  operationId: OperationIDSchema,
  bindingId: SessionBindingIDSchema,
  level: AgentCheckpointLevelSchema,
  summary,
  evidenceIds: z.array(EvidenceIDSchema).max(100).default([]),
  occurredAt: timestamp.optional(),
})
export type RecordAgentCheckpointInput = z.infer<typeof RecordAgentCheckpointInputSchema>

export const ReleaseSessionBindingInputSchema = z.strictObject({
  operationId: OperationIDSchema,
  bindingId: SessionBindingIDSchema,
  expectedVersion: z.number().int().positive(),
})
export type ReleaseSessionBindingInput = z.infer<typeof ReleaseSessionBindingInputSchema>

export type TaskActivityPageCursorErrorReason = "invalid" | "owner_mismatch" | "work_item_mismatch" | "granularity_mismatch"

export class TaskActivityPageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: TaskActivityPageCursorErrorReason) {
    super("Task activity cursor is not valid for this owner, Work Item, and granularity")
    this.name = "TaskActivityPageCursorError"
  }
}

export function createTaskActivityPageCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  workItemId: string
  granularity: StreamActivityGranularity
  occurredAt: number
  entryId: string
}>) {
  const cursor = [
    "wgac1",
    encode(input.organizationId),
    encode(input.ownerUserId),
    encode(input.workItemId),
    input.granularity,
    integer(input.occurredAt),
    encode(input.entryId),
  ].join(":")
  if (cursor.length > 1_024) throw new TaskActivityPageCursorError("invalid")
  return TaskActivityPageCursorSchema.parse(cursor)
}

export function readTaskActivityPageCursor(
  cursor: string,
  organizationId: string,
  ownerUserId: string,
  workItemId: string,
  granularity: StreamActivityGranularity,
) {
  if (cursor.length > 1_024) throw new TaskActivityPageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 7 || parts[0] !== "wgac1") throw new TaskActivityPageCursorError("invalid")
  if (decode(parts[1]!) !== organizationId || decode(parts[2]!) !== ownerUserId) {
    throw new TaskActivityPageCursorError("owner_mismatch")
  }
  if (decode(parts[3]!) !== workItemId) throw new TaskActivityPageCursorError("work_item_mismatch")
  if (parts[4] !== granularity) throw new TaskActivityPageCursorError("granularity_mismatch")
  return { occurredAt: integer(parts[5]), entryId: decode(parts[6]!) }
}

function encode(value: string) {
  if (!value) throw new TaskActivityPageCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new TaskActivityPageCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof TaskActivityPageCursorError) throw error
    throw new TaskActivityPageCursorError("invalid")
  }
}

function integer(value: string | number | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TaskActivityPageCursorError("invalid")
  }
  return parsed
}
