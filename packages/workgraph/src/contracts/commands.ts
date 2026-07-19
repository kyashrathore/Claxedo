import { z } from "zod"
import { CompletionContractSchema, EvidenceSubjectSchema } from "./completion"
import { WorkGraphActorSchema } from "./context"
import { ExecutionProfileDefaultsSchema, WorkGraphDefaultsSchema } from "./execution"
import {
  AttemptIDSchema,
  DecisionIDSchema,
  EvidenceIDSchema,
  OperationIDSchema,
  OutcomeIDSchema,
  RequestIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
  WorkSourceIDSchema,
  WorkSourceRevisionIDSchema,
} from "./ids"
import { StreamLifecycleStateSchema, StreamVisibilitySchema } from "./lifecycle"
import { AuthoringSourceRevisionSchema, WorkSourceRevisionRefSchema } from "./work-source"
import { ChangeCursorSchema } from "./change-cursor"
import { AgentCheckpointLevelSchema, StreamActivityGranularitySchema } from "./activity"
import { StreamCharterSchema } from "./charter"

export { ChangeCursorSchema, type ChangeCursor } from "./change-cursor"

const version = z.literal(1)
const text = z.string().trim().min(1)
const expectedVersion = z.number().int().nonnegative()
const executionWithoutStreamTarget = ExecutionProfileDefaultsSchema.refine(
  (execution) => !execution.environment && !execution.repository,
  "Environment and repository target belong to the Stream",
)
const workGraphDefaults = WorkGraphDefaultsSchema.refine(
  (defaults) => !defaults.execution.environment && !defaults.execution.repository,
  "Environment and repository target belong to the Stream",
)

export const AdmissionProposalIDSchema = text.brand("AdmissionProposalID")
export type AdmissionProposalID = z.infer<typeof AdmissionProposalIDSchema>

export const UpdateWorkGraphDefaultsCommandSchema = z.strictObject({
  version,
  type: z.literal("update_workgraph_defaults"),
  expectedVersion,
  defaults: workGraphDefaults,
})
export type UpdateWorkGraphDefaultsCommand = z.infer<typeof UpdateWorkGraphDefaultsCommandSchema>

export const CreateWorkSourceCommandSchema = z.strictObject({
  version,
  type: z.literal("create_work_source"),
  title: text,
  content: z.string().min(1),
  authoring: AuthoringSourceRevisionSchema.optional(),
})
export type CreateWorkSourceCommand = z.infer<typeof CreateWorkSourceCommandSchema>

export const ReviseWorkSourceCommandSchema = z.strictObject({
  version,
  type: z.literal("revise_work_source"),
  workSourceId: WorkSourceIDSchema,
  expectedRevisionId: WorkSourceRevisionIDSchema,
  title: text.optional(),
  content: z.string().min(1),
  authoring: AuthoringSourceRevisionSchema.optional(),
})
export type ReviseWorkSourceCommand = z.infer<typeof ReviseWorkSourceCommandSchema>

export const CreateStreamCommandSchema = z.strictObject({
  version,
  type: z.literal("create_stream"),
  title: text,
  description: z.string().optional(),
  charter: StreamCharterSchema.optional(),
  source: WorkSourceRevisionRefSchema.optional(),
  execution: ExecutionProfileDefaultsSchema.optional(),
  activityGranularity: StreamActivityGranularitySchema.optional(),
})
export type CreateStreamCommand = z.infer<typeof CreateStreamCommandSchema>

export const UpdateStreamCommandSchema = z.strictObject({
  version,
  type: z.literal("update_stream"),
  streamId: StreamIDSchema,
  expectedVersion,
  title: text.optional(),
  description: z.string().optional(),
  execution: ExecutionProfileDefaultsSchema.optional(),
  activityGranularity: StreamActivityGranularitySchema.optional(),
})
export type UpdateStreamCommand = z.infer<typeof UpdateStreamCommandSchema>

