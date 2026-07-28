import {
  CommandResultSchema,
  CommandErrorCodeSchema,
  AttentionCursorSchema,
  AttentionAcknowledgementSchema,
  AttentionPageSchema,
  CompletionContractSchema,
  EvidenceInputSchema,
  EvidenceDtoSchema,
  EvidencePageSchema,
  EvidenceSubjectSchema,
  AdmissionProposalDtoSchema,
  RunDetailDtoSchema,
  DecisionDtoSchema,
  ReplacementReviewSchema,
  WorkItemRunPageCursorSchema,
  WorkItemRunPageSchema,
  TaskActivityPageCursorSchema,
  TaskActivityPageSchema,
  StreamActivityGranularitySchema,
  WorkItemDtoSchema,
  AdmissionSelectionSchema,
  AdmissionOutcomeInputSchema,
  AdmissionWorkItemInputSchema,
  WorkSourceRevisionRefSchema,
  WorkSourceDtoSchema,
  WorkSourceRevisionDtoSchema,
  StreamDtoSchema,
  WorkGraphCommandRequestSchema,
  WorkGraphDefaultsDtoSchema,
  WorkGraphDefaultsSchema,
  ExecutionCapabilitiesSchema,
  ExecutionCapabilitiesErrorSchema,
  ExecutionProfileDefaultsSchema,
  WorkGraphSnapshotPageSchema,
  WorkGraphSnapshotAggregationError,
  collectWorkGraphSnapshotPages,
  type AttentionCursor,
  type CommandResult,
  type EvidencePageCursor,
  type WorkItemRunPageCursor,
  type TaskActivityPageCursor,
  type StreamActivityGranularity,
  type StreamDto,
  type WorkGraphDefaultsDto,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  type ExecutionCapabilityUnavailableReason,
  type ReplacementReview,
  type WorkSourceRevisionRef,
  type SnapshotResumeCursor,
  type IntakeCandidatePageCursor,
  type ResolvedExecutionProfile,
  CreateSourceViewInputSchema,
  IntakeCandidateDtoSchema,
  IntakeCandidatePageCursorSchema,
  IntakeCandidatePageSchema,
  SourceViewDtoSchema,
  SourceViewListResponseSchema,
  SourceViewRefreshResponseSchema,
  UpdateSourceViewInputSchema,
} from "@claxedo/workgraph/contracts"
import z from "zod"
import { bypassFetchThrottle } from "@/lib/fetch-throttle"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { centralTransportForServer, unsignedLocalFetch } from "@/platform/runtime/transport"

const WorkSourcesResponseSchema = z.strictObject({
  sources: z.array(WorkSourceDtoSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).max(512).optional(),
})

export type WorkGraphSessionReference = {
  sessionId: string
  workspaceId?: string
  harness?: ResolvedExecutionProfile["harness"]
  environment?: ResolvedExecutionProfile["environment"]
}

export type WorkGraphSessionOpener = (
  reference: WorkGraphSessionReference,
) => void | Promise<void>

const WorkGraphApiErrorCodeSchema = z.union([
  CommandErrorCodeSchema,
  z.literal("unauthorized"),
  z.literal("cursor_invalid"),
])

const WorkGraphApiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: WorkGraphApiErrorCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  }),
})

type WorkGraphApiErrorCode = z.infer<typeof WorkGraphApiErrorCodeSchema>
type ApiErrorCode = WorkGraphApiErrorCode | z.infer<typeof ExecutionCapabilitiesErrorSchema>["error"]["code"]
type ApiErrorKind = ApiErrorCode | "conflict" | "offline" | "invalid_response" | "request_failed"

export class WorkGraphApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: ApiErrorCode,
    readonly retryable?: boolean,
    readonly capability?: ExecutionCapabilityName,
    readonly reason?: ExecutionCapabilityUnavailableReason,
  ) {
    super(message)
    this.name = "WorkGraphApiError"
  }
}

export function decodeWorkGraphSnapshot(value: unknown) {
  return WorkGraphSnapshotPageSchema.parse(value)
}

