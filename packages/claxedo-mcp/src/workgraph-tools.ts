import { z } from "zod"
import {
  AdmissionProposalDtoSchema,
  AdmissionOutcomeInputSchema,
  AdmissionWorkItemInputSchema,
  AttentionPageSchema,
  AttemptDetailDtoSchema,
  CommandResultSchema,
  CompletionContractSchema,
  DecisionOptionInputSchema,
  DecisionDtoSchema,
  EvidenceDtoSchema,
  EvidenceInputSchema,
  EvidencePageSchema,
  EvidenceSubjectSchema,
  ExecutionCapabilitiesSchema,
  ExecutionProfileDefaultsSchema,
  IntakeCandidateDtoSchema,
  IntakeCandidatePageSchema,
  RecapDtoSchema,
  RecapProfileDefaultsSchema,
  ResolvedExecutionProfileSchema,
  SessionBindingDtoSchema,
  SourceViewDtoSchema,
  SourceViewListResponseSchema,
  SourceViewRefreshResponseSchema,
  StreamActivityGranularitySchema,
  TaskActivityPageSchema,
  StreamDtoSchema,
  WorkGraphChangeEnvelopeSchema,
  WorkGraphCommandRequestSchema,
  WorkSourceDtoSchema,
  WorkSourceRevisionDtoSchema,
  WorkGraphDefaultsSchema,
  WorkGraphNotificationPageSchema,
  WorkGraphNotificationSchema,
  WorkGraphSnapshotPageSchema,
  WorkItemAttemptPageSchema,
  WorkItemDtoSchema,
  collectWorkGraphSnapshotPages,
  type SnapshotResumeCursor,
} from "@claxedo/workgraph/contracts"
import { McpHttpError } from "./http-error"

type ToolResult = Readonly<{ content: readonly Readonly<{ type: "text"; text: string }>[]; isError?: boolean }>
type Register = (
  name: string,
  config: Readonly<{ description: string; inputSchema: Record<string, unknown> }>,
  handler: (input: Record<string, unknown>) => Promise<ToolResult>,
) => void
type Request = <Result>(path: string, init?: RequestInit) => Promise<Result>
export type EmbeddedWorkGraphTransport = Readonly<{
  execute(request: Readonly<Record<string, unknown>>): Promise<unknown>
  snapshot(input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>): Promise<unknown>
  readStream(streamId: string): Promise<unknown>
  readDefaults?(): Promise<unknown>
  readExecutionCapabilities?(): Promise<unknown>
  refreshExecutionCapabilities?(): Promise<unknown>
  listAttention?(input: Readonly<{ after?: string; limit: number }>): Promise<unknown>
  listNotifications?(input: Readonly<{ after?: string; limit: number; state?: "unread" | "read" }>): Promise<unknown>
  markNotificationRead?(notificationId: string, expectedVersion: number): Promise<unknown>
  listSources?(input: Readonly<{ after?: string; limit: number }>): Promise<unknown>
  readSource?(workSourceId: string): Promise<unknown>
  readSourceRevision?(workSourceId: string, revisionId: string): Promise<unknown>
  readProposal?(proposalId: string): Promise<unknown>
  readWorkItem?(workItemId: string): Promise<unknown>
  listWorkItemAttempts?(workItemId: string, input: Readonly<{ after?: string; limit: number }>): Promise<unknown>
  listWorkItemActivity?(workItemId: string, input: Readonly<{ granularity: "milestones" | "progress" | "detailed"; after?: string; limit: number }>): Promise<unknown>
  readAttempt?(attemptId: string): Promise<unknown>
  readDecision?(decisionId: string): Promise<unknown>
  readRecap?(recapId: string): Promise<unknown>
  readEvidence?(evidenceId: string): Promise<unknown>
  listEvidence?(input: Readonly<{ subject: unknown; after?: string; limit: number }>): Promise<unknown>
  listSourceViews?(): Promise<unknown>
  createSourceView?(input: Readonly<Record<string, unknown>>): Promise<unknown>
  updateSourceView?(sourceViewId: string, input: Readonly<Record<string, unknown>>): Promise<unknown>
  deleteSourceView?(sourceViewId: string, expectedVersion: number): Promise<unknown>
  refreshSourceView?(sourceViewId: string): Promise<unknown>
  listIntake?(input: Readonly<{ sourceViewId?: string; after?: string; limit: number }>): Promise<unknown>
  readCandidate?(candidateId: string): Promise<unknown>
  stageCandidate?(candidateId: string): Promise<unknown>
  dismissCandidate?(candidateId: string, expectedVersion: number): Promise<unknown>
  restoreCandidate?(candidateId: string, expectedVersion: number): Promise<unknown>
  syncCandidate?(candidateId: string, input: Readonly<{ idempotencyKey: string; summary: string; status?: string }>): Promise<unknown>
  bindSession?(input: Readonly<Record<string, unknown>>): Promise<unknown>
  readSessionBinding?(sessionId: string): Promise<unknown>
  attachSessionTask?(input: Readonly<Record<string, unknown>>): Promise<unknown>
  recordSessionCheckpoint?(input: Readonly<Record<string, unknown>>): Promise<unknown>
  releaseSessionBinding?(input: Readonly<Record<string, unknown>>): Promise<unknown>
}>
type WorkGraphTransport = Request | EmbeddedWorkGraphTransport
export type WorkGraphCreationContext = Readonly<{
  execution?: z.input<typeof ExecutionProfileDefaultsSchema>
  session?: Readonly<{
    sessionId: string
    projectId: string
    resolvedExecution?: z.input<typeof ResolvedExecutionProfileSchema>
  }>
}>
export type WorkGraphCreationContextProvider = WorkGraphCreationContext | (() => Promise<WorkGraphCreationContext>)

export class WorkGraphRecordNotFoundError extends Error {
  readonly code = "not_found"
  readonly status = 404

  constructor(
    readonly recordType: string,
    readonly recordId: string,
  ) {
    super(`WorkGraph ${recordType} '${recordId}' was not found`)
    this.name = "WorkGraphRecordNotFoundError"
  }
}

export class WorkGraphSessionAttachmentDeniedError extends Error {
  readonly code = "session_attachment_denied"
  readonly status = 403

  constructor() {
    super("WorkGraph Session attachment requires trusted embedded Session context")
    this.name = "WorkGraphSessionAttachmentDeniedError"
  }
}

const operation = { operation_id: z.string().describe("Unique idempotency key for this mutation.") }
const sourceRef = {
  work_source_id: z.string(),
  revision_id: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/i),
}
const ReviewedReplacementWorkItemsSchema = z.array(z.strictObject({
  work_item_id: z.string().trim().min(1),
  expected_version: z.number().int().nonnegative(),
})).min(1).superRefine((items, context) => {
  const ids = new Set<string>()
  items.forEach((item, index) => {
    if (!ids.has(item.work_item_id)) return ids.add(item.work_item_id)
    context.addIssue({ code: "custom", path: [index, "work_item_id"], message: "Reviewed Work Items must be unique" })
  })
})
const ChangesResponseSchema = z.strictObject({
  changes: z.array(WorkGraphChangeEnvelopeSchema),
  cursor: z.string().trim().min(1).optional(),
  timedOut: z.boolean(),
})

