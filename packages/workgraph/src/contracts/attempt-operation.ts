import { z } from "zod"
import { AgentCheckpointLevelSchema } from "./activity"
import { AttemptCompletionEvidenceInputSchema, CommandResultSchema } from "./commands"
import { AttemptIDSchema, EvidenceIDSchema, OperationIDSchema } from "./ids"

export const WorkGraphAttemptToolNames = ["workgraph_report_progress", "workgraph_complete_task"] as const
export type WorkGraphAttemptToolName = (typeof WorkGraphAttemptToolNames)[number]

export const WorkGraphAttemptIdentitySchema = z.strictObject({
  attemptId: AttemptIDSchema,
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
