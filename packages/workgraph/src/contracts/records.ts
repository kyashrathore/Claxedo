import { z } from "zod"
import { AdmissionProposalIDSchema, ChangeCursorSchema } from "./commands"
import { SnapshotResumeCursorSchema } from "./snapshot-cursor"
import { CompletionContractSchema } from "./completion"
import { WorkGraphActorSchema } from "./context"
import { ExecutionProfileDefaultsSchema, ModelSelectionSchema, RecapProfileDefaultsSchema, ResolvedExecutionProfileSchema, WorkGraphDefaultsSchema } from "./execution"
import {
  AttemptIDSchema,
  DecisionIDSchema,
  EvidenceIDSchema,
  OperationIDSchema,
  OutcomeIDSchema,
  OwnerUserIDSchema,
  RecapIDSchema,
  StreamIDSchema,
  WorkGraphIDSchema,
  WorkItemIDSchema,
} from "./ids"
import {
  AttemptStateSchema,
  DecisionStateSchema,
  OutcomeStateSchema,
  StreamLifecycleStateSchema,
  StreamVisibilitySchema,
  WorkItemStateSchema,
} from "./lifecycle"
import { WorkSourceRevisionRefSchema } from "./work-source"

const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative()
const version = z.number().int().positive()

export const RecordProvenanceSchema = z.strictObject({
  actor: WorkGraphActorSchema,
  operationId: OperationIDSchema.optional(),
})
export type RecordProvenance = z.infer<typeof RecordProvenanceSchema>

const ownerRecordShape = {
  schemaVersion: z.literal(1),
  ownerUserId: OwnerUserIDSchema,
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance: RecordProvenanceSchema,
}

export const WorkGraphDefaultsDtoSchema = z.strictObject({
  recordType: z.literal("workgraph"),
  ...ownerRecordShape,
  id: WorkGraphIDSchema,
  defaults: WorkGraphDefaultsSchema,
})
export type WorkGraphDefaultsDto = z.infer<typeof WorkGraphDefaultsDtoSchema>

export const StreamMemorySchema = z.strictObject({
  summary: text,
  updatedAt: timestamp,
  attention: z.strictObject({
    type: z.literal("recap_failed"),
    reason: text,
    at: timestamp,
  }).optional(),
})
export type StreamMemory = z.infer<typeof StreamMemorySchema>

export const StreamActivitySchema = z.strictObject({
  lastActivityAt: timestamp,
  recapDueAt: timestamp,
  lastRecapId: RecapIDSchema.optional(),
})
export type StreamActivity = z.infer<typeof StreamActivitySchema>

export const StreamEnvelopeSchema = z.strictObject({
  kind: z.enum(["local_worktree", "hosted_workspace"]),
  workspaceId: text,
  status: z.enum(["provisioning", "ready", "attention", "cleaning", "destroyed"]),
})
export type StreamEnvelope = z.infer<typeof StreamEnvelopeSchema>

export const StreamDtoSchema = z.strictObject({
  recordType: z.literal("stream"),
  ...ownerRecordShape,
  id: StreamIDSchema,
  title: text,
  description: z.string().optional(),
  lifecycleState: StreamLifecycleStateSchema,
  visibility: StreamVisibilitySchema,
  pinned: z.boolean(),
  executionDefaults: ExecutionProfileDefaultsSchema,
  recapDefaults: RecapProfileDefaultsSchema,
  memory: StreamMemorySchema.optional(),
  activity: StreamActivitySchema,
  envelope: StreamEnvelopeSchema.optional(),
  durableEffectCount: z.number().int().nonnegative(),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
})
export type StreamDto = z.infer<typeof StreamDtoSchema>

export const OutcomeDtoSchema = z.strictObject({
  recordType: z.literal("outcome"),
  ...ownerRecordShape,
  id: OutcomeIDSchema,
  streamId: StreamIDSchema,
  title: text,
  description: z.string().optional(),
  state: OutcomeStateSchema,
  successCriteria: z.array(text).min(1),
  evidenceIds: z.array(EvidenceIDSchema),
  executionDefaults: ExecutionProfileDefaultsSchema.optional(),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
  closedAt: timestamp.optional(),
  closedBy: WorkGraphActorSchema.optional(),
  closeReason: text.optional(),
  reopenedAt: timestamp.optional(),
  reopenReason: text.optional(),
})
export type OutcomeDto = z.infer<typeof OutcomeDtoSchema>