export const WORKGRAPH_CAPABILITY_MAP = [
  { uiAction: "Read personal WorkGraph defaults", tool: "workgraph_get_defaults", mutating: false },
  { uiAction: "Update personal WorkGraph defaults", tool: "workgraph_update_defaults", mutating: true },
  { uiAction: "Read live execution capabilities", tool: "workgraph_execution_capabilities", mutating: false },
  { uiAction: "Refresh live execution capabilities", tool: "workgraph_refresh_execution_capabilities", mutating: true },
  { uiAction: "List work requiring owner attention", tool: "workgraph_attention", mutating: false },
  { uiAction: "List WorkGraph notifications", tool: "workgraph_notifications", mutating: false },
  { uiAction: "Mark a WorkGraph notification read", tool: "workgraph_mark_notification_read", mutating: true },
  { uiAction: "List or inspect WorkGraph", tool: "workgraph_list", mutating: false },
  { uiAction: "Get a WorkGraph record", tool: "workgraph_get", mutating: false },
  { uiAction: "Read an exact Work Source revision", tool: "workgraph_source_revision", mutating: false },
  { uiAction: "Read the ordered WorkGraph change feed", tool: "workgraph_changes", mutating: false },
  { uiAction: "Create or revise a Work Source", tool: "workgraph_source", mutating: true },
  { uiAction: "Create a Stream", tool: "workgraph_create_stream", mutating: true },
  { uiAction: "Create an Outcome", tool: "workgraph_create_outcome", mutating: true },
  { uiAction: "Create a Task", tool: "workgraph_create_task", mutating: true },
  { uiAction: "Create an Outcome or Work Item", tool: "workgraph_create_work", mutating: true },
  { uiAction: "Update a Stream, Outcome, or Task", tool: "workgraph_update", mutating: true },
  { uiAction: "Bind the current Session to a Stream", tool: "workgraph_bind_session", mutating: true },
  { uiAction: "Read the current Session's WorkGraph work", tool: "workgraph_current_work", mutating: false },
  { uiAction: "Select the current Session's Task", tool: "workgraph_select_work", mutating: true },
  { uiAction: "Record meaningful current-Task progress", tool: "workgraph_record_progress", mutating: true },
  { uiAction: "Refresh the current Session's WorkGraph context", tool: "workgraph_refresh_context", mutating: false },
  { uiAction: "Complete the current Session's Task with evidence", tool: "workgraph_complete_current_work", mutating: true },
  { uiAction: "Release the current Session's WorkGraph binding", tool: "workgraph_release_session", mutating: true },
  { uiAction: "Propose source admission", tool: "workgraph_propose_admission", mutating: true },
  { uiAction: "Confirm source admission", tool: "workgraph_admit", mutating: true },
  { uiAction: "Retry, dismiss, or reopen a source proposal", tool: "workgraph_review_proposal", mutating: true },
  { uiAction: "List personal issue Source Views", tool: "workgraph_source_views", mutating: false },
  { uiAction: "Configure a personal issue Source View", tool: "workgraph_configure_source_view", mutating: true },
  { uiAction: "Update a personal issue Source View", tool: "workgraph_update_source_view", mutating: true },
  { uiAction: "Delete a personal issue Source View", tool: "workgraph_delete_source_view", mutating: true },
  { uiAction: "Refresh a personal issue Source View", tool: "workgraph_refresh_source_view", mutating: true },
  { uiAction: "List external issue and independent-session intake candidates", tool: "workgraph_intake", mutating: false },
  { uiAction: "Read an intake candidate", tool: "workgraph_get_candidate", mutating: false },
  { uiAction: "Stage an intake candidate and create its bounded admission proposal", tool: "workgraph_stage_candidate", mutating: true },
  { uiAction: "Dismiss or restore an intake candidate", tool: "workgraph_update_candidate", mutating: true },
  { uiAction: "Announce a meaningful result through its Connection", tool: "workgraph_sync_candidate", mutating: true },
  { uiAction: "Execute work", tool: "workgraph_execute", mutating: true },
  { uiAction: "Update Stream execution defaults", tool: "workgraph_update_execution", mutating: true },
  { uiAction: "Retry a Work Item", tool: "workgraph_retry", mutating: true },
  { uiAction: "Cancel a Work Item", tool: "workgraph_cancel_work", mutating: true },
  { uiAction: "Set Stream lifecycle", tool: "workgraph_stream_lifecycle", mutating: true },
  { uiAction: "Pause a Stream", tool: "workgraph_pause", mutating: true },
  { uiAction: "Cancel an Attempt", tool: "workgraph_cancel", mutating: true },
  { uiAction: "Record a finding", tool: "workgraph_record_finding", mutating: true },
  { uiAction: "Create follow-up work", tool: "workgraph_create_followup", mutating: true },
  { uiAction: "Propose or answer a Decision", tool: "workgraph_decision", mutating: true },
  { uiAction: "Record evidence", tool: "workgraph_record_evidence", mutating: true },
  { uiAction: "List or inspect evidence", tool: "workgraph_evidence", mutating: false },
  { uiAction: "List a Work Item's Attempts", tool: "workgraph_attempts", mutating: false },
  { uiAction: "Read a Task's bounded activity", tool: "workgraph_activity", mutating: false },
  { uiAction: "Read a Recap", tool: "workgraph_recap", mutating: false },
  { uiAction: "Close a Stream or Outcome", tool: "workgraph_close", mutating: true },
  { uiAction: "Delete an eligible Stream", tool: "workgraph_delete", mutating: true },
] as const