export const CreateOutcomeCommandSchema = z.strictObject({
  version,
  type: z.literal("create_outcome"),
  streamId: StreamIDSchema,
  title: text,
  description: z.string().optional(),
  successCriteria: z.array(text).min(1),
  execution: executionWithoutStreamTarget.optional(),
})
export type CreateOutcomeCommand = z.infer<typeof CreateOutcomeCommandSchema>

export const UpdateOutcomeCommandSchema = z.strictObject({
  version,
  type: z.literal("update_outcome"),
  outcomeId: OutcomeIDSchema,
  expectedVersion,
  title: text.optional(),
  description: z.string().optional(),
  successCriteria: z.array(text).min(1).optional(),
  execution: executionWithoutStreamTarget.optional(),
})
export type UpdateOutcomeCommand = z.infer<typeof UpdateOutcomeCommandSchema>

export const CreateWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("create_work_item"),
  streamId: StreamIDSchema,
  outcomeId: OutcomeIDSchema.optional(),
  title: text,
  description: z.string().optional(),
  priority: z.number().int().nonnegative().optional(),
  dependencyIds: z.array(WorkItemIDSchema).optional(),
  source: WorkSourceRevisionRefSchema.optional(),
  completionContract: CompletionContractSchema,
  execution: executionWithoutStreamTarget.optional(),
})
export type CreateWorkItemCommand = z.infer<typeof CreateWorkItemCommandSchema>

export const UpdateWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("update_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
  outcomeId: OutcomeIDSchema.nullable().optional(),
  title: text.optional(),
  description: z.string().optional(),
  priority: z.number().int().nonnegative().optional(),
  dependencyIds: z.array(WorkItemIDSchema).optional(),
  completionContract: CompletionContractSchema.optional(),
  execution: executionWithoutStreamTarget.optional(),
})
export type UpdateWorkItemCommand = z.infer<typeof UpdateWorkItemCommandSchema>

export const ProposeAdmissionCommandSchema = z.strictObject({
  version,
  type: z.literal("propose_admission"),
  source: WorkSourceRevisionRefSchema,
  targetStreamId: StreamIDSchema.optional(),
  execution: ExecutionProfileDefaultsSchema.optional(),
})
export type ProposeAdmissionCommand = z.infer<typeof ProposeAdmissionCommandSchema>

export const RetryAdmissionPlanningCommandSchema = z.strictObject({
  version,
  type: z.literal("retry_admission_planning"),
  proposalId: AdmissionProposalIDSchema,
  expectedVersion,
})
export type RetryAdmissionPlanningCommand = z.infer<typeof RetryAdmissionPlanningCommandSchema>

export const DismissAdmissionCommandSchema = z.strictObject({
  version,
  type: z.literal("dismiss_admission"),
  proposalId: AdmissionProposalIDSchema,
  expectedVersion,
})
export type DismissAdmissionCommand = z.infer<typeof DismissAdmissionCommandSchema>

export const ReopenAdmissionCommandSchema = z.strictObject({
  version,
  type: z.literal("reopen_admission"),
  proposalId: AdmissionProposalIDSchema,
  expectedVersion,
})
export type ReopenAdmissionCommand = z.infer<typeof ReopenAdmissionCommandSchema>

export const AdmissionSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("create"), streamTitle: text }),
  z.strictObject({ mode: z.literal("existing"), streamId: StreamIDSchema }),
  z.strictObject({ mode: z.literal("keep"), streamId: StreamIDSchema }),
  z.strictObject({
    mode: z.literal("replace"),
    streamId: StreamIDSchema,
    workItems: z.array(z.strictObject({
      workItemId: WorkItemIDSchema,
      expectedVersion,
    })).min(1),
  }),
  z.strictObject({ mode: z.literal("fork"), streamId: StreamIDSchema, streamTitle: text }),
])
export type AdmissionSelection = z.infer<typeof AdmissionSelectionSchema>