export const WorkItemDtoSchema = z.strictObject({
  recordType: z.literal("work_item"),
  ...ownerRecordShape,
  id: WorkItemIDSchema,
  streamId: StreamIDSchema,
  outcomeId: OutcomeIDSchema.optional(),
  title: text,
  description: z.string().optional(),
  state: WorkItemStateSchema,
  priority: z.number().int().nonnegative(),
  dependencyIds: z.array(WorkItemIDSchema),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
  completionContract: CompletionContractSchema,
  evidenceIds: z.array(EvidenceIDSchema),
  executionDefaults: ExecutionProfileDefaultsSchema.optional(),
  abandonedAt: timestamp.optional(),
  abandonReason: text.optional(),
})
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>

export const AttemptResultSchema = z.strictObject({
  summary: text,
  artifactRefs: z.array(text),
  finishedAt: timestamp,
})
export type AttemptResult = z.infer<typeof AttemptResultSchema>

export const AttemptDtoSchema = z
  .strictObject({
    recordType: z.literal("attempt"),
    ...ownerRecordShape,
    id: AttemptIDSchema,
    streamId: StreamIDSchema,
    workItemId: WorkItemIDSchema,
    attemptNumber: z.number().int().positive(),
    state: AttemptStateSchema,
    resolvedExecution: ResolvedExecutionProfileSchema,
    admittedAt: timestamp,
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    result: AttemptResultSchema.optional(),
    attentionReason: text.optional(),
    sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
  })
  .transform(deepFreeze)
export type AttemptDto = z.infer<typeof AttemptDtoSchema>

export const DecisionOptionSchema = z.strictObject({
  id: text,
  label: text,
  description: z.string().optional(),
})
export type DecisionOption = z.infer<typeof DecisionOptionSchema>

export const DecisionAnswerSchema = z.strictObject({
  optionId: text.optional(),
  answer: text.optional(),
  answeredAt: timestamp,
  answeredBy: WorkGraphActorSchema,
}).refine((answer) => answer.optionId || answer.answer, "A Decision answer requires an option or free-form answer")
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>

export const DecisionDtoSchema = z
  .strictObject({
    recordType: z.literal("decision"),
    ...ownerRecordShape,
    id: DecisionIDSchema,
    streamId: StreamIDSchema,
    state: DecisionStateSchema,
    question: text,
    options: z.array(DecisionOptionSchema).min(1),
    recommendationOptionId: text.optional(),
    rationale: z.string().optional(),
    affectedWorkItemIds: z.array(WorkItemIDSchema).min(1),
    sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
    answer: DecisionAnswerSchema.optional(),
    dismissedAt: timestamp.optional(),
    dismissReason: text.optional(),
  })
  .superRefine((decision, context) => {
    const optionIds = new Set(decision.options.map((option) => option.id))
    if (optionIds.size !== decision.options.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "Decision option IDs must be unique" })
    }
    if (!decision.recommendationOptionId || optionIds.has(decision.recommendationOptionId)) return
    context.addIssue({ code: "custom", path: ["recommendationOptionId"], message: "Recommendation must reference an option" })
  })
export type DecisionDto = z.infer<typeof DecisionDtoSchema>

export const WorkGraphRecordReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workgraph"), id: WorkGraphIDSchema }),
  z.strictObject({ type: z.literal("stream"), id: StreamIDSchema }),
  z.strictObject({ type: z.literal("outcome"), id: OutcomeIDSchema }),
  z.strictObject({ type: z.literal("work_item"), id: WorkItemIDSchema }),
  z.strictObject({ type: z.literal("attempt"), id: AttemptIDSchema }),
  z.strictObject({ type: z.literal("decision"), id: DecisionIDSchema }),
  z.strictObject({ type: z.literal("recap"), id: RecapIDSchema }),
  z.strictObject({ type: z.literal("admission_proposal"), id: AdmissionProposalIDSchema }),
])
export type WorkGraphRecordReference = z.infer<typeof WorkGraphRecordReferenceSchema>