export function createWorkGraphClient(input: { baseUrl?: string; request?: typeof fetch; operationId?: () => string } = {}) {
  const baseUrl = (input.baseUrl ?? getClaxedoServerUrl()).replace(/\/$/, "")
  const request = input.request ?? (
    centralTransportForServer(baseUrl) === "loopback" ? unsignedLocalFetch : globalThis.fetch
  )
  const url = (path: string) => `${baseUrl}/api/workgraph${path}`

  const read = async <T>(path: string, parse: (value: unknown) => T, init?: RequestInit, decodeError?: ApiErrorDecoder) => {
    const response = await request(url(path), init).catch((error) => {
      throw new WorkGraphApiError("offline", error instanceof Error ? error.message : "WorkGraph is offline")
    })
    if (!response.ok) throw await apiError(response, undefined, decodeError)
    const value = await response.json().catch(() => {
      throw new WorkGraphApiError("invalid_response", "WorkGraph returned invalid JSON", response.status)
    })
    try {
      return parse(value)
    } catch (error) {
      throw new WorkGraphApiError("invalid_response", error instanceof Error ? error.message : "Invalid WorkGraph response", response.status)
    }
  }

  const command = async (body: z.input<typeof WorkGraphCommandRequestSchema>): Promise<CommandResult> => {
    const response = await request(url("/commands"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(WorkGraphCommandRequestSchema.parse(body)),
    }).catch((error) => {
      throw new WorkGraphApiError("offline", error instanceof Error ? error.message : "WorkGraph is offline")
    })
    const value = await response.json().catch(() => {
      throw new WorkGraphApiError("invalid_response", "WorkGraph returned invalid JSON", response.status)
    })
    const result = CommandResultSchema.safeParse(value)
    if (result.success) {
      if (response.ok || !result.data.ok) return result.data
      throw await apiError(response, value)
    }
    if (!response.ok) throw await apiError(response, value)
    throw new WorkGraphApiError("invalid_response", result.error.message, response.status)
  }
  const execute = (commandInput: z.input<typeof WorkGraphCommandRequestSchema>["command"]) => command({
    operationId: input.operationId ? input.operationId() : crypto.randomUUID(),
    command: commandInput,
  })
  const write = <T>(path: string, body: unknown, parse: (value: unknown) => T, method: "POST" | "PUT" | "DELETE" = "POST") => read(path, parse, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const snapshotPage = (cursor?: SnapshotResumeCursor) => {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor) query.set("after", cursor)
    return read(`/snapshot?${query}`, decodeWorkGraphSnapshot)
  }
  const snapshot = () => collectWorkGraphSnapshotPages({
    page: snapshotPage,
    isCursorInvalid: (error) => error instanceof WorkGraphApiError && error.kind === "cursor_invalid",
  }).catch((error) => {
    if (error instanceof WorkGraphSnapshotAggregationError) {
      throw new WorkGraphApiError("invalid_response", error.message)
    }
    throw error
  })

  return {
    snapshot,
    attention: (after?: AttentionCursor, limit = 50) => {
      const query = new URLSearchParams({ limit: String(limit) })
      if (after) query.set("after", AttentionCursorSchema.parse(after))
      return read(`/attention?${query}`, (value) => AttentionPageSchema.parse(value))
    },
    markAllAttentionRead: () => write("/attention/read", {}, (value) => AttentionAcknowledgementSchema.parse(value)),
    clearAttention: () => write("/attention/clear", {}, (value) => AttentionAcknowledgementSchema.parse(value)),
    defaults: (): Promise<WorkGraphDefaultsDto> =>
      read("/defaults", (value) => WorkGraphDefaultsDtoSchema.parse(value)),
    executionCapabilities: (options: Readonly<{ directory?: string }> = {}): Promise<ExecutionCapabilities> => {
      const directory = options.directory?.trim()
      const query = directory ? `?${new URLSearchParams({ directory })}` : ""
      return read(`/execution-capabilities${query}`, (value) => ExecutionCapabilitiesSchema.parse(value), undefined, decodeExecutionCapabilitiesError)
    },
    stream: (streamId: string): Promise<StreamDto> =>
      read(`/streams/${encodeURIComponent(streamId)}`, (value) => StreamDtoSchema.parse(value)),
    replacementReview: (input: Readonly<{ streamId: string; previousSource: WorkSourceRevisionRef }>): Promise<ReplacementReview> => {
      const query = new URLSearchParams({
        workSourceId: input.previousSource.workSourceId,
        revisionId: input.previousSource.revisionId,
        contentHash: input.previousSource.contentHash,
      })
      return read(
        `/streams/${encodeURIComponent(input.streamId)}/replacement-review?${query}`,
        (value) => ReplacementReviewSchema.parse(value),
      )
    },
    proposal: (proposalId: string) =>
      read(`/proposals/${encodeURIComponent(proposalId)}`, (value) => AdmissionProposalDtoSchema.parse(value)),
    workItem: (workItemId: string) =>
      read(`/work-items/${encodeURIComponent(workItemId)}`, (value) => WorkItemDtoSchema.parse(value)),
    workItemRuns: (
      workItemId: string,
      options: Readonly<{ after?: WorkItemRunPageCursor; limit?: number }> = {},
    ) => {
      const query = new URLSearchParams({ limit: String(options.limit ?? 50) })
      if (options.after) query.set("after", WorkItemRunPageCursorSchema.parse(options.after))
      return read(`/work-items/${encodeURIComponent(workItemId)}/runs?${query}`, (value) => WorkItemRunPageSchema.parse(value))
    },
    workItemActivity: (
      workItemId: string,
      options: Readonly<{
        after?: TaskActivityPageCursor
        granularity?: StreamActivityGranularity
        limit?: number
      }> = {},
    ) => {
      const query = new URLSearchParams({
        granularity: StreamActivityGranularitySchema.parse(options.granularity ?? "progress"),
        limit: String(options.limit ?? 25),
      })
      if (options.after) query.set("after", TaskActivityPageCursorSchema.parse(options.after))
      return read(`/work-items/${encodeURIComponent(workItemId)}/activity?${query}`, (value) => TaskActivityPageSchema.parse(value))
    },
    run: (runId: string) =>
      read(
        `/runs/${encodeURIComponent(runId)}`,
        (value) => RunDetailDtoSchema.parse(value),
        bypassFetchThrottle({}),
      ),
    decision: (decisionId: string) =>
      read(`/decisions/${encodeURIComponent(decisionId)}`, (value) => DecisionDtoSchema.parse(value)),
    sourceRevision: (workSourceId: string, revisionId: string) =>
      read(`/sources/${encodeURIComponent(workSourceId)}/revisions/${encodeURIComponent(revisionId)}`, (value) => WorkSourceRevisionDtoSchema.parse(value)),
    workSources: (options: Readonly<{ after?: string; limit?: number }> = {}) => {
      const query = new URLSearchParams({ limit: String(options.limit ?? 50) })
      if (options.after) query.set("after", options.after)
      return read(`/sources?${query}`, (value) => WorkSourcesResponseSchema.parse(value))
    },
    evidence: (evidenceId: string) =>
      read(`/evidence/${encodeURIComponent(evidenceId)}`, (value) => EvidenceDtoSchema.parse(value)),
    evidencePage: (
      subjectInput: z.input<typeof EvidenceSubjectSchema>,
      options: Readonly<{ after?: EvidencePageCursor; limit?: number }> = {},
    ) => {
      const subject = EvidenceSubjectSchema.parse(subjectInput)
      const query = new URLSearchParams({ subjectType: subject.type, limit: String(options.limit ?? 50) })
      if (subject.type === "stream") query.set("streamId", subject.streamId)
      if (subject.type === "outcome") query.set("outcomeId", subject.outcomeId)
      if (subject.type === "work_item") query.set("workItemId", subject.workItemId)
      if (options.after) query.set("after", options.after)
      return read(`/evidence?${query}`, (value) => EvidencePageSchema.parse(value))
    },
    sourceViews: () => read("/source-views", (value) => SourceViewListResponseSchema.parse(value)),
    createSourceView: (sourceView: z.input<typeof CreateSourceViewInputSchema>) => write("/source-views", sourceView, (value) => SourceViewDtoSchema.parse(value)),
    updateSourceView: (sourceViewId: string, sourceView: z.input<typeof UpdateSourceViewInputSchema>) => write(`/source-views/${encodeURIComponent(sourceViewId)}`, sourceView, (value) => SourceViewDtoSchema.parse(value), "PUT"),
    deleteSourceView: (sourceViewId: string, expectedVersion: number) => write(`/source-views/${encodeURIComponent(sourceViewId)}`, { expectedVersion }, (value) => SourceViewDtoSchema.parse(value), "DELETE"),
    refreshSourceView: (sourceViewId: string) => write(`/source-views/${encodeURIComponent(sourceViewId)}/refresh`, {}, (value) => SourceViewRefreshResponseSchema.parse(value)),
    intakeCandidates: (options: Readonly<{
      sourceViewId?: string
      after?: IntakeCandidatePageCursor
      limit?: number
    }> = {}) => {
      const query = new URLSearchParams({ limit: String(options.limit ?? 50) })
      if (options.sourceViewId) query.set("sourceViewId", options.sourceViewId)
      if (options.after) query.set("after", IntakeCandidatePageCursorSchema.parse(options.after))
      return read(`/intake?${query}`, (value) => IntakeCandidatePageSchema.parse(value))
    },
    intakeCandidate: (candidateId: string) => read(`/intake/${encodeURIComponent(candidateId)}`, (value) => IntakeCandidateDtoSchema.parse(value)),
    stageIntakeCandidate: (candidateId: string) => write(`/intake/${encodeURIComponent(candidateId)}/stage`, {}, (value) => IntakeCandidateDtoSchema.parse(value)),
    dismissIntakeCandidate: (candidateId: string, expectedVersion: number) => write(`/intake/${encodeURIComponent(candidateId)}/dismiss`, { expectedVersion }, (value) => IntakeCandidateDtoSchema.parse(value)),
    restoreIntakeCandidate: (candidateId: string, expectedVersion: number) => write(`/intake/${encodeURIComponent(candidateId)}/restore`, { expectedVersion }, (value) => IntakeCandidateDtoSchema.parse(value)),
    command,
    updateWorkGraphDefaults: (expectedVersion: number, defaults: z.input<typeof WorkGraphDefaultsSchema>) => execute({
      version: 1,
      type: "update_workgraph_defaults",
      expectedVersion,
      defaults,
    }),
    createStream: (stream: { title: string; description?: string; execution?: z.input<typeof ExecutionProfileDefaultsSchema> }) => execute({
      version: 1,
      type: "create_stream",
      title: stream.title,
      ...(stream.description?.trim() ? { description: stream.description.trim() } : {}),
      ...(stream.execution ? { execution: stream.execution } : {}),
    }),
    createOutcome: (outcome: { streamId: string; title: string; description?: string; successCriteria: string[] }) => execute({
      version: 1,
      type: "create_outcome",
      streamId: outcome.streamId,
      title: outcome.title,
      ...(outcome.description?.trim() ? { description: outcome.description.trim() } : {}),
      successCriteria: outcome.successCriteria,
    }),
    createWorkItem: (item: {
      streamId: string
      outcomeId?: string
      title: string
      description?: string
      dependencyIds?: string[]
      completionContract: z.input<typeof CompletionContractSchema>
    }) => execute({
      version: 1,
      type: "create_work_item",
      streamId: item.streamId,
      ...(item.outcomeId ? { outcomeId: item.outcomeId } : {}),
      title: item.title,
      ...(item.description?.trim() ? { description: item.description.trim() } : {}),
      dependencyIds: item.dependencyIds ?? [],
      completionContract: item.completionContract,
    }),
    setStreamLifecycle: (stream: { streamId: string; expectedVersion: number; state: "active" | "paused" | "closed" | "reopened"; reason: string }) => execute({
      version: 1,
      type: "set_stream_lifecycle",
      ...stream,
    }),
    updateStreamCharter: async (streamId: string, expectedVersion: number, text: string) => execute({
      version: 1,
      type: "set_stream_charter",
      streamId,
      expectedVersion,
      charter: { text, hash: await sha256(text) },
    }),
    confirmPublicPr: (streamId: string, expectedVersion: number) => execute({
      version: 1,
      type: "confirm_public_pr",
      streamId,
      expectedVersion,
    }),
    updateStreamSettings: (
      streamId: string,
      expectedVersion: number,
      settings: Readonly<{
        execution: z.input<typeof ExecutionProfileDefaultsSchema>
        activityGranularity?: StreamActivityGranularity
      }>,
    ) => execute({
      version: 1,
      type: "update_stream",
      streamId,
      expectedVersion,
      execution: settings.execution,
      ...(settings.activityGranularity ? { activityGranularity: settings.activityGranularity } : {}),
    }),
    updateOutcomeExecution: (outcomeId: string, expectedVersion: number, execution: z.input<typeof ExecutionProfileDefaultsSchema>) => execute({
      version: 1,
      type: "update_outcome",
      outcomeId,
      expectedVersion,
      execution,
    }),
    updateWorkItemExecution: (workItemId: string, expectedVersion: number, execution: z.input<typeof ExecutionProfileDefaultsSchema>) => execute({
      version: 1,
      type: "update_work_item",
      workItemId,
      expectedVersion,
      execution,
    }),
    // Approval is owner-only and CAS-guarded: the exact `row_version` the UI
    // rendered is sent so an approve can never silently ratify an edit the user
    // never saw (0 rows affected on the server ⇒ version_conflict).
    approveWorkItem: (workItemId: string, expectedVersion: number) => execute({
      version: 1,
      type: "approve_work_item",
      workItemId,
      expectedVersion,
    }),
    rejectWorkItem: (workItemId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "reject_work_item",
      workItemId,
      expectedVersion,
      reason,
    }),
    // Bulk approval sends the exact rendered versions per entry; the server
    // approves each independently and returns a per-item outcome so stale rows
    // surface as version_conflict instead of blocking the rest.
    approveWorkItems: (approvals: ReadonlyArray<{ workItemId: string; expectedVersion: number }>) => execute({
      version: 1,
      type: "approve_work_items",
      approvals: approvals.map((approval) => ({ workItemId: approval.workItemId, expectedVersion: approval.expectedVersion })),
    }),
    cancelRun: (runId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "cancel_run",
      runId,
      expectedVersion,
      reason,
    }),
    retryWorkItem: (workItemId: string, expectedVersion: number) => execute({
      version: 1,
      type: "retry_work_item",
      workItemId,
      expectedVersion,
    }),
    cancelWorkItem: (workItemId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "cancel_work_item",
      workItemId,
      expectedVersion,
      reason,
    }),
    answerDecision: (decisionId: string, expectedVersion: number, answer: { optionId?: string; answer?: string }) => execute({
      version: 1,
      type: "answer_decision",
      decisionId,
      expectedVersion,
      ...answer,
    }),
    dismissDecision: (decisionId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "dismiss_decision",
      decisionId,
      expectedVersion,
      reason,
    }),
    proposeDecision: (decision: {
      streamId: string
      question: string
      options: Array<{ id: string; label: string; description?: string }>
      recommendationOptionId?: string
      rationale?: string
      affectedWorkItemIds: string[]
    }) => execute({
      version: 1,
      type: "propose_decision",
      ...decision,
    }),
    recordEvidence: (evidence: { subject: z.input<typeof EvidenceSubjectSchema>; requirementId?: string; sourceRunId?: string; evidence: z.input<typeof EvidenceInputSchema> }) => execute({
      version: 1,
      type: "record_evidence",
      ...evidence,
    }),
    closeOutcome: (outcomeId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "close_outcome",
      outcomeId,
      expectedVersion,
      reason,
    }),
    closeStream: (streamId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "close_stream",
      streamId,
      expectedVersion,
      reason,
    }),
    deleteStream: (streamId: string, expectedVersion: number, reason: string) => execute({
      version: 1,
      type: "delete_stream",
      streamId,
      expectedVersion,
      reason,
    }),
    createWorkSource: (source: { title: string; content: string }) => execute({
      version: 1,
      type: "create_work_source",
      ...source,
    }),
    reviseWorkSource: (source: { workSourceId: string; expectedRevisionId: string; content: string; title?: string }) => execute({
      version: 1,
      type: "revise_work_source",
      ...source,
    }),
    proposeAdmission: (
      source: z.input<typeof WorkSourceRevisionRefSchema>,
      targetStreamId?: string,
      execution?: z.input<typeof ExecutionProfileDefaultsSchema>,
    ) => execute({
      version: 1,
      type: "propose_admission",
      source,
      ...(targetStreamId ? { targetStreamId } : {}),
      ...(execution ? { execution } : {}),
    }),
    retryAdmissionPlanning: (proposalId: string, expectedVersion: number) => execute({
      version: 1,
      type: "retry_admission_planning",
      proposalId,
      expectedVersion,
    }),
    dismissAdmission: (proposalId: string, expectedVersion: number) => execute({
      version: 1,
      type: "dismiss_admission",
      proposalId,
      expectedVersion,
    }),
    reopenAdmission: (proposalId: string, expectedVersion: number) => execute({
      version: 1,
      type: "reopen_admission",
      proposalId,
      expectedVersion,
    }),
    confirmAdmission: (proposal: {
      proposalId: string
      expectedVersion: number
      source: z.input<typeof WorkSourceRevisionRefSchema>
      selection: z.input<typeof AdmissionSelectionSchema>
      outcomes?: z.input<typeof AdmissionOutcomeInputSchema>[]
      workItems?: z.input<typeof AdmissionWorkItemInputSchema>[]
    }) => execute({
      version: 1,
      type: "confirm_admission",
      ...proposal,
    }),
  }
}