export const AdmissionOutcomeInputSchema = z.strictObject({
  proposalKey: text,
  title: text,
  description: z.string().optional(),
  successCriteria: z.array(text).min(1),
  execution: ExecutionProfileDefaultsSchema.optional(),
})
export type AdmissionOutcomeInput = z.infer<typeof AdmissionOutcomeInputSchema>

export const AdmissionWorkItemInputSchema = z.strictObject({
  proposalKey: text,
  outcomeProposalKey: text.optional(),
  title: text,
  description: z.string().optional(),
  dependencyProposalKeys: z.array(text).optional(),
  completionContract: CompletionContractSchema,
  execution: ExecutionProfileDefaultsSchema.optional(),
})
export type AdmissionWorkItemInput = z.infer<typeof AdmissionWorkItemInputSchema>

export const ConfirmAdmissionCommandSchema = z.strictObject({
  version,
  type: z.literal("confirm_admission"),
  proposalId: AdmissionProposalIDSchema,
  expectedVersion,
  source: WorkSourceRevisionRefSchema,
  selection: AdmissionSelectionSchema,
  outcomes: z.array(AdmissionOutcomeInputSchema).optional(),
  workItems: z.array(AdmissionWorkItemInputSchema).optional(),
  charter: StreamCharterSchema.optional(),
})
export type ConfirmAdmissionCommand = z.infer<typeof ConfirmAdmissionCommandSchema>

export const SetStreamCharterCommandSchema = z.strictObject({
  version,
  type: z.literal("set_stream_charter"),
  streamId: StreamIDSchema,
  expectedVersion,
  charter: StreamCharterSchema,
})
export type SetStreamCharterCommand = z.infer<typeof SetStreamCharterCommandSchema>

export const CallMasterCommandSchema = z.strictObject({
  version,
  type: z.literal("call_master"),
  streamId: StreamIDSchema,
  expectedVersion,
  message: text.max(10_000),
})
export type CallMasterCommand = z.infer<typeof CallMasterCommandSchema>

export const StreamNotesExternalReferenceSchema = z.strictObject({
  source: WorkSourceRevisionRefSchema,
  quote: z.string().trim().min(1).max(20_000),
})
export type StreamNotesExternalReference = z.infer<typeof StreamNotesExternalReferenceSchema>

export const UpdateStreamNotesCommandSchema = z.strictObject({
  version,
  type: z.literal("update_stream_notes"),
  streamId: StreamIDSchema,
  expectedVersion,
  status: z.array(text.max(2_000)).max(100),
  learnings: z.array(text.max(2_000)).max(100),
  externalReferences: z.array(StreamNotesExternalReferenceSchema).max(100).default([]),
})
export type UpdateStreamNotesCommand = z.infer<typeof UpdateStreamNotesCommandSchema>

export const RequestPublicPullRequestConfirmationCommandSchema = z.strictObject({
  version,
  type: z.literal("request_public_pr_confirmation"),
  streamId: StreamIDSchema,
  expectedVersion,
  repository: text.max(512),
  title: text.max(1_000),
})
export type RequestPublicPullRequestConfirmationCommand = z.infer<typeof RequestPublicPullRequestConfirmationCommandSchema>

export const ConfirmPublicPullRequestCommandSchema = z.strictObject({
  version,
  type: z.literal("confirm_public_pr"),
  streamId: StreamIDSchema,
  expectedVersion,
})
export type ConfirmPublicPullRequestCommand = z.infer<typeof ConfirmPublicPullRequestCommandSchema>