export const RecapGenerationSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("succeeded"),
    model: ModelSelectionSchema,
    effort: text,
    generatedAt: timestamp,
    method: z.literal("agent_session"),
    sessionId: text,
  }),
  z.strictObject({
    state: z.literal("failed"),
    model: ModelSelectionSchema,
    effort: text,
    failedAt: timestamp.optional(),
    invalidatedAt: timestamp.optional(),
    reason: text,
  }),
  z.strictObject({
    state: z.literal("invalidated"),
    model: ModelSelectionSchema,
    effort: text,
    reason: text,
    source: z.literal("retired_non_session_generation"),
  }),
])
export type RecapGeneration = z.infer<typeof RecapGenerationSchema>

export const RecapDtoSchema = z
  .strictObject({
    recordType: z.literal("recap"),
    ...ownerRecordShape,
    id: RecapIDSchema,
    streamId: StreamIDSchema,
    previousRecapId: RecapIDSchema.optional(),
    activityRange: z
      .strictObject({ fromSequence: z.number().int().positive(), toSequence: z.number().int().positive(), quietSince: timestamp })
      .refine((range) => range.fromSequence <= range.toSequence, "Recap activity range must be ordered"),
    summary: text,
    actionableReferences: z.array(WorkGraphRecordReferenceSchema),
    generation: RecapGenerationSchema,
    sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
  })
  .transform(deepFreeze)
export type RecapDto = z.infer<typeof RecapDtoSchema>

export const AdmissionProposalStateSchema = z.enum(["planning", "planning_failed", "proposed", "confirmed", "dismissed"])
export type AdmissionProposalState = z.infer<typeof AdmissionProposalStateSchema>

export const AdmissionSuggestedPlacementSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("new_stream"), streamTitle: text }),
  z.strictObject({ mode: z.literal("existing"), streamId: StreamIDSchema }),
])
export type AdmissionSuggestedPlacement = z.infer<typeof AdmissionSuggestedPlacementSchema>

export const AdmissionPlacementMatchSchema = z.strictObject({
  streamId: StreamIDSchema,
  confidence: z.enum(["high", "medium", "low"]),
  score: z.number().min(0).max(1),
  reason: text,
  evidence: z.array(text),
})

export const AdmissionDuplicateMatchSchema = z.strictObject({
  subject: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("outcome"), outcomeId: OutcomeIDSchema }),
    z.strictObject({ type: z.literal("work_item"), workItemId: WorkItemIDSchema }),
  ]),
  streamId: StreamIDSchema,
  title: text,
  state: text,
  score: z.number().min(0).max(1),
  reason: text,
  evidence: z.array(text).min(1),
})

export const AdmissionProposalGenerationSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("planning"),
    attempt: z.number().int().nonnegative(),
    queuedAt: timestamp,
    startedAt: timestamp.optional(),
  }),
  z.strictObject({
    method: z.literal("planning_failed"),
    attempt: z.number().int().nonnegative(),
    reason: text,
    failedAt: timestamp.optional(),
    invalidatedAt: timestamp.optional(),
    retryable: z.boolean(),
  }).refine((generation) => generation.failedAt !== undefined || generation.invalidatedAt !== undefined, {
    message: "Admission planning failure requires a failure or invalidation timestamp",
  }),
  z.strictObject({ method: z.literal("agent_session"), sessionId: text, generatedAt: timestamp }),
])
export type AdmissionProposalGeneration = z.infer<typeof AdmissionProposalGenerationSchema>

export const AdmissionProposedOutcomeSchema = z.strictObject({
  key: text,
  title: text,
  description: z.string().optional(),
  successCriteria: z.array(text).min(1),
  execution: ExecutionProfileDefaultsSchema,
})

export const AdmissionProposedWorkItemSchema = z.strictObject({
  key: text,
  outcomeKey: text.optional(),
  title: text,
  description: z.string().optional(),
  dependencyKeys: z.array(text),
  completionContract: CompletionContractSchema,
  execution: ExecutionProfileDefaultsSchema,
})

