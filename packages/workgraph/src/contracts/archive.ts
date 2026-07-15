import { z } from "zod"
import { CompletionContractSchema, EvidenceSubjectSchema } from "./completion"
import {
  AdmissionProposalIDSchema,
  AdmissionSelectionSchema,
  ChangeCursorSchema,
  CommandProvenanceSchema,
  CommandResultSchema,
} from "./commands"
import { WorkGraphActorSchema } from "./context"
import {
  ExecutionProfileDefaultsSchema,
  RecapProfileDefaultsSchema,
  ResolvedExecutionProfileSchema,
  WorkGraphDefaultsSchema,
} from "./execution"
import {
  ChangeResourceSchema,
  PublicEventPayloadSchema,
  WorkGraphEventIDSchema,
  WorkGraphEventTypeSchema,
} from "./events"
import { SourceViewTargetSchema } from "./source-view"
import {
  AttemptIDSchema,
  CompletionRequirementIDSchema,
  DecisionIDSchema,
  DurableEffectReceiptIDSchema,
  EvidenceIDSchema,
  OperationIDSchema,
  OrganizationIDSchema,
  OutcomeIDSchema,
  OwnerUserIDSchema,
  RecapIDSchema,
  SessionBindingIDSchema,
  StreamIDSchema,
  WorkGraphIDSchema,
  WorkItemIDSchema,
  WorkSourceIDSchema,
  WorkSourceRevisionIDSchema,
} from "./ids"
import {
  AttemptStateSchema,
  DecisionStateSchema,
  OutcomeStateSchema,
  StreamLifecycleStateSchema,
  StreamVisibilitySchema,
  WorkItemStateSchema,
} from "./lifecycle"
import {
  AdmissionDuplicateMatchSchema,
  AdmissionPlacementMatchSchema,
  AdmissionProposedOutcomeSchema,
  AdmissionProposedWorkItemSchema,
  AdmissionSuggestedPlacementSchema,
  AttemptResultSchema,
  DecisionAnswerSchema,
  DecisionOptionSchema,
  RecapGenerationSchema,
  RecordProvenanceSchema,
  StreamActivitySchema,
  StreamEnvelopeSchema,
  StreamMemorySchema,
  StreamReplacementResetSchema,
  WorkGraphRecordReferenceSchema,
} from "./records"
import {
  AgentCheckpointLevelSchema,
  DEFAULT_STREAM_ACTIVITY_GRANULARITY,
  SessionBindingStateSchema,
  StreamActivityGranularitySchema,
} from "./activity"
import { WorkSourceOriginSchema, WorkSourceRevisionRefSchema } from "./work-source"

export const WORKGRAPH_ARCHIVE_VERSION = 1 as const

export const WorkGraphArchiveRecordKindSchema = z.enum([
  "workgraph",
  "work_source",
  "work_source_revision",
  "source_view",
  "intake_candidate",
  "external_identity",
  "stream",
  "outcome",
  "work_item",
  "work_item_dependency",
  "attempt",
  "session_binding",
  "agent_checkpoint",
  "decision",
  "decision_work_item",
  "evidence",
  "durable_effect_receipt",
  "recap",
  "notification",
  "record_source_revision",
  "admission_proposal",
  "operation_result",
  "event",
  "change",
  "runtime_effect",
  "migration_intake",
  "completed_external_effect",
  "terminal_scheduled_job",
])
export type WorkGraphArchiveRecordKind = z.infer<typeof WorkGraphArchiveRecordKindSchema>

const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative()
const version = z.number().int().positive()
const schemaVersion = z.literal(1)
const publicMutable = {
  schemaVersion,
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance: RecordProvenanceSchema,
}
const storedMutable = {
  schemaVersion,
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
}
const storedImmutable = { schemaVersion, createdAt: timestamp }
const jsonRecord = z.record(z.string(), z.json())