type ApiErrorDecoder = (value: unknown, status: number) => WorkGraphApiError | undefined

async function apiError(response: Response, responseValue?: unknown, decodeError?: ApiErrorDecoder) {
  const value = responseValue === undefined ? await response.json().catch(() => undefined) : responseValue
  const decoded = decodeError?.(value, response.status)
  if (decoded) return decoded
  const parsed = WorkGraphApiErrorResponseSchema.safeParse(value)
  if (!parsed.success) {
    return new WorkGraphApiError("invalid_response", "WorkGraph returned an invalid error response", response.status)
  }
  return new WorkGraphApiError(
    parsed.data.error.code,
    parsed.data.error.message,
    response.status,
    parsed.data.error.code,
    parsed.data.error.retryable,
  )
}

// The GET /execution-capabilities failure is a strict 503 with a distinct
// capability envelope; recognize it exactly so callers keep code, capability,
// reason, status, retryable, and message instead of an opaque invalid_response.
function decodeExecutionCapabilitiesError(value: unknown, status: number) {
  const parsed = ExecutionCapabilitiesErrorSchema.safeParse(value)
  if (!parsed.success) return undefined
  return new WorkGraphApiError(
    parsed.data.error.code,
    parsed.data.error.message,
    status,
    parsed.data.error.code,
    parsed.data.error.retryable,
    parsed.data.error.capability,
    parsed.data.error.reason,
  )
}