export const RecordMasterAuditCommandSchema = z.strictObject({
  version,
  type: z.literal("record_master_audit"),
  streamId: StreamIDSchema,
  expectedVersion,
  sessionId: text.max(512),
  wakeTrigger: z.enum(["mailbox", "task_settled", "schedule"]),
  charterHash: z.string().regex(/^[a-f0-9]{64}$/),
  citedCharterClause: text.max(1_000),
  modelVersion: text.max(512),
  reasoningSummary: text.max(1_000),
  toolCalls: z.array(text.max(512)).max(100).default([]),
  resultingDiffs: z.array(text.max(2_048)).max(100).default([]),
  evidenceIds: z.array(EvidenceIDSchema).max(100).default([]),
  outcome: z.enum(["admitted", "succeeded", "failed", "escalated"]),
})
export type RecordMasterAuditCommand = z.infer<typeof RecordMasterAuditCommandSchema>

export const SetStreamLifecycleCommandSchema = z.strictObject({
  version,
  type: z.literal("set_stream_lifecycle"),
  streamId: StreamIDSchema,
  expectedVersion,
  state: StreamLifecycleStateSchema,
  reason: text,
})
export type SetStreamLifecycleCommand = z.infer<typeof SetStreamLifecycleCommandSchema>

export const SetStreamVisibilityCommandSchema = z.strictObject({
  version,
  type: z.literal("set_stream_visibility"),
  streamId: StreamIDSchema,
  expectedVersion,
  visibility: StreamVisibilitySchema,
})
export type SetStreamVisibilityCommand = z.infer<typeof SetStreamVisibilityCommandSchema>

export const ApproveWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("approve_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
})
export type ApproveWorkItemCommand = z.infer<typeof ApproveWorkItemCommandSchema>

export const RejectWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("reject_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
  reason: text,
})
export type RejectWorkItemCommand = z.infer<typeof RejectWorkItemCommandSchema>

export const ApproveWorkItemsCommandSchema = z.strictObject({
  version,
  type: z.literal("approve_work_items"),
  approvals: z
    .array(
      z.strictObject({
        workItemId: WorkItemIDSchema,
        expectedVersion,
      }),
    )
    .min(1)
    .max(200),
})
export type ApproveWorkItemsCommand = z.infer<typeof ApproveWorkItemsCommandSchema>

export const CancelAttemptCommandSchema = z.strictObject({
  version,
  type: z.literal("cancel_attempt"),
  attemptId: AttemptIDSchema,
  expectedVersion,
  reason: text,
})
export type CancelAttemptCommand = z.infer<typeof CancelAttemptCommandSchema>

export const RetryWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("retry_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
})
export type RetryWorkItemCommand = z.infer<typeof RetryWorkItemCommandSchema>

export const DecisionOptionInputSchema = z.strictObject({
  id: text,
  label: text,
  description: z.string().optional(),
})
export type DecisionOptionInput = z.infer<typeof DecisionOptionInputSchema>

export const ProposeDecisionCommandSchema = z.strictObject({
  version,
  type: z.literal("propose_decision"),
  streamId: StreamIDSchema,
  question: text,
  options: z.array(DecisionOptionInputSchema).min(1),
  recommendationOptionId: text.optional(),
  rationale: z.string().optional(),
  affectedWorkItemIds: z.array(WorkItemIDSchema).min(1),
})
export type ProposeDecisionCommand = z.infer<typeof ProposeDecisionCommandSchema>

export const AnswerDecisionCommandSchema = z.strictObject({
  version,
  type: z.literal("answer_decision"),
  decisionId: DecisionIDSchema,
  expectedVersion,
  optionId: text.optional(),
  answer: text.optional(),
})
export type AnswerDecisionCommand = z.infer<typeof AnswerDecisionCommandSchema>

export const DismissDecisionCommandSchema = z.strictObject({
  version,
  type: z.literal("dismiss_decision"),
  decisionId: DecisionIDSchema,
  expectedVersion,
  reason: text,
})
export type DismissDecisionCommand = z.infer<typeof DismissDecisionCommandSchema>