const WorkGraphArchiveValueSchema = z.strictObject({
  ...publicMutable,
  defaults: WorkGraphDefaultsSchema,
})

const WorkSourceArchiveValueSchema = z.strictObject({
  ...storedMutable,
  workgraphId: WorkGraphIDSchema,
  title: text,
  sourceKind: text,
  metadata: jsonRecord,
  latestRevisionId: WorkSourceRevisionIDSchema,
  revisionCount: z.number().int().positive(),
})

const WorkSourceRevisionArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  workSourceId: WorkSourceIDSchema,
  revisionNumber: z.number().int().positive(),
  content: z.string().refine((value) => value.trim().length > 0, "Source content must contain non-whitespace text"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  origin: WorkSourceOriginSchema,
  createdBy: WorkGraphActorSchema,
})

const SourceViewArchiveValueSchema = z.strictObject({
  ...storedMutable,
  workgraphId: WorkGraphIDSchema,
  teamConnectionId: text,
  provider: z.enum(["github", "linear", "jira"]),
  providerUserId: text,
  filters: z.record(z.string(), z.string()),
  target: SourceViewTargetSchema.optional(),
  syncPolicy: z.enum(["silent", "announce", "full"]),
  status: z.enum(["active", "paused"]),
})

const intakeBase = {
  ...storedMutable,
  workgraphId: WorkGraphIDSchema,
  title: text,
  body: z.string(),
  observedRevision: text.optional(),
  state: z.enum(["unorganized", "staged", "confirmed", "dismissed"]),
  source: WorkSourceRevisionRefSchema.optional(),
  admissionProposalId: AdmissionProposalIDSchema.optional(),
  admissionDraft: z.strictObject({ title: text, content: z.string().min(1) }).optional(),
}
const IntakeCandidateArchiveValueSchema = z
  .discriminatedUnion("candidateKind", [
    z.strictObject({ ...intakeBase, candidateKind: z.literal("session"), sessionId: text }),
    z.strictObject({
      ...intakeBase,
      candidateKind: z.literal("external_issue"),
      sourceViewId: text,
      provider: z.enum(["github", "linear", "jira"]),
      externalId: text,
      externalKey: text.optional(),
      externalUrl: z.string().url().optional(),
      externalStatus: text,
    }),
  ])
  .superRefine((candidate, context) => {
    if (!["staged", "confirmed"].includes(candidate.state)) return
    if (!candidate.source)
      context.addIssue({ code: "custom", path: ["source"], message: "Organized intake requires its immutable source" })
    if (!candidate.admissionProposalId)
      context.addIssue({
        code: "custom",
        path: ["admissionProposalId"],
        message: "Organized intake requires its proposal",
      })
  })

const ExternalIdentityArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  updatedAt: timestamp,
  intakeCandidateId: text.optional(),
  provider: z.enum(["github", "linear", "jira"]),
  teamConnectionId: text,
  externalId: text,
  externalKey: text.optional(),
  externalUrl: z.string().url().optional(),
  observedRevision: text.optional(),
  metadata: jsonRecord,
})

const StreamArchiveValueSchema = z.strictObject({
  ...publicMutable,
  workgraphId: WorkGraphIDSchema,
  title: text,
  description: z.string().optional(),
  lifecycleState: StreamLifecycleStateSchema,
  visibility: StreamVisibilitySchema,
  pinned: z.boolean(),
  executionDefaults: ExecutionProfileDefaultsSchema,
  recapDefaults: RecapProfileDefaultsSchema,
  activityGranularity: StreamActivityGranularitySchema.default(DEFAULT_STREAM_ACTIVITY_GRANULARITY),
  memory: StreamMemorySchema.optional(),
  activity: StreamActivitySchema,
  envelope: StreamEnvelopeSchema.optional(),
  replacementReset: StreamReplacementResetSchema.superRefine((reset, context) => {
    if (reset.state === "completed" && reset.completedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completed replacement reset requires completedAt",
      })
    }
    if (reset.state !== "completed" && reset.completedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Active replacement reset cannot have completedAt",
      })
    }
  }).optional(),
  durableEffectCount: z.number().int().nonnegative(),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
})

const OutcomeArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  title: text,
  description: z.string().optional(),
  state: OutcomeStateSchema,
  successCriteria: z.array(text).min(1),
  evidenceIds: z.array(EvidenceIDSchema),
  executionDefaults: ExecutionProfileDefaultsSchema.optional(),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
  readyToCloseAt: timestamp.optional(),
  closedAt: timestamp.optional(),
  closedBy: WorkGraphActorSchema.optional(),
  closeReason: text.optional(),
  reopenedAt: timestamp.optional(),
  reopenReason: text.optional(),
})

const WorkItemArchiveValueSchema = z.strictObject({
  ...publicMutable,
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
  completedAt: timestamp.optional(),
  abandonedAt: timestamp.optional(),
  abandonReason: text.optional(),
})

const WorkItemDependencyArchiveValueSchema = z
  .strictObject({
    ...storedImmutable,
    workItemId: WorkItemIDSchema,
    dependsOnWorkItemId: WorkItemIDSchema,
    dependencyKind: text,
  })
  .refine((value) => value.workItemId !== value.dependsOnWorkItemId, "A Work Item cannot depend on itself")

const AttemptArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  workItemId: WorkItemIDSchema,
  attemptNumber: z.number().int().positive(),
  state: AttemptStateSchema,
  executionKind: z.enum(["managed", "attached"]).default("managed"),
  resolvedExecution: ResolvedExecutionProfileSchema,
  admittedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  result: AttemptResultSchema.optional(),
  attentionReason: text.optional(),
  executionIdentity: z
    .strictObject({
      envelopeId: text.optional(),
      childIsolationId: text.optional(),
      sessionId: text.optional(),
    })
    .optional(),
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
})

const SessionBindingArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  sessionId: text.max(512),
  projectId: text.max(512),
  currentWorkItemId: WorkItemIDSchema.optional(),
  currentAttemptId: AttemptIDSchema.optional(),
  state: SessionBindingStateSchema,
  boundAt: timestamp,
  releasedAt: timestamp.optional(),
}).superRefine((binding, context) => {
  if (binding.currentAttemptId && !binding.currentWorkItemId) {
    context.addIssue({ code: "custom", path: ["currentAttemptId"], message: "A bound Attempt requires a current Work Item" })
  }
  if ((binding.state === "released") === (binding.releasedAt !== undefined)) return
  context.addIssue({ code: "custom", path: ["releasedAt"], message: "Released bindings require releasedAt" })
})

const AgentCheckpointArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  workItemId: WorkItemIDSchema,
  attemptId: AttemptIDSchema,
  sessionBindingId: SessionBindingIDSchema,
  level: AgentCheckpointLevelSchema,
  summary: text.max(1_000),
  evidenceIds: z.array(EvidenceIDSchema).max(100),
  occurredAt: timestamp,
})

const DecisionArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  state: DecisionStateSchema,
  proposedBy: WorkGraphActorSchema,
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

const DecisionWorkItemArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  decisionId: DecisionIDSchema,
  workItemId: WorkItemIDSchema,
})

