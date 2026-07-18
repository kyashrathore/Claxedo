import { z } from "zod"
import type { WorkGraphService } from "../application"
import {
  AttentionCursorSchema,
  AttentionAcknowledgementSchema,
  AttentionListInputSchema,
  AttentionPageSchema,
  SnapshotResumeCursorSchema,
  CommandErrorCodeSchema,
  EvidenceDtoSchema,
  EvidenceListInputSchema,
  EvidencePageCursorSchema,
  EvidencePageSchema,
  EvidenceReadInputSchema,
  AdmissionProposalDtoSchema,
  AdmissionProposalReadInputSchema,
  ReplacementReviewInputSchema,
  ReplacementReviewSchema,
  AttemptDetailDtoSchema,
  AttemptReadInputSchema,
  DecisionDtoSchema,
  DecisionReadInputSchema,
  WorkItemAttemptListInputSchema,
  WorkItemAttemptPageCursorSchema,
  WorkItemAttemptPageSchema,
  StreamActivityGranularitySchema,
  TaskActivityPageCursorSchema,
  TaskActivityPageSchema,
  WorkItemDtoSchema,
  WorkItemReadInputSchema,
  StreamDtoSchema,
  StreamIDSchema,
  OutcomeIDSchema,
  WorkItemIDSchema,
  WorkSourceDtoSchema,
  WorkSourceIDSchema,
  WorkSourceRevisionDtoSchema,
  WorkSourceRevisionIDSchema,
  WorkSourcePageCursorSchema,
  WorkGraphCommandRequestSchema,
  WorkGraphContextSchema,
  WorkGraphDefaultsDtoSchema,
  WorkGraphSnapshotPageSchema,
  WorkGraphArchiveRestoreErrorReasonSchema,
  WorkGraphArchiveRestoreResultSchema,
  OperationIDSchema,
  ExecutionCapabilitiesSchema,
  ExecutionCapabilitiesErrorSchema,
} from "../contracts"
import type { WorkGraphCommandHandlers } from "../ports"

export const WorkGraphHttpCommandRequestSchema = WorkGraphCommandRequestSchema
export const WorkGraphHttpContextSchema = WorkGraphContextSchema

export const WorkGraphHttpDefaultsResponseSchema = WorkGraphDefaultsDtoSchema

export const WorkGraphHttpExecutionCapabilitiesQuerySchema = z.strictObject({
  // Optional project selector: scopes repository (base-revision) enumeration to a
  // directory the runtime already knows about. Must be a non-empty absolute path;
  // the runtime port validates it against its authoritative known-projects list
  // and fails closed on anything unrecognized. Absent → the boot repository.
  directory: z.string().trim().min(1).refine((value) => value.startsWith("/"), {
    message: "Execution capability directory must be an absolute path",
  }).optional(),
})
export type WorkGraphHttpExecutionCapabilitiesQuery = z.infer<typeof WorkGraphHttpExecutionCapabilitiesQuerySchema>
export const WorkGraphHttpExecutionCapabilitiesResponseSchema = ExecutionCapabilitiesSchema
export const WorkGraphHttpExecutionCapabilitiesErrorSchema = ExecutionCapabilitiesErrorSchema