export const WORKGRAPH_TOOL_SCHEMAS = {
  workgraph_get_defaults: {},
  workgraph_update_defaults: { ...operation, expected_version: z.number().int().nonnegative(), defaults: WorkGraphDefaultsSchema },
  workgraph_execution_capabilities: {},
  workgraph_refresh_execution_capabilities: {},
  workgraph_attention: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_notifications: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), state: z.enum(["unread", "read"]).optional() },
  workgraph_mark_notification_read: { notification_id: z.string(), expected_version: z.number().int().positive() },
  workgraph_list: { kind: z.enum(["streams", "sources", "work", "decisions", "recaps"]), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_get: { record_type: z.enum(["source", "stream", "outcome", "work_item", "attempt", "decision", "recap", "proposal"]), id: z.string() },
  workgraph_source_revision: { work_source_id: z.string(), revision_id: z.string() },
  workgraph_changes: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), wait_ms: z.number().int().min(0).max(30_000).optional() },
  workgraph_source: { ...operation, action: z.enum(["create", "revise"]), title: z.string().optional(), content: z.string(), work_source_id: z.string().optional(), expected_revision_id: z.string().optional() },
  workgraph_create_stream: { ...operation, title: z.string(), description: z.string().optional(), source: z.object(sourceRef).optional(), execution: ExecutionProfileDefaultsSchema.optional(), recap: RecapProfileDefaultsSchema.optional(), activity_granularity: StreamActivityGranularitySchema.optional() },
  workgraph_create_outcome: { ...operation, stream_id: z.string(), title: z.string(), description: z.string().optional(), success_criteria: z.array(z.string()).min(1), execution: ExecutionProfileDefaultsSchema.optional() },
  workgraph_create_task: { ...operation, stream_id: z.string(), title: z.string(), description: z.string().optional(), outcome_id: z.string().optional(), priority: z.number().int().nonnegative().optional(), dependency_ids: z.array(z.string()).optional(), source: z.object(sourceRef).optional(), completion_contract: CompletionContractSchema, execution: ExecutionProfileDefaultsSchema.optional() },
  workgraph_create_work: { ...operation, kind: z.enum(["outcome", "work_item"]), stream_id: z.string(), title: z.string(), description: z.string().optional(), outcome_id: z.string().optional(), priority: z.number().int().nonnegative().optional(), dependency_ids: z.array(z.string()).optional(), source: z.object(sourceRef).optional(), success_criteria: z.array(z.string()).min(1).optional(), completion_contract: CompletionContractSchema.optional(), execution: ExecutionProfileDefaultsSchema.optional() },
  workgraph_update: { ...operation, target_type: z.enum(["stream", "outcome", "work_item"]), target_id: z.string(), expected_version: z.number().int().positive(), title: z.string().optional(), description: z.string().optional(), success_criteria: z.array(z.string()).min(1).optional(), outcome_id: z.string().nullable().optional(), priority: z.number().int().nonnegative().optional(), dependency_ids: z.array(z.string()).optional(), completion_contract: CompletionContractSchema.optional(), execution: ExecutionProfileDefaultsSchema.optional(), recap: RecapProfileDefaultsSchema.optional(), activity_granularity: StreamActivityGranularitySchema.optional() },
  workgraph_bind_session: { ...operation, stream_id: z.string() },
  workgraph_current_work: {},
  workgraph_select_work: { ...operation, work_item_id: z.string() },
  workgraph_record_progress: { ...operation, level: z.enum(["milestone", "progress", "detail"]), summary: z.string().trim().min(1).max(1_000), evidence_ids: z.array(z.string()).max(100).optional() },
  workgraph_refresh_context: {},
  workgraph_complete_current_work: { ...operation, summary: z.string().trim().min(1).max(10_000), artifacts: z.array(z.string()).max(100).optional(), evidence: z.array(z.strictObject({ requirement_id: z.string().optional(), evidence: EvidenceInputSchema })).min(1).max(100) },
  workgraph_release_session: { ...operation },
  workgraph_propose_admission: { ...operation, source: z.object(sourceRef), target_stream_id: z.string().optional() },
  workgraph_admit: { ...operation, proposal_id: z.string(), expected_version: z.number().int().nonnegative(), source: z.object(sourceRef), disposition: z.enum(["create", "existing", "keep", "replace", "fork"]), stream_id: z.string().optional(), stream_title: z.string().optional(), replace_work_items: ReviewedReplacementWorkItemsSchema.describe("Required for replace. Exact reviewed Work Items and versions that the replacement may abandon.").optional(), outcomes: z.array(AdmissionOutcomeInputSchema).optional(), work_items: z.array(AdmissionWorkItemInputSchema).optional() },
  workgraph_review_proposal: { ...operation, action: z.enum(["retry", "dismiss", "reopen"]), proposal_id: z.string(), expected_version: z.number().int().nonnegative() },
  workgraph_source_views: {},
  workgraph_configure_source_view: { team_connection_id: z.string(), provider: z.enum(["github", "linear", "jira"]), provider_user_id: z.string(), filters: z.record(z.string(), z.string()).optional(), sync_policy: z.enum(["silent", "announce", "full"]).optional() },
  workgraph_update_source_view: { source_view_id: z.string(), expected_version: z.number().int().positive(), provider_user_id: z.string(), filters: z.record(z.string(), z.string()), sync_policy: z.enum(["silent", "announce", "full"]), status: z.enum(["active", "paused"]) },
  workgraph_delete_source_view: { source_view_id: z.string(), expected_version: z.number().int().positive() },
  workgraph_refresh_source_view: { source_view_id: z.string() },
  workgraph_intake: { source_view_id: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_get_candidate: { candidate_id: z.string() },
  workgraph_stage_candidate: { candidate_id: z.string() },
  workgraph_update_candidate: { action: z.enum(["dismiss", "restore"]), candidate_id: z.string(), expected_version: z.number().int().positive() },
  workgraph_sync_candidate: { candidate_id: z.string(), idempotency_key: z.string(), summary: z.string(), status: z.string().optional() },
  workgraph_execute: { ...operation, target_type: z.enum(["stream", "work_item"]), target_id: z.string(), mode: z.enum(["autonomous", "supervised"]) },
  workgraph_update_execution: { ...operation, target_type: z.enum(["stream", "outcome", "work_item"]).optional(), target_id: z.string().optional(), stream_id: z.string().optional(), expected_version: z.number().int().nonnegative(), execution: ExecutionProfileDefaultsSchema, recap: RecapProfileDefaultsSchema.optional() },
  workgraph_retry: { ...operation, work_item_id: z.string(), expected_version: z.number().int().nonnegative() },
  workgraph_cancel_work: { ...operation, work_item_id: z.string(), expected_version: z.number().int().nonnegative(), reason: z.string() },
  workgraph_stream_lifecycle: { ...operation, stream_id: z.string(), expected_version: z.number().int().nonnegative(), state: z.enum(["active", "paused", "closed", "reopened"]), reason: z.string() },
  workgraph_pause: { ...operation, stream_id: z.string(), expected_version: z.number().int().nonnegative(), reason: z.string() },
  workgraph_cancel: { ...operation, attempt_id: z.string(), expected_version: z.number().int().nonnegative(), reason: z.string() },
  workgraph_record_finding: { ...operation, subject: EvidenceSubjectSchema, summary: z.string(), source_ref: z.string().optional(), source_attempt_id: z.string().optional() },
  workgraph_create_followup: { ...operation, stream_id: z.string(), title: z.string(), description: z.string().optional(), outcome_id: z.string().optional(), completion_contract: CompletionContractSchema },
  workgraph_decision: { ...operation, action: z.enum(["propose", "answer", "dismiss"]), decision_id: z.string().optional(), stream_id: z.string().optional(), expected_version: z.number().int().nonnegative().optional(), question: z.string().optional(), options: z.array(DecisionOptionInputSchema).optional(), recommendation_option_id: z.string().optional(), rationale: z.string().optional(), affected_work_item_ids: z.array(z.string()).optional(), answer: z.string().optional(), option_id: z.string().optional(), reason: z.string().optional() },
  workgraph_record_evidence: { ...operation, subject: EvidenceSubjectSchema, requirement_id: z.string().optional(), source_attempt_id: z.string().optional(), evidence: EvidenceInputSchema },
  workgraph_evidence: { action: z.enum(["list", "get"]), subject: EvidenceSubjectSchema.optional(), evidence_id: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_attempts: { work_item_id: z.string(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_activity: { work_item_id: z.string(), granularity: StreamActivityGranularitySchema.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_recap: { action: z.literal("get").optional(), stream_id: z.string().optional(), recap_id: z.string().optional() },
  workgraph_close: { ...operation, target_type: z.enum(["stream", "outcome"]), target_id: z.string(), expected_version: z.number().int().nonnegative(), reason: z.string() },
  workgraph_delete: { ...operation, stream_id: z.string(), expected_version: z.number().int().nonnegative(), reason: z.string() },
} satisfies Record<(typeof WORKGRAPH_CAPABILITY_MAP)[number]["tool"], Record<string, z.ZodType>>

const sessionContextTools = new Set<keyof typeof WORKGRAPH_TOOL_SCHEMAS>([
  "workgraph_bind_session",
  "workgraph_current_work",
  "workgraph_select_work",
  "workgraph_record_progress",
  "workgraph_refresh_context",
  "workgraph_complete_current_work",
  "workgraph_release_session",
])

export function registerWorkGraphTools(
  register: Register,
  transport: WorkGraphTransport,
  readOnly: boolean,
  creationContext?: WorkGraphCreationContextProvider,
) {
  WORKGRAPH_CAPABILITY_MAP
    .filter((capability) => !readOnly || !capability.mutating)
    .filter((capability) => typeof transport === "function" || embeddedSupports(transport, capability.tool))
    .forEach((capability) => register(
      capability.tool,
      { description: `[WorkGraph] ${capability.uiAction}. The server derives the organization and user from trusted request context; results include the same record and change cursor used by the app.`, inputSchema: WORKGRAPH_TOOL_SCHEMAS[capability.tool] },
      async (input) => {
        try {
          const context = (capability.tool === "workgraph_create_stream" || sessionContextTools.has(capability.tool)) && typeof creationContext === "function"
            ? await creationContext()
            : typeof creationContext === "function" ? undefined : creationContext
          const result = await callWorkGraph(transport, capability.tool, input, context)
          return text(result, Boolean(result && typeof result === "object" && "ok" in result && result.ok === false))
        } catch (error) {
          if (error instanceof WorkGraphRecordNotFoundError) {
            return text({
              error: {
                code: error.code,
                status: error.status,
                message: error.message,
                recordType: error.recordType,
                recordId: error.recordId,
              },
            }, true)
          }
          if (error instanceof WorkGraphSessionAttachmentDeniedError) {
            return text({ error: { code: error.code, status: error.status, message: error.message } }, true)
          }
          if (error instanceof McpHttpError) {
            return text({
              error: {
                ...(error.code ? { code: error.code } : {}),
                status: error.status,
                message: "WorkGraph request failed",
                ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
              },
            }, true)
          }
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      },
    ))
}

export async function callWorkGraph(
  transport: WorkGraphTransport,
  tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS,
  input: Record<string, unknown>,
  creationContext?: WorkGraphCreationContext,
) {
  rejectTenantSelectors(input)
  if (sessionContextTools.has(tool)) {
    const session = creationContext?.session
    if (!session) throw new WorkGraphSessionAttachmentDeniedError()
    if (typeof transport === "function") throw new WorkGraphSessionAttachmentDeniedError()
    if (tool === "workgraph_bind_session") {
      return SessionBindingDtoSchema.parse(await requiredMethod(transport.bindSession, tool)({
        operationId: requiredString(input, "operation_id"),
        streamId: requiredString(input, "stream_id"),
        sessionId: session.sessionId,
        projectId: session.projectId,
      }))
    }
    const binding = await requiredMethod(transport.readSessionBinding, tool)(session.sessionId)
    if (!binding) {
      if (tool === "workgraph_current_work" || tool === "workgraph_refresh_context") return { binding: null }
      throw new Error("The current Session is not bound to a WorkGraph Stream")
    }
    const current = SessionBindingDtoSchema.parse(binding)
    if (tool === "workgraph_current_work") return { binding: current }
    if (tool === "workgraph_select_work") {
      if (!session.resolvedExecution) throw new Error("The current Session execution profile is incomplete")
      return SessionBindingDtoSchema.parse(await requiredMethod(transport.attachSessionTask, tool)({
        operationId: requiredString(input, "operation_id"),
        bindingId: current.id,
        expectedVersion: current.version,
        workItemId: requiredString(input, "work_item_id"),
        resolvedExecution: session.resolvedExecution,
      }))
    }
    if (tool === "workgraph_record_progress") {
      return requiredMethod(transport.recordSessionCheckpoint, tool)({
        operationId: requiredString(input, "operation_id"),
        bindingId: current.id,
        level: requiredString(input, "level"),
        summary: requiredString(input, "summary"),
        evidenceIds: input.evidence_ids ?? [],
      })
    }
    if (tool === "workgraph_refresh_context") {
      return {
        binding: current,
        ...(current.currentWorkItemId
          ? { workItem: await requiredMethod(transport.readWorkItem, tool)(current.currentWorkItemId) }
          : {}),
        ...(current.currentAttemptId
          ? { attempt: await requiredMethod(transport.readAttempt, tool)(current.currentAttemptId) }
          : {}),
      }
    }
    if (tool === "workgraph_complete_current_work") {
      if (!current.currentAttemptId || !current.currentWorkItemId) {
        throw new Error("The current Session has no active WorkGraph Task")
      }
      const request = WorkGraphCommandRequestSchema.parse({
        operationId: requiredString(input, "operation_id"),
        command: {
          version: 1,
          type: "complete_attempt",
          attemptId: current.currentAttemptId,
          sessionId: session.sessionId,
          workspaceId: session.projectId,
          summary: requiredString(input, "summary"),
          artifacts: input.artifacts ?? [],
          evidence: (input.evidence as Array<Record<string, unknown>>).map((entry) => ({
            ...(typeof entry.requirement_id === "string" ? { requirementId: entry.requirement_id } : {}),
            evidence: entry.evidence,
          })),
        },
      })
      return CommandResultSchema.parse(await transport.execute(request))
    }
    return SessionBindingDtoSchema.parse(await requiredMethod(transport.releaseSessionBinding, tool)({
      operationId: requiredString(input, "operation_id"),
      bindingId: current.id,
      expectedVersion: current.version,
    }))
  }
  if (tool === "workgraph_get_defaults") {
    if (typeof transport !== "function") return requiredMethod(transport.readDefaults, tool)()
    return transport("/api/workgraph/defaults", { method: "GET" })
  }
  if (tool === "workgraph_execution_capabilities" || tool === "workgraph_refresh_execution_capabilities") {
    const refresh = tool === "workgraph_refresh_execution_capabilities"
    const value = typeof transport !== "function"
      ? await requiredMethod(refresh ? transport.refreshExecutionCapabilities : transport.readExecutionCapabilities, tool)()
      : await transport(`/api/workgraph/execution-capabilities${refresh ? "/refresh" : ""}`, { method: refresh ? "POST" : "GET", ...(refresh ? { body: "{}" } : {}) })
    return ExecutionCapabilitiesSchema.parse(value)
  }
  if (tool === "workgraph_attention") {
    const query = pageQuery(input, 50)
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listAttention, tool)({
        ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
        limit: typeof input.limit === "number" ? input.limit : 50,
      })
      : await transport(`/api/workgraph/attention?${query}`, { method: "GET" })
    return AttentionPageSchema.parse(value)
  }
  if (tool === "workgraph_notifications") {
    const query = pageQuery(input, 50)
    if (typeof input.state === "string") query.set("state", input.state)
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listNotifications, tool)({
        ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
        limit: typeof input.limit === "number" ? input.limit : 50,
        ...(input.state === "read" || input.state === "unread" ? { state: input.state } : {}),
      })
      : await transport(`/api/workgraph/notifications?${query}`, { method: "GET" })
    return WorkGraphNotificationPageSchema.parse(value)
  }
  if (tool === "workgraph_mark_notification_read") {
    const id = requiredString(input, "notification_id")
    const expectedVersion = requiredNumber(input, "expected_version")
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.markNotificationRead, tool)(id, expectedVersion)
      : await transport(`/api/workgraph/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion }),
      })
    return WorkGraphNotificationSchema.parse(value)
  }
  if (tool === "workgraph_changes") {
    if (typeof transport !== "function") throw new Error("Embedded WorkGraph transport does not expose the ordered change feed")
    const query = pageQuery(input, 50)
    if (typeof input.wait_ms === "number") query.set("waitMs", String(input.wait_ms))
    return ChangesResponseSchema.parse(await transport(`/api/workgraph/changes?${query}`, { method: "GET" }))
  }
  if (tool === "workgraph_source_revision") {
    const workSourceId = requiredString(input, "work_source_id")
    const revisionId = requiredString(input, "revision_id")
    const value = await (typeof transport !== "function"
      ? requiredMethod(transport.readSourceRevision, tool)(workSourceId, revisionId)
      : transport(`/api/workgraph/sources/${encodeURIComponent(workSourceId)}/revisions/${encodeURIComponent(revisionId)}`, { method: "GET" }))
      .catch((error) => readError(error, "source_revision", revisionId))
    if (value === undefined || value === null) throw new WorkGraphRecordNotFoundError("source_revision", revisionId)
    return WorkSourceRevisionDtoSchema.parse(value)
  }
  if (tool === "workgraph_source_views") {
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listSourceViews, tool)()
      : await transport("/api/workgraph/source-views", { method: "GET" })
    return SourceViewListResponseSchema.parse(value)
  }
  if (tool === "workgraph_configure_source_view") {
    const value = {
      teamConnectionId: requiredString(input, "team_connection_id"),
      provider: requiredString(input, "provider"),
      providerUserId: requiredString(input, "provider_user_id"),
      filters: input.filters ?? {},
      syncPolicy: input.sync_policy ?? "silent",
    }
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.createSourceView, tool)(value)
      : await transport("/api/workgraph/source-views", { method: "POST", body: JSON.stringify(value) })
    return SourceViewDtoSchema.parse(result)
  }
  if (tool === "workgraph_update_source_view") {
    const id = requiredString(input, "source_view_id")
    const value = {
      expectedVersion: requiredNumber(input, "expected_version"),
      providerUserId: requiredString(input, "provider_user_id"),
      filters: input.filters,
      syncPolicy: requiredString(input, "sync_policy"),
      status: requiredString(input, "status"),
    }
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.updateSourceView, tool)(id, value)
      : await transport(`/api/workgraph/source-views/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(value) })
    return SourceViewDtoSchema.parse(result)
  }
  if (tool === "workgraph_delete_source_view") {
    const id = requiredString(input, "source_view_id")
    const expectedVersion = requiredNumber(input, "expected_version")
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.deleteSourceView, tool)(id, expectedVersion)
      : await transport(`/api/workgraph/source-views/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ expectedVersion }) })
    return SourceViewDtoSchema.parse(result)
  }
  if (tool === "workgraph_refresh_source_view") {
    const id = requiredString(input, "source_view_id")
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.refreshSourceView, tool)(id)
      : await transport(`/api/workgraph/source-views/${encodeURIComponent(id)}/refresh`, { method: "POST", body: "{}" })
    return SourceViewRefreshResponseSchema.parse(result)
  }
  if (tool === "workgraph_intake") {
    const query = pageQuery(input, 50)
    if (typeof input.source_view_id === "string") query.set("sourceViewId", input.source_view_id)
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.listIntake, tool)({
        ...(typeof input.source_view_id === "string" ? { sourceViewId: input.source_view_id } : {}),
        ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
        limit: typeof input.limit === "number" ? input.limit : 50,
      })
      : await transport(`/api/workgraph/intake?${query}`, { method: "GET" })
    return IntakeCandidatePageSchema.parse(result)
  }
  if (tool === "workgraph_get_candidate") {
    const id = requiredString(input, "candidate_id")
    const value = await (typeof transport !== "function"
      ? requiredMethod(transport.readCandidate, tool)(id)
      : transport(`/api/workgraph/intake/${encodeURIComponent(id)}`, { method: "GET" }))
      .catch((error) => readError(error, "candidate", id))
    if (value === undefined || value === null) throw new WorkGraphRecordNotFoundError("candidate", id)
    return IntakeCandidateDtoSchema.parse(value)
  }
  if (tool === "workgraph_stage_candidate") {
    const id = requiredString(input, "candidate_id")
    const result = typeof transport !== "function"
      ? await requiredMethod(transport.stageCandidate, tool)(id)
      : await transport(`/api/workgraph/intake/${encodeURIComponent(id)}/stage`, { method: "POST", body: "{}" })
    return IntakeCandidateDtoSchema.parse(result)
  }
  if (tool === "workgraph_update_candidate") {
    const id = requiredString(input, "candidate_id")
    const expectedVersion = requiredNumber(input, "expected_version")
    const action = requiredString(input, "action")
    const result = typeof transport !== "function"
      ? await requiredMethod(action === "dismiss" ? transport.dismissCandidate : transport.restoreCandidate, tool)(id, expectedVersion)
      : await transport(`/api/workgraph/intake/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({ expectedVersion }) })
    return IntakeCandidateDtoSchema.parse(result)
  }
  if (tool === "workgraph_sync_candidate") {
    const id = requiredString(input, "candidate_id")
    const value = { idempotencyKey: requiredString(input, "idempotency_key"), summary: requiredString(input, "summary"), ...(typeof input.status === "string" ? { status: input.status } : {}) }
    if (typeof transport !== "function") return requiredMethod(transport.syncCandidate, tool)(id, value)
    return transport(`/api/workgraph/intake/${encodeURIComponent(id)}/sync`, { method: "POST", body: JSON.stringify(value) })
  }
  if (tool === "workgraph_list") {
    if (input.kind === "sources") {
      if (typeof transport !== "function") {
        if (!transport.listSources) throw new Error("Embedded WorkGraph transport does not expose Work Sources")
        return transport.listSources({
          ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
          limit: typeof input.limit === "number" ? input.limit : 50,
        })
      }
      const query = new URLSearchParams()
      if (typeof input.cursor === "string") query.set("after", input.cursor)
      if (typeof input.limit === "number") query.set("limit", String(input.limit))
      return transport(`/api/workgraph/sources${query.size ? `?${query}` : ""}`, { method: "GET" })
    }
    if (input.cursor !== undefined || input.limit !== undefined) {
      throw new Error("cursor and limit apply only to Work Source pages; use workgraph_changes for incremental WorkGraph observation")
    }
    const snapshot = await readSnapshot(transport, 100)
    const records = snapshot.records.filter((record) => listIncludes(requiredString(input, "kind"), record.recordType))
    const identities = new Set(records.map((record) => `${record.recordType}:${record.id}`))
    return {
      ...snapshot,
      records,
      references: snapshot.references.filter((reference) => identities.has(`${reference.resource.type}:${reference.resource.id}`)),
    }
  }
  if (tool === "workgraph_attempts") {
    const id = requiredString(input, "work_item_id")
    const query = pageQuery(input, 50)
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listWorkItemAttempts, tool)(id, {
        ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
        limit: typeof input.limit === "number" ? input.limit : 50,
      })
      : await transport(`/api/workgraph/work-items/${encodeURIComponent(id)}/attempts?${query}`, { method: "GET" })
    return WorkItemAttemptPageSchema.parse(value)
  }
  if (tool === "workgraph_activity") {
    const id = requiredString(input, "work_item_id")
    const granularity = typeof input.granularity === "string" ? input.granularity as "milestones" | "progress" | "detailed" : "progress"
    const query = pageQuery(input, 50)
    query.set("granularity", granularity)
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listWorkItemActivity, tool)(id, {
          granularity,
          ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
          limit: typeof input.limit === "number" ? input.limit : 50,
        })
      : await transport(`/api/workgraph/work-items/${encodeURIComponent(id)}/activity?${query}`, { method: "GET" })
    return TaskActivityPageSchema.parse(value)
  }
  if (tool === "workgraph_evidence") {
    const action = requiredString(input, "action")
    if (action === "get") {
      const id = requiredString(input, "evidence_id")
      const value = await (typeof transport !== "function"
        ? requiredMethod(transport.readEvidence, tool)(id)
        : transport(`/api/workgraph/evidence/${encodeURIComponent(id)}`, { method: "GET" }))
        .catch((error) => readError(error, "evidence", id))
      if (value === undefined || value === null) throw new WorkGraphRecordNotFoundError("evidence", id)
      return EvidenceDtoSchema.parse(value)
    }
    const subject = EvidenceSubjectSchema.parse(input.subject)
    const query = pageQuery(input, 50)
    query.set("subjectType", subject.type)
    if (subject.type === "stream") query.set("streamId", subject.streamId)
    if (subject.type === "outcome") query.set("outcomeId", subject.outcomeId)
    if (subject.type === "work_item") query.set("workItemId", subject.workItemId)
    const value = typeof transport !== "function"
      ? await requiredMethod(transport.listEvidence, tool)({
        subject,
        ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
        limit: typeof input.limit === "number" ? input.limit : 50,
      })
      : await transport(`/api/workgraph/evidence?${query}`, { method: "GET" })
    return EvidencePageSchema.parse(value)
  }
  if (tool === "workgraph_get" && input.record_type === "stream") {
    const streamId = requiredString(input, "id")
    const stream = await (typeof transport !== "function"
      ? transport.readStream(streamId)
      : transport(`/api/workgraph/streams/${encodeURIComponent(streamId)}`, { method: "GET" }))
      .catch((error) => readError(error, "stream", streamId))
    if (stream === undefined || stream === null) throw new WorkGraphRecordNotFoundError("stream", streamId)
    return StreamDtoSchema.parse(stream)
  }
  if (tool === "workgraph_get" && input.record_type === "source") {
    const workSourceId = requiredString(input, "id")
    let source: unknown
    if (typeof transport !== "function") {
      if (!transport.readSource) throw new Error("Embedded WorkGraph transport does not expose Work Sources")
      source = await transport.readSource(workSourceId).catch((error) => readError(error, "source", workSourceId))
    } else {
      source = await transport(`/api/workgraph/sources/${encodeURIComponent(workSourceId)}`, { method: "GET" })
        .catch((error) => readError(error, "source", workSourceId))
    }
    if (source === undefined || source === null) throw new WorkGraphRecordNotFoundError("source", workSourceId)
    return WorkSourceDtoSchema.parse(source)
  }
  if (tool === "workgraph_get" && ["proposal", "work_item", "attempt", "decision", "recap"].includes(String(input.record_type))) {
    const type = requiredString(input, "record_type")
    const id = requiredString(input, "id")
    return readDetail(transport, type, id)
  }
  if (tool === "workgraph_recap" && typeof input.recap_id === "string") {
    return readDetail(transport, "recap", input.recap_id)
  }
  if (tool === "workgraph_get" || tool === "workgraph_recap") {
    const snapshot = await readSnapshot(transport, 100)
    const record = tool === "workgraph_recap"
      ? requestedRecap(snapshot.records, requiredString(input, "stream_id"), typeof input.recap_id === "string" ? input.recap_id : undefined)
      : requestedRecord(snapshot.records, requiredString(input, "record_type"), requiredString(input, "id"))
    return record
  }
  const command = WorkGraphCommandRequestSchema.parse(toCommandRequest(tool, input, creationContext))
  const result = typeof transport !== "function"
    ? await transport.execute(command)
    : await transport("/api/workgraph/commands", {
    method: "POST",
    body: JSON.stringify(command),
  })
  return CommandResultSchema.parse(result)
}