export const AdmissionAgentPlanSchema = z.strictObject({
  source: WorkSourceRevisionRefSchema,
  suggestedPlacement: AdmissionSuggestedPlacementSchema,
  placementMatches: z.array(AdmissionPlacementMatchSchema).max(4),
  proposedOutcomes: z.array(AdmissionProposedOutcomeSchema),
  proposedWorkItems: z.array(AdmissionProposedWorkItemSchema),
  duplicateMatches: z.array(AdmissionDuplicateMatchSchema),
})
export type AdmissionAgentPlan = z.infer<typeof AdmissionAgentPlanSchema>

const admissionProposalShape = {
  recordType: z.literal("admission_proposal"),
  ...ownerRecordShape,
  id: AdmissionProposalIDSchema,
  source: WorkSourceRevisionRefSchema,
  previousSource: WorkSourceRevisionRefSchema.optional(),
  diffSummary: z.string().optional(),
}

const AdmissionPlanningProposalDtoSchema = z.strictObject({
  ...admissionProposalShape,
  state: z.literal("planning"),
  generation: z.strictObject({
    method: z.literal("planning"),
    attempt: z.number().int().nonnegative(),
    queuedAt: timestamp,
    startedAt: timestamp.optional(),
  }),
})

const AdmissionPlanningFailedProposalDtoSchema = z.strictObject({
  ...admissionProposalShape,
  state: z.literal("planning_failed"),
  generation: z.strictObject({
    method: z.literal("planning_failed"),
    attempt: z.number().int().nonnegative(),
    reason: text,
    failedAt: timestamp.optional(),
    invalidatedAt: timestamp.optional(),
    retryable: z.boolean(),
  }).refine((generation) => generation.failedAt !== undefined || generation.invalidatedAt !== undefined, {
    message: "Admission planning failure requires a failure or invalidation timestamp",
  }),
})

const admissionReviewableProposalShape = {
  ...admissionProposalShape,
  generation: z.strictObject({ method: z.literal("agent_session"), sessionId: text, generatedAt: timestamp }),
  suggestedPlacement: AdmissionSuggestedPlacementSchema,
  placementMatches: z.array(AdmissionPlacementMatchSchema),
  proposedOutcomes: z.array(AdmissionProposedOutcomeSchema),
  proposedWorkItems: z.array(AdmissionProposedWorkItemSchema),
  duplicateMatches: z.array(AdmissionDuplicateMatchSchema),
}

const AdmissionReviewableProposalDtoSchema = z.union([
  z.strictObject({ ...admissionReviewableProposalShape, state: z.literal("proposed") }),
  z.strictObject({ ...admissionReviewableProposalShape, state: z.literal("confirmed") }),
  z.strictObject({ ...admissionReviewableProposalShape, state: z.literal("dismissed") }),
])

export const AdmissionProposalDtoSchema = z.union([
  AdmissionPlanningProposalDtoSchema,
  AdmissionPlanningFailedProposalDtoSchema,
  AdmissionReviewableProposalDtoSchema,
])
export type AdmissionProposalDto = z.infer<typeof AdmissionProposalDtoSchema>

export const OrderedSnapshotReferenceSchema = z.strictObject({
  sequence: z.number().int().positive(),
  resource: WorkGraphRecordReferenceSchema,
  version,
})
export type OrderedSnapshotReference = z.infer<typeof OrderedSnapshotReferenceSchema>

export const WorkGraphPublicRecordSchema = z.union([
  WorkGraphDefaultsDtoSchema,
  StreamDtoSchema,
  OutcomeDtoSchema,
  WorkItemDtoSchema,
  AttemptDtoSchema,
  DecisionDtoSchema,
  RecapDtoSchema,
  AdmissionProposalDtoSchema,
])
export type WorkGraphPublicRecord = z.infer<typeof WorkGraphPublicRecordSchema>

export const WorkGraphSnapshotPageSchema = z.strictObject({
  snapshotCursor: ChangeCursorSchema,
  records: z.array(WorkGraphPublicRecordSchema),
  references: z.array(OrderedSnapshotReferenceSchema),
  hasMore: z.boolean(),
  nextCursor: SnapshotResumeCursorSchema.optional(),
  capturedAt: timestamp,
})
export type WorkGraphSnapshotPage = z.infer<typeof WorkGraphSnapshotPageSchema>

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value) as T
}