export const EvidenceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("test_result"), summary: text, passed: z.boolean(), command: text.optional(), outputRef: text.optional() }),
  z.strictObject({ kind: z.literal("artifact"), summary: text, artifactRef: text, mediaType: text.optional() }),
  z.strictObject({ kind: z.literal("review"), summary: text, verdict: z.enum(["approved", "changes_requested"]), reviewer: text.optional() }),
  z.strictObject({
    kind: z.literal("integration"),
    summary: text,
    effect: z.enum(["merged", "published", "accepted_external_write", "other"]),
    reference: text,
  }),
  z.strictObject({ kind: z.literal("owner_confirmation"), summary: text, confirmed: z.boolean() }),
  z.strictObject({ kind: z.literal("finding"), summary: text, sourceRef: text.optional() }),
])
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>

export const RecordEvidenceCommandSchema = z.strictObject({
  version,
  type: z.literal("record_evidence"),
  subject: EvidenceSubjectSchema,
  requirementId: text.optional(),
  sourceAttemptId: AttemptIDSchema.optional(),
  evidence: EvidenceInputSchema,
})
export type RecordEvidenceCommand = z.infer<typeof RecordEvidenceCommandSchema>

export const RecordAttemptCheckpointCommandSchema = z.strictObject({
  version,
  type: z.literal("record_attempt_checkpoint"),
  attemptId: AttemptIDSchema,
  sessionId: text.max(512),
  workspaceId: text.max(1_024),
  leaseEpoch: z.number().int().positive().optional(),
  level: AgentCheckpointLevelSchema,
  summary: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(EvidenceIDSchema).max(100).default([]),
})
export type RecordAttemptCheckpointCommand = z.infer<typeof RecordAttemptCheckpointCommandSchema>

export const AttemptCompletionEvidenceInputSchema = z.strictObject({
  requirementId: text.optional(),
  evidence: EvidenceInputSchema,
})
export type AttemptCompletionEvidenceInput = z.infer<typeof AttemptCompletionEvidenceInputSchema>

export const CompleteAttemptCommandSchema = z.strictObject({
  version,
  type: z.literal("complete_attempt"),
  attemptId: AttemptIDSchema,
  sessionId: text.max(512),
  workspaceId: text.max(1_024),
  leaseEpoch: z.number().int().positive().optional(),
  summary: z.string().trim().min(1).max(10_000),
  artifacts: z.array(text).max(100).default([]),
  evidence: z.array(AttemptCompletionEvidenceInputSchema).min(1).max(100),
})
export type CompleteAttemptCommand = z.infer<typeof CompleteAttemptCommandSchema>

export const CloseOutcomeCommandSchema = z.strictObject({
  version,
  type: z.literal("close_outcome"),
  outcomeId: OutcomeIDSchema,
  expectedVersion,
  reason: text,
})
export type CloseOutcomeCommand = z.infer<typeof CloseOutcomeCommandSchema>

export const ReopenOutcomeCommandSchema = z.strictObject({
  version,
  type: z.literal("reopen_outcome"),
  outcomeId: OutcomeIDSchema,
  expectedVersion,
  reason: text,
})
export type ReopenOutcomeCommand = z.infer<typeof ReopenOutcomeCommandSchema>

export const CloseStreamCommandSchema = z.strictObject({
  version,
  type: z.literal("close_stream"),
  streamId: StreamIDSchema,
  expectedVersion,
  reason: text,
})
export type CloseStreamCommand = z.infer<typeof CloseStreamCommandSchema>

export const DeleteStreamCommandSchema = z.strictObject({
  version,
  type: z.literal("delete_stream"),
  streamId: StreamIDSchema,
  expectedVersion,
  reason: text,
})
export type DeleteStreamCommand = z.infer<typeof DeleteStreamCommandSchema>

// Soft removal of a single Work Item: transitions it to the terminal
// `abandoned` lifecycle (reusing the same state a stream/outcome close applies),
// rather than a hard delete that would dangle attempt/lease/dependency refs.
export const CancelWorkItemCommandSchema = z.strictObject({
  version,
  type: z.literal("cancel_work_item"),
  workItemId: WorkItemIDSchema,
  expectedVersion,
  reason: text,
})
export type CancelWorkItemCommand = z.infer<typeof CancelWorkItemCommandSchema>