function readError(error: unknown, recordType: string, recordId: string): never {
  if (error && typeof error === "object" && "status" in error && error.status === 404 &&
    (!("code" in error) || error.code === undefined || error.code === "not_found")) {
    throw new WorkGraphRecordNotFoundError(recordType, recordId)
  }
  throw error
}

function requestedRecord(records: Awaited<ReturnType<typeof readSnapshot>>["records"], type: string, id: string) {
  const recordType = type === "proposal" ? "admission_proposal" : type
  const record = records.find((value) => value.recordType === recordType && value.id === id)
  if (record) return record
  throw new WorkGraphRecordNotFoundError(type, id)
}

function listIncludes(kind: string, recordType: string) {
  if (kind === "streams") return recordType === "stream"
  if (kind === "work") return recordType === "outcome" || recordType === "work_item" || recordType === "attempt"
  if (kind === "decisions") return recordType === "decision"
  if (kind === "recaps") return recordType === "recap"
  return false
}

function requestedRecap(records: Awaited<ReturnType<typeof readSnapshot>>["records"], streamId: string, recapId?: string) {
  const recaps = records.filter((record): record is Extract<(typeof records)[number], { recordType: "recap" }> =>
    record.recordType === "recap" && record.streamId === streamId)
  const recap = recapId
    ? recaps.find((record) => record.id === recapId)
    : recaps
      .filter((record) => record.generation.state === "succeeded")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]
  if (recap) return recap
  throw new WorkGraphRecordNotFoundError("recap", recapId ?? streamId)
}