export const ApproveWorkItemOutcomeSchema = z.enum(["approved", "version_conflict", "not_staged", "not_found"])
export type ApproveWorkItemOutcome = z.infer<typeof ApproveWorkItemOutcomeSchema>

const ApproveWorkItemsResultSchema = z.object({
  results: z.array(z.object({
    workItemId: z.string(),
    outcome: ApproveWorkItemOutcomeSchema,
    version: z.number().optional(),
  })),
})
export type ApproveWorkItemsResult = z.infer<typeof ApproveWorkItemsResultSchema>

/**
 * Reads the per-item outcomes from a successful `approve_work_items` command.
 * The command result is a partial success by design — some entries approve while
 * others come back `version_conflict`/`not_staged`/`not_found` — so the caller
 * needs the exact per-item breakdown to flag the rows that changed since the
 * user looked. Returns undefined when the value is not the expected shape.
 */
export function parseApproveWorkItemsResult(result: CommandResult): ApproveWorkItemsResult | undefined {
  if (!result.ok) return undefined
  const parsed = ApproveWorkItemsResultSchema.safeParse(result.value)
  return parsed.success ? parsed.data : undefined
}

export type WorkGraphClient = ReturnType<typeof createWorkGraphClient>

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
export type SourceView = z.infer<typeof SourceViewDtoSchema>
export type IntakeCandidate = z.infer<typeof IntakeCandidateDtoSchema>
