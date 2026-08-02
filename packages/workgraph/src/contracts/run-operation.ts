import { z } from "zod"
import { AgentCheckpointLevelSchema } from "./activity"
import { RunCompletionEvidenceInputSchema, CommandResultSchema, StreamNotesExternalReferenceSchema } from "./commands"
import { RunIDSchema, EvidenceIDSchema, OperationIDSchema, StreamIDSchema } from "./ids"

export const WorkGraphRunToolNames = ["workgraph_report_progress", "workgraph_complete_task"] as const
export type WorkGraphRunToolName = (typeof WorkGraphRunToolNames)[number]
export const WorkGraphMasterToolNames = ["workgraph_update_stream_notes", "workgraph_notify_owner"] as const
export type WorkGraphMasterToolName = (typeof WorkGraphMasterToolNames)[number]
/** Landing is a separate grant from the core master tools: it exists only where a
 *  local envelope worktree and the landing-integrity gate are present. Hosted
 *  masters do not receive it and their prompt must not assign landing duties. */
export const WorkGraphMasterLandingToolName = "workgraph_land_candidate" as const
export const WorkGraphRuntimeToolNames = [...WorkGraphRunToolNames, ...WorkGraphMasterToolNames] as const
export type WorkGraphRuntimeToolName = (typeof WorkGraphRuntimeToolNames)[number]

/** The single source of the master session/run identity convention. Every
 *  producer and checker derives from these; hand-built `ses_master_${id}` style
 *  strings are a defect. */
export const MASTER_SESSION_PREFIX = "ses_master_"
export const MASTER_RUN_PREFIX = "master_"
export const RUN_SESSION_PREFIX = "ses_wgrun_"
export const PARKED_LEASE_TTL_MS = 15 * 60_000
export const RUN_RESUME_MAX = 5

export function isRunResumeCapExceeded(attempts: number) {
  return attempts > RUN_RESUME_MAX
}
export function masterSessionId(streamId: string): string {
  return `${MASTER_SESSION_PREFIX}${streamId}`
}
export function masterRunId(streamId: string): string {
  return `${MASTER_RUN_PREFIX}${streamId}`
}
export function runSessionId(runId: string): string {
  return `${RUN_SESSION_PREFIX}${runId}`
}
export function isMasterSessionId(sessionId: string): boolean {
  return sessionId.startsWith(MASTER_SESSION_PREFIX)
}

/** The master lane identity. The serial key IS the one-turn-per-stream
 *  guarantee: every producer (Convex enqueue, hosted retry scheduling, sqlite
 *  jobs) must derive it here — two constructors would split the lane and run
 *  concurrent master turns against one envelope. */
export type WorkGraphMasterLaneScope = Readonly<{
  organizationId: string
  ownerUserId: string
  streamId: string
}>
export function workGraphMasterLaneKey(scope: WorkGraphMasterLaneScope): string {
  return `workgraph-master:${scope.organizationId}:${scope.ownerUserId}:${scope.streamId}`
}
export function workGraphMasterLaneWorkspace(scope: WorkGraphMasterLaneScope): string {
  return `wg-master:${scope.organizationId}:${scope.ownerUserId}:${scope.streamId}`
}

/** The master's daily cadence, shared by every scheduler. */
export const MASTER_DAILY_SCHEDULE = "daily@06:00Z"
export function nextDailyMasterRun(afterMs: number): number {
  const after = new Date(afterMs)
  const candidate = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), 6)
  return candidate > afterMs ? candidate : candidate + 24 * 60 * 60_000
}

export const WorkGraphRunIdentitySchema = z.strictObject({
  runId: RunIDSchema,
  streamId: StreamIDSchema.optional(),
  sessionId: z.string().trim().min(1).max(512),
  workspaceId: z.string().trim().min(1).max(1_024),
  generation: z.number().int().positive(),
})
export type WorkGraphRunIdentity = z.infer<typeof WorkGraphRunIdentitySchema>

export const WorkGraphRunOperationSchema = z.discriminatedUnion("type", [
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
    evidence: z.array(RunCompletionEvidenceInputSchema).min(1).max(100),
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
export type WorkGraphRunOperation = z.infer<typeof WorkGraphRunOperationSchema>

export const WorkGraphRunOperationRequestSchema = z.strictObject({
  version: z.literal(1),
  identity: WorkGraphRunIdentitySchema,
  operation: WorkGraphRunOperationSchema,
})
export type WorkGraphRunOperationRequest = z.infer<typeof WorkGraphRunOperationRequestSchema>

export const WorkGraphRunOperationResponseSchema = CommandResultSchema
export type WorkGraphRunOperationResponse = z.infer<typeof WorkGraphRunOperationResponseSchema>