async function readDetail(transport: WorkGraphTransport, type: string, id: string) {
  if (type === "proposal") {
    const value = await directRead(transport, transportMethod(transport, "readProposal"), `/api/workgraph/proposals/${encodeURIComponent(id)}`, "proposal", id)
    return AdmissionProposalDtoSchema.parse(value)
  }
  if (type === "work_item") {
    const value = await directRead(transport, transportMethod(transport, "readWorkItem"), `/api/workgraph/work-items/${encodeURIComponent(id)}`, "work_item", id)
    return WorkItemDtoSchema.parse(value)
  }
  if (type === "attempt") {
    const value = await directRead(transport, transportMethod(transport, "readAttempt"), `/api/workgraph/attempts/${encodeURIComponent(id)}`, "attempt", id)
    return AttemptDetailDtoSchema.parse(value)
  }
  if (type === "decision") {
    const value = await directRead(transport, transportMethod(transport, "readDecision"), `/api/workgraph/decisions/${encodeURIComponent(id)}`, "decision", id)
    return DecisionDtoSchema.parse(value)
  }
  if (type === "recap") {
    const value = await directRead(transport, transportMethod(transport, "readRecap"), `/api/workgraph/recaps/${encodeURIComponent(id)}`, "recap", id)
    return RecapDtoSchema.parse(value)
  }
  throw new Error(`WorkGraph detail type '${type}' is not supported`)
}