const evidenceBase = {
  schemaVersion,
  subject: EvidenceSubjectSchema,
  requirementId: CompletionRequirementIDSchema.optional(),
  sourceAttemptId: AttemptIDSchema.optional(),
  summary: text,
  recordedAt: timestamp,
  recordedBy: WorkGraphActorSchema,
}
const EvidenceArchiveValueSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...evidenceBase,
      kind: z.literal("test_result"),
      passed: z.boolean(),
      command: text.optional(),
      outputRef: text.optional(),
    }),
    z.strictObject({ ...evidenceBase, kind: z.literal("artifact"), artifactRef: text, mediaType: text.optional() }),
    z.strictObject({
      ...evidenceBase,
      kind: z.literal("review"),
      verdict: z.enum(["approved", "changes_requested"]),
      reviewer: text.optional(),
    }),
    z.strictObject({
      ...evidenceBase,
      kind: z.literal("integration"),
      effect: z.enum(["merged", "published", "accepted_external_write", "other"]),
      reference: text,
      durableEffectReceiptId: DurableEffectReceiptIDSchema.optional(),
    }),
    z.strictObject({ ...evidenceBase, kind: z.literal("owner_confirmation"), confirmed: z.boolean() }),
    z.strictObject({ ...evidenceBase, kind: z.literal("finding"), sourceRef: text.optional() }),
  ])
  .superRefine((evidence, context) => {
    if (evidence.kind !== "integration" || evidence.effect === "other" || evidence.durableEffectReceiptId) return
    context.addIssue({
      code: "custom",
      path: ["durableEffectReceiptId"],
      message: "Durable integration evidence requires its receipt",
    })
  })

const DurableEffectReceiptArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  streamId: StreamIDSchema,
  attemptId: AttemptIDSchema.optional(),
  effectKind: text,
  idempotencyKey: text,
  externalReference: jsonRecord,
  provenance: RecordProvenanceSchema,
})

const RecapArchiveValueSchema = z.strictObject({
  ...publicMutable,
  streamId: StreamIDSchema,
  previousRecapId: RecapIDSchema.optional(),
  activityRange: z
    .strictObject({
      fromSequence: z.number().int().positive(),
      toSequence: z.number().int().positive(),
      quietSince: timestamp,
    })
    .refine((range) => range.fromSequence <= range.toSequence, "Recap activity range must be ordered"),
  summary: text,
  actionableReferences: z.array(WorkGraphRecordReferenceSchema),
  generation: RecapGenerationSchema,
  sourceRevisionRefs: z.array(WorkSourceRevisionRefSchema),
})

const NotificationArchiveValueSchema = z.strictObject({
  schemaVersion,
  version,
  kind: z.literal("actionable_recap"),
  state: z.enum(["unread", "read"]),
  streamId: StreamIDSchema,
  recapId: RecapIDSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  readAt: timestamp.optional(),
})

const RecordSourceRevisionArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  recordType: z.enum(["stream", "outcome", "work_item", "attempt", "decision", "recap"]),
  recordId: text,
  workSourceId: WorkSourceIDSchema,
  sourceRevisionId: WorkSourceRevisionIDSchema,
  ordinal: z.number().int().nonnegative(),
})

const planningGeneration = z.strictObject({
  method: z.literal("planning"),
  attempt: z.number().int().nonnegative(),
  queuedAt: timestamp,
  startedAt: timestamp.optional(),
})
const failedPlanningGeneration = z
  .strictObject({
    method: z.literal("planning_failed"),
    attempt: z.number().int().nonnegative(),
    reason: text,
    failedAt: timestamp.optional(),
    invalidatedAt: timestamp.optional(),
    retryable: z.boolean(),
  })
  .refine(
    (value) => value.failedAt !== undefined || value.invalidatedAt !== undefined,
    "Planning failure requires a timestamp",
  )