export const WorkGraphCommandSchema = z.discriminatedUnion("type", [
  UpdateWorkGraphDefaultsCommandSchema,
  CreateWorkSourceCommandSchema,
  ReviseWorkSourceCommandSchema,
  CreateStreamCommandSchema,
  UpdateStreamCommandSchema,
  CreateOutcomeCommandSchema,
  UpdateOutcomeCommandSchema,
  CreateWorkItemCommandSchema,
  UpdateWorkItemCommandSchema,
  ProposeAdmissionCommandSchema,
  RetryAdmissionPlanningCommandSchema,
  DismissAdmissionCommandSchema,
  ReopenAdmissionCommandSchema,
  ConfirmAdmissionCommandSchema,
  SetStreamCharterCommandSchema,
  CallMasterCommandSchema,
  UpdateStreamNotesCommandSchema,
  RequestPublicPullRequestConfirmationCommandSchema,
  ConfirmPublicPullRequestCommandSchema,
  RecordMasterAuditCommandSchema,
  SetStreamLifecycleCommandSchema,
  SetStreamVisibilityCommandSchema,
  ApproveWorkItemCommandSchema,
  RejectWorkItemCommandSchema,
  ApproveWorkItemsCommandSchema,
  CancelAttemptCommandSchema,
  RetryWorkItemCommandSchema,
  ProposeDecisionCommandSchema,
  AnswerDecisionCommandSchema,
  DismissDecisionCommandSchema,
  RecordAttemptCheckpointCommandSchema,
  CompleteAttemptCommandSchema,
  RecordEvidenceCommandSchema,
  CloseOutcomeCommandSchema,
  ReopenOutcomeCommandSchema,
  CloseStreamCommandSchema,
  DeleteStreamCommandSchema,
  CancelWorkItemCommandSchema,
])
export type WorkGraphCommand = z.infer<typeof WorkGraphCommandSchema>

export const WorkGraphCommandRequestSchema = z.strictObject({
  operationId: OperationIDSchema,
  command: WorkGraphCommandSchema,
})
export type WorkGraphCommandRequest = z.infer<typeof WorkGraphCommandRequestSchema>

export const CommandErrorCodeSchema = z.enum([
  "validation_error",
  "not_found",
  "forbidden",
  "version_conflict",
  "invalid_transition",
  "idempotency_conflict",
  "blocked",
  "close_required",
  "credential_reference_invalid",
  "execution_unavailable",
  "landing_integrity_violation",
  "internal_error",
])
export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>

export const CommandErrorSchema = z.strictObject({
  code: CommandErrorCodeSchema,
  message: text,
  retryable: z.boolean(),
  details: z.record(z.string(), z.json()).optional(),
})
export type CommandError = z.infer<typeof CommandErrorSchema>

export const CommandSuccessSchema = z.strictObject({
  ok: z.literal(true),
  operationId: OperationIDSchema,
  cursor: ChangeCursorSchema,
  value: z.json(),
})
export type CommandSuccess = z.infer<typeof CommandSuccessSchema>

export const CommandFailureSchema = z.strictObject({
  ok: z.literal(false),
  operationId: OperationIDSchema,
  cursor: ChangeCursorSchema.optional(),
  error: CommandErrorSchema,
})
export type CommandFailure = z.infer<typeof CommandFailureSchema>

export const CommandResultSchema = z.discriminatedUnion("ok", [CommandSuccessSchema, CommandFailureSchema])
export type CommandResult = z.infer<typeof CommandResultSchema>

export const CommandProvenanceSchema = z.strictObject({
  actor: WorkGraphActorSchema,
  operationId: OperationIDSchema,
  requestId: RequestIDSchema,
  correlationId: text.optional(),
  causationId: text.optional(),
})
export type CommandProvenance = z.infer<typeof CommandProvenanceSchema>