function transportMethod(
  transport: WorkGraphTransport,
  method: "readProposal" | "readWorkItem" | "readAttempt" | "readDecision" | "readRecap",
) {
  if (typeof transport === "function") return undefined
  return transport[method]
}

async function directRead(
  transport: WorkGraphTransport,
  method: ((id: string) => Promise<unknown>) | undefined,
  path: string,
  recordType: string,
  recordId: string,
) {
  const value = await (typeof transport === "function"
    ? transport(path, { method: "GET" })
    : requiredMethod(method, `read ${recordType}`)(recordId))
    .catch((error) => readError(error, recordType, recordId))
  if (value === undefined || value === null) throw new WorkGraphRecordNotFoundError(recordType, recordId)
  return value
}

function readSnapshot(transport: WorkGraphTransport, limit: number) {
  return collectWorkGraphSnapshotPages({
    page: async (after) => {
      const value = typeof transport === "function"
        ? await transport(`/api/workgraph/snapshot?${snapshotQuery(limit, after)}`, { method: "GET" })
        : await transport.snapshot({ ...(after ? { after } : {}), limit })
      return WorkGraphSnapshotPageSchema.parse(value)
    },
    isCursorInvalid: (error) => {
      if (error instanceof Error && error.message.includes("cursor_invalid")) return true
      if (!error || typeof error !== "object") return false
      if ("code" in error && error.code === "cursor_invalid") return true
      return "kind" in error && error.kind === "cursor_invalid"
    },
  })
}