const agentGeneration = z.strictObject({ method: z.literal("agent_session"), sessionId: text, generatedAt: timestamp })
const proposalBase = {
  ...publicMutable,
  workgraphId: WorkGraphIDSchema,
  proposalKind: text,
  source: WorkSourceRevisionRefSchema,
  previousSource: WorkSourceRevisionRefSchema.optional(),
  intakeCandidateId: text.optional(),
  diffSummary: z.string().optional(),
  planningEvidence: z.strictObject({
    targetStreamId: StreamIDSchema.optional(),
    placementMatches: z.array(AdmissionPlacementMatchSchema),
    duplicateMatches: z.array(AdmissionDuplicateMatchSchema),
  }),
}
const reviewableProposal = {
  ...proposalBase,
  generation: agentGeneration,
  suggestedPlacement: AdmissionSuggestedPlacementSchema,
  placementMatches: z.array(AdmissionPlacementMatchSchema),
  proposedOutcomes: z.array(AdmissionProposedOutcomeSchema),
  proposedWorkItems: z.array(AdmissionProposedWorkItemSchema),
  duplicateMatches: z.array(AdmissionDuplicateMatchSchema),
  disposition: z.strictObject({ selection: AdmissionSelectionSchema, streamId: StreamIDSchema }).optional(),
  confirmedChangeCursor: ChangeCursorSchema.optional(),
  confirmedAt: timestamp.optional(),
}
const AdmissionProposalArchiveValueSchema = z.union([
  z.strictObject({ ...proposalBase, state: z.literal("planning"), generation: planningGeneration }),
  z.strictObject({ ...proposalBase, state: z.literal("planning_failed"), generation: failedPlanningGeneration }),
  z.strictObject({ ...reviewableProposal, state: z.literal("proposed") }),
  z.strictObject({ ...reviewableProposal, state: z.literal("confirmed") }),
  z.strictObject({ ...reviewableProposal, state: z.literal("dismissed") }),
])

const OperationResultArchiveValueSchema = z.strictObject({
  ...storedImmutable,
  commandType: text,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  resultStatus: z.number().int().min(100).max(599),
  result: CommandResultSchema,
  changeCursor: ChangeCursorSchema.optional(),
})

const EventArchiveValueSchema = z.strictObject({
  schemaVersion,
  streamId: StreamIDSchema.optional(),
  sequence: z.number().int().positive(),
  type: WorkGraphEventTypeSchema,
  payload: PublicEventPayloadSchema,
  provenance: CommandProvenanceSchema,
  occurredAt: timestamp,
})

const RuntimeEffectArchiveValueSchema = z.strictObject({
  schemaVersion,
  effectKind: text,
  resourceType: text,
  resourceId: text,
  idempotencyKey: text,
  payload: PublicEventPayloadSchema,
  state: z.literal("completed"),
  attemptCount: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp,
})

const MigrationIntakeArchiveValueSchema = z.strictObject({
  ...storedMutable,
  legacyTable: text,
  legacyRecordId: text,
  intakeKind: z.enum(["source_review", "work_mapping_review", "attempt_mapping_review"]),
  reason: text,
  rawReference: jsonRecord,
  status: z.enum(["pending_review", "resolved", "dismissed"]),
  resolution: jsonRecord.optional(),
})