export const WorkGraphHttpSnapshotQuerySchema = z.strictObject({
  after: SnapshotResumeCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkGraphHttpSnapshotQuery = z.infer<typeof WorkGraphHttpSnapshotQuerySchema>

export const WorkGraphHttpAttentionQuerySchema = z.strictObject({
  after: AttentionCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkGraphHttpAttentionQuery = z.infer<typeof WorkGraphHttpAttentionQuerySchema>
export const WorkGraphHttpAttentionPageSchema = AttentionPageSchema
export const WorkGraphHttpAttentionAcknowledgementSchema = AttentionAcknowledgementSchema

export const WorkGraphHttpStreamQuerySchema = z.strictObject({ streamId: StreamIDSchema })
export type WorkGraphHttpStreamQuery = z.infer<typeof WorkGraphHttpStreamQuerySchema>

export const WorkGraphHttpProposalReadSchema = AdmissionProposalReadInputSchema
export const WorkGraphHttpReplacementReviewQuerySchema = ReplacementReviewInputSchema
export const WorkGraphHttpReplacementReviewResponseSchema = ReplacementReviewSchema
export const WorkGraphHttpWorkItemReadSchema = WorkItemReadInputSchema
export const WorkGraphHttpAttemptReadSchema = AttemptReadInputSchema
export const WorkGraphHttpDecisionReadSchema = DecisionReadInputSchema
export const WorkGraphHttpWorkItemAttemptsQuerySchema = z.strictObject({
  after: WorkItemAttemptPageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const WorkGraphHttpWorkItemActivityQuerySchema = z.strictObject({
  granularity: StreamActivityGranularitySchema.default("progress"),
  after: TaskActivityPageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const WorkGraphHttpSourcesQuerySchema = z.strictObject({
  after: WorkSourcePageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type WorkGraphHttpSourcesQuery = z.infer<typeof WorkGraphHttpSourcesQuerySchema>

export const WorkGraphHttpSourcesResponseSchema = z.strictObject({
  sources: z.array(WorkSourceDtoSchema),
  hasMore: z.boolean(),
  nextCursor: WorkSourcePageCursorSchema.optional(),
})
export type WorkGraphHttpSourcesResponse = z.infer<typeof WorkGraphHttpSourcesResponseSchema>

export const WorkGraphHttpSourceQuerySchema = z.strictObject({ workSourceId: WorkSourceIDSchema })
export const WorkGraphHttpSourceRevisionQuerySchema = z.strictObject({
  workSourceId: WorkSourceIDSchema,
  revisionId: WorkSourceRevisionIDSchema,
})

const evidencePageQuery = {
  after: EvidencePageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}
export const WorkGraphHttpEvidenceListQuerySchema = z.discriminatedUnion("subjectType", [
  z.strictObject({ subjectType: z.literal("stream"), streamId: StreamIDSchema, ...evidencePageQuery }),
  z.strictObject({ subjectType: z.literal("outcome"), outcomeId: OutcomeIDSchema, ...evidencePageQuery }),
  z.strictObject({ subjectType: z.literal("work_item"), workItemId: WorkItemIDSchema, ...evidencePageQuery }),
])
export type WorkGraphHttpEvidenceListQuery = z.infer<typeof WorkGraphHttpEvidenceListQuerySchema>

export const WorkGraphHttpEvidenceReadQuerySchema = EvidenceReadInputSchema
export const WorkGraphHttpEvidencePageSchema = EvidencePageSchema
export const WorkGraphHttpEvidenceSchema = EvidenceDtoSchema

export function workGraphEvidenceListInput(query: WorkGraphHttpEvidenceListQuery): z.infer<typeof EvidenceListInputSchema> {
  const common = { limit: query.limit, ...(query.after ? { after: query.after } : {}) }
  if (query.subjectType === "stream") return { ...common, subject: { type: "stream", streamId: query.streamId } }
  if (query.subjectType === "outcome") return { ...common, subject: { type: "outcome", outcomeId: query.outcomeId } }
  return { ...common, subject: { type: "work_item", workItemId: query.workItemId } }
}

export const WorkGraphHttpErrorCodeSchema = z.union([
  CommandErrorCodeSchema,
  z.literal("unauthorized"),
  z.literal("cursor_invalid"),
])
export type WorkGraphHttpErrorCode = z.infer<typeof WorkGraphHttpErrorCodeSchema>

export const WorkGraphHttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: WorkGraphHttpErrorCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
})
export type WorkGraphHttpError = z.infer<typeof WorkGraphHttpErrorSchema>

export const WorkGraphHttpOwnerDeletionRequestSchema = z.strictObject({ operationId: OperationIDSchema })
export const WorkGraphHttpOwnerDeletionResultSchema = z.strictObject({
  deleted: z.literal(true),
  recordCount: z.number().int().nonnegative(),
  workspaceCount: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative(),
})
export const WorkGraphHttpOwnerDeletionErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("owner_deletion_rejected"),
    reason: z.enum(["forbidden", "not_quiescent", "in_progress", "cleanup_failed", "storage_failed"]),
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
})

export const WorkGraphHttpArchiveRestoreResultSchema = WorkGraphArchiveRestoreResultSchema
export const WorkGraphHttpArchiveErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("archive_restore_rejected"),
    reason: WorkGraphArchiveRestoreErrorReasonSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
})

export type WorkGraphHttpQueries = Readonly<{
  defaults: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: Readonly<Record<string, never>>,
    ) => Promise<z.infer<typeof WorkGraphDefaultsDtoSchema>>
  }>
  snapshot: Readonly<{
    page: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: WorkGraphHttpSnapshotQuery,
    ) => Promise<z.infer<typeof WorkGraphSnapshotPageSchema>>
  }>
  attention: Readonly<{
    list: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof AttentionListInputSchema>,
    ) => Promise<z.infer<typeof AttentionPageSchema>>
  }>
  streams: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: WorkGraphHttpStreamQuery,
    ) => Promise<z.infer<typeof StreamDtoSchema> | undefined>
  }>
  proposals: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof AdmissionProposalReadInputSchema>,
    ) => Promise<z.infer<typeof AdmissionProposalDtoSchema> | undefined>
    replacementReview: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof ReplacementReviewInputSchema>,
    ) => Promise<z.infer<typeof ReplacementReviewSchema> | undefined>
  }>
  workItems: Readonly<{
    readDetail: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof WorkItemReadInputSchema>,
    ) => Promise<z.infer<typeof WorkItemDtoSchema> | undefined>
    listAttempts: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof WorkItemAttemptListInputSchema>,
    ) => Promise<z.infer<typeof WorkItemAttemptPageSchema>>
    listActivity: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: Readonly<{
        workItemId: z.infer<typeof WorkItemIDSchema>
        granularity: z.infer<typeof StreamActivityGranularitySchema>
        after?: z.infer<typeof TaskActivityPageCursorSchema>
        limit: number
      }>,
    ) => Promise<z.infer<typeof TaskActivityPageSchema>>
  }>
  attempts: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof AttemptReadInputSchema>,
    ) => Promise<z.infer<typeof AttemptDetailDtoSchema> | undefined>
  }>
  decisions: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof DecisionReadInputSchema>,
    ) => Promise<z.infer<typeof DecisionDtoSchema> | undefined>
  }>
  sources: Readonly<{
    list: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: WorkGraphHttpSourcesQuery,
    ) => Promise<WorkGraphHttpSourcesResponse>
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof WorkGraphHttpSourceQuerySchema>,
    ) => Promise<z.infer<typeof WorkSourceDtoSchema> | undefined>
    readRevision: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof WorkGraphHttpSourceRevisionQuerySchema>,
    ) => Promise<z.infer<typeof WorkSourceRevisionDtoSchema> | undefined>
  }>
  evidence: Readonly<{
    read: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof EvidenceReadInputSchema>,
    ) => Promise<z.infer<typeof EvidenceDtoSchema> | undefined>
    list: (
      context: z.infer<typeof WorkGraphContextSchema>,
      input: z.infer<typeof EvidenceListInputSchema>,
    ) => Promise<z.infer<typeof EvidencePageSchema>>
  }>
}>

export type WorkGraphHttpService<Queries extends WorkGraphHttpQueries = WorkGraphHttpQueries> =
  Pick<WorkGraphService<WorkGraphCommandHandlers, Queries>, "execute"> & Readonly<{ queries: Queries }>

export type WorkGraphTrustedContextResolver = (
  request: Request,
) => z.input<typeof WorkGraphContextSchema> | undefined | Promise<z.input<typeof WorkGraphContextSchema> | undefined>