function snapshotQuery(limit: number, after?: SnapshotResumeCursor) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (after) query.set("after", after)
  return query
}

function pageQuery(input: Record<string, unknown>, defaultLimit: number) {
  const query = new URLSearchParams({ limit: String(typeof input.limit === "number" ? input.limit : defaultLimit) })
  if (typeof input.cursor === "string") query.set("after", input.cursor)
  return query
}

function rejectTenantSelectors(input: Record<string, unknown>) {
  const selector = Object.keys(input).find((key) => [
    "owner",
    "ownerid",
    "owneruserid",
    "ownersubject",
    "organization",
    "organizationid",
    "org",
    "orgid",
    "tenant",
    "tenantid",
    "user",
    "userid",
  ].includes(key.replace(/[^a-z0-9]/gi, "").toLowerCase()))
  if (selector) throw new Error(`WorkGraph tenant selector '${selector}' is not accepted; organization and user come from trusted request context`)
}

function requiredMethod<Method>(method: Method | undefined, tool: string): NonNullable<Method> {
  if (!method) throw new Error(`Embedded WorkGraph transport does not expose ${tool}`)
  return method as NonNullable<Method>
}

function embeddedSupports(transport: EmbeddedWorkGraphTransport, tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS) {
  const methods: Partial<Record<keyof typeof WORKGRAPH_TOOL_SCHEMAS, keyof EmbeddedWorkGraphTransport>> = {
    workgraph_get_defaults: "readDefaults",
    workgraph_execution_capabilities: "readExecutionCapabilities",
    workgraph_refresh_execution_capabilities: "refreshExecutionCapabilities",
    workgraph_attention: "listAttention",
    workgraph_notifications: "listNotifications",
    workgraph_mark_notification_read: "markNotificationRead",
    workgraph_source_revision: "readSourceRevision",
    workgraph_changes: undefined,
    workgraph_source_views: "listSourceViews",
    workgraph_configure_source_view: "createSourceView",
    workgraph_update_source_view: "updateSourceView",
    workgraph_delete_source_view: "deleteSourceView",
    workgraph_refresh_source_view: "refreshSourceView",
    workgraph_intake: "listIntake",
    workgraph_get_candidate: "readCandidate",
    workgraph_stage_candidate: "stageCandidate",
    workgraph_update_candidate: "dismissCandidate",
    workgraph_sync_candidate: "syncCandidate",
    workgraph_attempts: "listWorkItemAttempts",
    workgraph_activity: "listWorkItemActivity",
    workgraph_evidence: "listEvidence",
    workgraph_recap: "readRecap",
    workgraph_bind_session: "bindSession",
    workgraph_current_work: "readSessionBinding",
    workgraph_select_work: "attachSessionTask",
    workgraph_record_progress: "recordSessionCheckpoint",
    workgraph_refresh_context: "readSessionBinding",
    workgraph_complete_current_work: "readSessionBinding",
    workgraph_release_session: "releaseSessionBinding",
  }
  const method = methods[tool]
  if (tool === "workgraph_changes") return false
  if (tool === "workgraph_update_candidate") {
    return typeof transport.dismissCandidate === "function" && typeof transport.restoreCandidate === "function"
  }
  if (tool === "workgraph_evidence") {
    return typeof transport.listEvidence === "function" && typeof transport.readEvidence === "function"
  }
  if (tool === "workgraph_get") {
    return [
      transport.snapshot,
      transport.readStream,
      transport.readSource,
      transport.readProposal,
      transport.readWorkItem,
      transport.readAttempt,
      transport.readDecision,
      transport.readRecap,
    ].every((value) => typeof value === "function")
  }
  return !method || typeof transport[method] === "function"
}