const CompletedExternalEffectArchiveValueSchema = z.strictObject({
  schemaVersion,
  operationId: OperationIDSchema,
  effectType: text,
  idempotencyKey: text,
  payload: PublicEventPayloadSchema,
  status: z.literal("completed"),
  availableAt: timestamp,
  attemptCount: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

const TerminalScheduledJobArchiveValueSchema = z.strictObject({
  schemaVersion,
  version,
  streamId: StreamIDSchema.optional(),
  jobType: text,
  subjectId: text,
  dueAt: timestamp,
  status: z.enum(["completed", "cancelled", "attention"]),
  payload: PublicEventPayloadSchema,
  leaseEpoch: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

const ChangeArchiveValueSchema = z.strictObject({
  schemaVersion,
  cursor: ChangeCursorSchema,
  eventId: WorkGraphEventIDSchema,
  operationId: OperationIDSchema,
  streamId: StreamIDSchema.optional(),
  resource: ChangeResourceSchema,
  changeType: WorkGraphEventTypeSchema,
  payload: PublicEventPayloadSchema,
  createdAt: timestamp,
})

const recordId = z.string().trim().min(1)
export const WorkGraphArchiveRecordSchema = z.discriminatedUnion("kind", [
  archiveRecord("workgraph", WorkGraphArchiveValueSchema),
  archiveRecord("work_source", WorkSourceArchiveValueSchema),
  archiveRecord("work_source_revision", WorkSourceRevisionArchiveValueSchema),
  archiveRecord("source_view", SourceViewArchiveValueSchema),
  archiveRecord("intake_candidate", IntakeCandidateArchiveValueSchema),
  archiveRecord("external_identity", ExternalIdentityArchiveValueSchema),
  archiveRecord("stream", StreamArchiveValueSchema),
  archiveRecord("outcome", OutcomeArchiveValueSchema),
  archiveRecord("work_item", WorkItemArchiveValueSchema),
  archiveRecord("work_item_dependency", WorkItemDependencyArchiveValueSchema),
  archiveRecord("attempt", AttemptArchiveValueSchema),
  archiveRecord("session_binding", SessionBindingArchiveValueSchema),
  archiveRecord("agent_checkpoint", AgentCheckpointArchiveValueSchema),
  archiveRecord("decision", DecisionArchiveValueSchema),
  archiveRecord("decision_work_item", DecisionWorkItemArchiveValueSchema),
  archiveRecord("evidence", EvidenceArchiveValueSchema),
  archiveRecord("durable_effect_receipt", DurableEffectReceiptArchiveValueSchema),
  archiveRecord("recap", RecapArchiveValueSchema),
  archiveRecord("notification", NotificationArchiveValueSchema),
  archiveRecord("record_source_revision", RecordSourceRevisionArchiveValueSchema),
  archiveRecord("admission_proposal", AdmissionProposalArchiveValueSchema),
  archiveRecord("operation_result", OperationResultArchiveValueSchema),
  archiveRecord("event", EventArchiveValueSchema),
  archiveRecord("change", ChangeArchiveValueSchema),
  archiveRecord("runtime_effect", RuntimeEffectArchiveValueSchema),
  archiveRecord("migration_intake", MigrationIntakeArchiveValueSchema),
  archiveRecord("completed_external_effect", CompletedExternalEffectArchiveValueSchema),
  archiveRecord("terminal_scheduled_job", TerminalScheduledJobArchiveValueSchema),
])
export type CanonicalWorkGraphArchiveRecord = z.infer<typeof WorkGraphArchiveRecordSchema>
/**
 * Compatibility-facing container type. Runtime admission remains the strict
 * per-kind union above; adapters narrow records by `kind` as they migrate.
 */
export type WorkGraphArchiveRecord = Readonly<{
  kind: WorkGraphArchiveRecordKind
  id: string
  value: Readonly<Record<string, unknown>>
}>

export const WorkGraphArchiveSchema = z
  .strictObject({
    version: z.literal(WORKGRAPH_ARCHIVE_VERSION),
    organizationId: OrganizationIDSchema,
    ownerUserId: OwnerUserIDSchema,
    exportedAt: timestamp,
    records: z.array(WorkGraphArchiveRecordSchema),
  })
  .superRefine((archive, context) => {
    const identities = new Set<string>()
    archive.records.forEach((record, index) => {
      const identity = `${record.kind}:${record.id}`
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "Archive record identity must be unique",
        })
      identities.add(identity)
      if (index > 0) {
        const previous = archive.records[index - 1]!
        if (`${previous.kind}:${previous.id}`.localeCompare(identity) >= 0) {
          context.addIssue({
            code: "custom",
            path: ["records", index],
            message: "Archive records must use canonical kind and ID order",
          })
        }
      }
      if (containsAuthorityField(record.value))
        context.addIssue({
          code: "custom",
          path: ["records", index, "value"],
          message: "Archive record values cannot contain owner or adapter authority fields",
        })
      if (containsSecret(record.value))
        context.addIssue({
          code: "custom",
          path: ["records", index, "value"],
          message: "Archive cannot contain credential material",
        })
    })
  })
export type CanonicalWorkGraphArchive = z.infer<typeof WorkGraphArchiveSchema>
export type WorkGraphArchive = Readonly<{
  version: typeof WORKGRAPH_ARCHIVE_VERSION
  organizationId: z.infer<typeof OrganizationIDSchema>
  ownerUserId: z.infer<typeof OwnerUserIDSchema>
  exportedAt: number
  records: readonly WorkGraphArchiveRecord[]
}>

export const WorkGraphArchiveRestoreRequestSchema = z.strictObject({
  operationId: OperationIDSchema,
  archive: WorkGraphArchiveSchema,
})

export const WorkGraphArchiveRestoreResultSchema = z.strictObject({
  restored: z.boolean(),
  recordCount: z.number().int().nonnegative(),
  baselineCursor: ChangeCursorSchema,
})
export type WorkGraphArchiveRestoreResult = z.infer<typeof WorkGraphArchiveRestoreResultSchema>

export const WorkGraphArchiveRestoreErrorReasonSchema = z.enum([
  "malformed",
  "cross_owner",
  "non_empty",
  "idempotency_conflict",
  "not_quiescent",
  "dependency_unavailable",
  "target_incompatible",
])

export type WorkGraphArchiveRestoreErrorReason = z.infer<typeof WorkGraphArchiveRestoreErrorReasonSchema>

export class WorkGraphArchiveRestoreError extends Error {
  readonly code = "archive_restore_rejected" as const

  constructor(readonly reason: WorkGraphArchiveRestoreErrorReason) {
    super("WorkGraph archive restore was rejected")
    this.name = "WorkGraphArchiveRestoreError"
  }
}

export async function validateWorkGraphArchive(input: unknown): Promise<WorkGraphArchive> {
  const parsed = WorkGraphArchiveSchema.safeParse(input)
  if (!parsed.success) throw new WorkGraphArchiveRestoreError("malformed")
  if (
    parsed.data.records.some(
      (record) => record.kind === "attempt" && ["admitted", "placing", "running"].includes(record.value.state),
    )
  ) {
    throw new WorkGraphArchiveRestoreError("not_quiescent")
  }
  if (parsed.data.records.some((record) => record.kind === "admission_proposal" && record.value.state === "planning")) {
    throw new WorkGraphArchiveRestoreError("not_quiescent")
  }
  for (const record of parsed.data.records.filter(
    (entry): entry is Extract<CanonicalWorkGraphArchiveRecord, { kind: "work_source_revision" }> =>
      entry.kind === "work_source_revision",
  )) {
    if ((await sha256(record.value.content)) !== record.value.contentHash.toLowerCase())
      throw new WorkGraphArchiveRestoreError("malformed")
  }
  return parsed.data
}

export async function hashWorkGraphArchive(archive: WorkGraphArchive) {
  return sha256(canonicalJson(archive))
}

function archiveRecord<const Kind extends string, Value extends z.ZodType>(kind: Kind, value: Value) {
  return z.strictObject({ kind: z.literal(kind), id: recordId, value })
}

function containsSecret(value: unknown, key = ""): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  if (
    /^(?:credential|credentials|password|passwords|secret|secrets|token|tokens|authorization|cookie|passphrase|privatekey|clientsecret|refreshtoken|accesstoken|apikey|authkey|bearertoken)$/.test(
      normalized,
    )
  )
    return true
  if (typeof value === "string") {
    return (
      /^(?:basic|bearer)\s+\S+/i.test(value.trim()) ||
      /^(?:github_pat_|gh[pousr]_|lin_api_|xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}$/i.test(value.trim()) ||
      /^AKIA[A-Z0-9]{16}$/.test(value.trim()) ||
      /^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value.trim())
    )
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry))
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([nestedKey, nested]) => containsSecret(nested, nestedKey))
}

function containsAuthorityField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthorityField)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
    return (
      ["owneruserid", "ownerid", "orgid", "organizationid", "rowversion", "creationtime"].includes(normalized) ||
      key === "_id" ||
      containsAuthorityField(nested)
    )
  })
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonical(value))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}
