import { z } from "zod"
import { AgentCheckpointLevelSchema } from "./activity"
import { AttemptCompletionEvidenceInputSchema, CommandResultSchema, StreamNotesExternalReferenceSchema } from "./commands"
import { AttemptIDSchema, EvidenceIDSchema, OperationIDSchema, StreamIDSchema } from "./ids"

export const WorkGraphAttemptToolNames = ["workgraph_report_progress", "workgraph_complete_task"] as const
export type WorkGraphAttemptToolName = (typeof WorkGraphAttemptToolNames)[number]
export const WorkGraphMasterToolNames = ["workgraph_update_stream_notes", "workgraph_notify_owner"] as const
export type WorkGraphMasterToolName = (typeof WorkGraphMasterToolNames)[number]
export const WorkGraphRuntimeToolNames = [...WorkGraphAttemptToolNames, ...WorkGraphMasterToolNames] as const
export type WorkGraphRuntimeToolName = (typeof WorkGraphRuntimeToolNames)[number]

export const WorkGraphAttemptIdentitySchema = z.strictObject({
  attemptId: AttemptIDSchema,
  streamId: StreamIDSchema.optional(),
  sessionId: z.string().trim().min(1).max(512),
  workspaceId: z.string().trim().min(1).max(1_024),
  leaseEpoch: z.number().int().positive().optional(),
})
export type WorkGraphAttemptIdentity = z.infer<typeof WorkGraphAttemptIdentitySchema>

export const WorkGraphAttemptOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("record_checkpoint"),
    operationId: OperationIDSchema,
    level: AgentCheckpointLevelSchema,
    summary: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(EvidenceIDSchema).max(100).default([]),
  }),
  z.strictObject({
    type: z.literal("complete"),
    operationId: OperationIDSchema,
    summary: z.string().trim().min(1).max(10_000),
    artifacts: z.array(z.string().trim().min(1)).max(100).default([]),
    evidence: z.array(AttemptCompletionEvidenceInputSchema).min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("update_stream_notes"),
    operationId: OperationIDSchema,
    status: z.array(z.string().trim().min(1).max(2_000)).max(100),
    learnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
    externalReferences: z.array(StreamNotesExternalReferenceSchema).max(100).default([]),
  }),
  z.strictObject({
    type: z.literal("notify_owner"),
    operationId: OperationIDSchema,
    message: z.string().trim().min(1).max(4_000),
  }),
])
export type WorkGraphAttemptOperation = z.infer<typeof WorkGraphAttemptOperationSchema>

export const WorkGraphAttemptOperationRequestSchema = z.strictObject({
  version: z.literal(1),
  identity: WorkGraphAttemptIdentitySchema,
  operation: WorkGraphAttemptOperationSchema,
})
export type WorkGraphAttemptOperationRequest = z.infer<typeof WorkGraphAttemptOperationRequestSchema>

export const WorkGraphAttemptOperationResponseSchema = CommandResultSchema
export type WorkGraphAttemptOperationResponse = z.infer<typeof WorkGraphAttemptOperationResponseSchema>