export function toCommandRequest(
  tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS,
  input: Record<string, unknown>,
  creationContext?: WorkGraphCreationContext,
) {
  const operationId = requiredString(input, "operation_id")
  if (tool === "workgraph_update_defaults") return command(operationId, {
    type: "update_workgraph_defaults",
    expectedVersion: input.expected_version,
    defaults: input.defaults,
  })
  if (tool === "workgraph_source") {
    const action = requiredString(input, "action")
    return command(operationId, action === "create" ? {
      type: "create_work_source",
      title: requiredString(input, "title"),
      content: requiredString(input, "content"),
    } : {
      type: "revise_work_source",
      workSourceId: requiredString(input, "work_source_id"),
      expectedRevisionId: requiredString(input, "expected_revision_id"),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      content: requiredString(input, "content"),
    })
  }
  if (tool === "workgraph_create_stream") return command(operationId, {
    type: "create_stream",
    title: requiredString(input, "title"),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(input.source ? { source: camelSource(input.source) } : {}),
    ...(input.execution ? { execution: input.execution } : creationContext?.execution ? { execution: creationContext.execution } : {}),
    ...(input.recap ? { recap: input.recap } : {}),
    ...(typeof input.activity_granularity === "string" ? { activityGranularity: input.activity_granularity } : {}),
  })
  if (tool === "workgraph_create_outcome" || tool === "workgraph_create_task" || tool === "workgraph_create_work" || tool === "workgraph_create_followup") {
    const kind = tool === "workgraph_create_outcome"
      ? "outcome"
      : tool === "workgraph_create_task" || tool === "workgraph_create_followup"
        ? "work_item"
        : requiredString(input, "kind")
    if (kind === "outcome") return command(operationId, {
      type: "create_outcome",
      streamId: requiredString(input, "stream_id"),
      title: requiredString(input, "title"),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      successCriteria: input.success_criteria,
      ...(input.execution ? { execution: input.execution } : {}),
    })
    return command(operationId, {
      type: "create_work_item",
      streamId: requiredString(input, "stream_id"),
      ...(typeof input.outcome_id === "string" ? { outcomeId: input.outcome_id } : {}),
      title: requiredString(input, "title"),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(typeof input.priority === "number" ? { priority: input.priority } : {}),
      ...(input.dependency_ids ? { dependencyIds: input.dependency_ids } : {}),
      ...(input.source ? { source: camelSource(input.source) } : {}),
      completionContract: input.completion_contract,
      ...(input.execution ? { execution: input.execution } : {}),
    })
  }
  if (tool === "workgraph_update") {
    const type = requiredString(input, "target_type")
    const id = requiredString(input, "target_id")
    const common = {
      expectedVersion: input.expected_version,
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
    }
    if (type === "stream") return command(operationId, {
      type: "update_stream",
      streamId: id,
      ...common,
      ...(input.recap ? { recap: input.recap } : {}),
      ...(typeof input.activity_granularity === "string" ? { activityGranularity: input.activity_granularity } : {}),
    })
    if (type === "outcome") return command(operationId, {
      type: "update_outcome",
      outcomeId: id,
      ...common,
      ...(input.success_criteria ? { successCriteria: input.success_criteria } : {}),
    })
    return command(operationId, {
      type: "update_work_item",
      workItemId: id,
      ...common,
      ...(Object.hasOwn(input, "outcome_id") ? { outcomeId: input.outcome_id } : {}),
      ...(typeof input.priority === "number" ? { priority: input.priority } : {}),
      ...(input.dependency_ids ? { dependencyIds: input.dependency_ids } : {}),
      ...(input.completion_contract ? { completionContract: input.completion_contract } : {}),
    })
  }
  if (tool === "workgraph_propose_admission") return command(operationId, {
    type: "propose_admission",
    source: camelSource(input.source),
    ...(typeof input.target_stream_id === "string" ? { targetStreamId: input.target_stream_id } : {}),
  })
  if (tool === "workgraph_admit") return command(operationId, {
    type: "confirm_admission",
    proposalId: requiredString(input, "proposal_id"),
    expectedVersion: input.expected_version,
    source: camelSource(input.source),
    selection: admissionSelection(input),
    ...(input.outcomes ? { outcomes: input.outcomes } : {}),
    ...(input.work_items ? { workItems: input.work_items } : {}),
  })
  if (tool === "workgraph_review_proposal") return command(operationId, {
    type: `${requiredString(input, "action") === "retry" ? "retry_admission_planning" : `${requiredString(input, "action")}_admission`}`,
    proposalId: requiredString(input, "proposal_id"),
    expectedVersion: input.expected_version,
  })
  if (tool === "workgraph_execute") return command(operationId, input.target_type === "stream" ? {
    type: "execute_stream",
    streamId: requiredString(input, "target_id"),
    executionMode: input.mode,
  } : {
    type: "execute_work_item",
    workItemId: requiredString(input, "target_id"),
    executionMode: input.mode,
  })
  if (tool === "workgraph_update_execution") {
    const type = typeof input.target_type === "string" ? input.target_type : "stream"
    const id = typeof input.target_id === "string" ? input.target_id : requiredString(input, "stream_id")
    if (type === "outcome") return command(operationId, {
      type: "update_outcome",
      outcomeId: id,
      expectedVersion: input.expected_version,
      execution: input.execution,
    })
    if (type === "work_item") return command(operationId, {
      type: "update_work_item",
      workItemId: id,
      expectedVersion: input.expected_version,
      execution: input.execution,
    })
    return command(operationId, {
      type: "update_stream",
      streamId: id,
      expectedVersion: input.expected_version,
      execution: input.execution,
      ...(input.recap ? { recap: input.recap } : {}),
    })
  }
  if (tool === "workgraph_retry") return command(operationId, {
    type: "retry_work_item",
    workItemId: requiredString(input, "work_item_id"),
    expectedVersion: input.expected_version,
  })
  if (tool === "workgraph_cancel_work") return command(operationId, {
    type: "cancel_work_item",
    workItemId: requiredString(input, "work_item_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_stream_lifecycle") return command(operationId, {
    type: "set_stream_lifecycle",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    state: requiredString(input, "state"),
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_pause") return command(operationId, {
    type: "set_stream_lifecycle",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    state: "paused",
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_cancel") return command(operationId, {
    type: "cancel_attempt",
    attemptId: requiredString(input, "attempt_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_record_finding" || tool === "workgraph_record_evidence") return command(operationId, {
    type: "record_evidence",
    subject: input.subject,
    ...(typeof input.requirement_id === "string" ? { requirementId: input.requirement_id } : {}),
    ...(typeof input.source_attempt_id === "string" ? { sourceAttemptId: input.source_attempt_id } : {}),
    evidence: tool === "workgraph_record_finding"
      ? { kind: "finding", summary: requiredString(input, "summary"), ...(typeof input.source_ref === "string" ? { sourceRef: input.source_ref } : {}) }
      : input.evidence,
  })
  if (tool === "workgraph_decision") return decisionCommand(operationId, input)
  if (tool === "workgraph_close") return command(operationId, input.target_type === "stream" ? {
    type: "close_stream",
    streamId: requiredString(input, "target_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  } : {
    type: "close_outcome",
    outcomeId: requiredString(input, "target_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_delete") return command(operationId, {
    type: "delete_stream",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  throw new Error(`WorkGraph tool '${tool}' is not a mutation`)
}

function command(operationId: string, value: Readonly<Record<string, unknown>>) {
  return { operationId, command: { version: 1, ...value } }
}

function camelSource(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("source is required")
  const source = value as Record<string, unknown>
  return { workSourceId: requiredString(source, "work_source_id"), revisionId: requiredString(source, "revision_id"), contentHash: requiredString(source, "content_hash") }
}

function admissionSelection(input: Record<string, unknown>) {
  const mode = requiredString(input, "disposition")
  if (mode !== "replace" && input.replace_work_items !== undefined) {
    throw new Error("replace_work_items is only valid for replace admission")
  }
  if (mode === "create") return { mode, streamTitle: requiredString(input, "stream_title") }
  if (mode === "fork") return { mode, streamId: requiredString(input, "stream_id"), streamTitle: requiredString(input, "stream_title") }
  if (mode === "replace") return {
    mode,
    streamId: requiredString(input, "stream_id"),
    workItems: ReviewedReplacementWorkItemsSchema.parse(input.replace_work_items).map((item) => ({
      workItemId: item.work_item_id,
      expectedVersion: item.expected_version,
    })),
  }
  return { mode, streamId: requiredString(input, "stream_id") }
}

function decisionCommand(operationId: string, input: Record<string, unknown>) {
  const action = requiredString(input, "action")
  if (action === "propose") return command(operationId, {
    type: "propose_decision",
    streamId: requiredString(input, "stream_id"),
    question: requiredString(input, "question"),
    options: input.options,
    ...(typeof input.recommendation_option_id === "string" ? { recommendationOptionId: input.recommendation_option_id } : {}),
    ...(typeof input.rationale === "string" ? { rationale: input.rationale } : {}),
    affectedWorkItemIds: input.affected_work_item_ids,
  })
  if (action === "answer") return command(operationId, {
    type: "answer_decision",
    decisionId: requiredString(input, "decision_id"),
    expectedVersion: input.expected_version,
    ...(typeof input.option_id === "string" ? { optionId: input.option_id } : {}),
    ...(typeof input.answer === "string" ? { answer: input.answer } : {}),
  })
  return command(operationId, {
    type: "dismiss_decision",
    decisionId: requiredString(input, "decision_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
}

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`)
  return value
}

function requiredNumber(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${key} is required`)
  return value
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }
}
