import { Hono } from "hono"
import type { Context } from "hono"
import {
  AttentionCursorError,
  AttentionPageSchema,
  AttentionAcknowledgementSchema,
  CommandResultSchema,
  EvidenceDtoSchema,
  EvidencePageCursorError,
  EvidencePageSchema,
  AdmissionProposalDtoSchema,
  ReplacementReviewSchema,
  AttemptDetailDtoSchema,
  DecisionDtoSchema,
  WorkItemAttemptPageCursorError,
  WorkItemAttemptPageSchema,
  TaskActivityPageSchema,
  TaskActivityPageCursorError,
  WorkItemDtoSchema,
  StreamDtoSchema,
  WorkSourceDtoSchema,
  WorkSourceRevisionDtoSchema,
  WorkGraphSnapshotPageSchema,
  WorkGraphArchiveSchema,
  WorkGraphArchiveRestoreError,
  WorkGraphArchiveRestoreRequestSchema,
  SnapshotResumeCursorError,
  isExecutionCapabilityCatalogFresh,
  WorkSourcePageCursorError,
  type CommandErrorCode,
  type EvidenceSubject,
  type WorkGraphArchiveRestoreErrorReason,
  type WorkGraphContext,
} from "../contracts"
import {
  WorkGraphHttpAttentionQuerySchema,
  WorkGraphHttpCommandRequestSchema,
  WorkGraphHttpContextSchema,
  WorkGraphHttpDefaultsResponseSchema,
  WorkGraphHttpExecutionCapabilitiesErrorSchema,
  WorkGraphHttpExecutionCapabilitiesQuerySchema,
  WorkGraphHttpExecutionCapabilitiesResponseSchema,
  WorkGraphHttpErrorSchema,
  WorkGraphHttpEvidenceListQuerySchema,
  WorkGraphHttpEvidenceReadQuerySchema,
  WorkGraphHttpSnapshotQuerySchema,
  WorkGraphHttpSourceQuerySchema,
  WorkGraphHttpSourceRevisionQuerySchema,
  WorkGraphHttpSourcesQuerySchema,
  WorkGraphHttpSourcesResponseSchema,
  WorkGraphHttpStreamQuerySchema,
  WorkGraphHttpProposalReadSchema,
  WorkGraphHttpReplacementReviewQuerySchema,
  WorkGraphHttpWorkItemReadSchema,
  WorkGraphHttpWorkItemAttemptsQuerySchema,
  WorkGraphHttpWorkItemActivityQuerySchema,
  WorkGraphHttpAttemptReadSchema,
  WorkGraphHttpDecisionReadSchema,
  type WorkGraphHttpQueries,
  type WorkGraphHttpService,
  type WorkGraphHttpErrorCode,
  type WorkGraphTrustedContextResolver,
  WorkGraphHttpArchiveErrorSchema,
  WorkGraphHttpArchiveRestoreResultSchema,
  WorkGraphHttpOwnerDeletionErrorSchema,
  WorkGraphHttpOwnerDeletionRequestSchema,
  WorkGraphHttpOwnerDeletionResultSchema,
  workGraphEvidenceListInput,
} from "./contracts"
import type { AttentionAcknowledgementService } from "../application/attention-acknowledgement-service"
import {
  WorkGraphOwnerDeletionError,
  type WorkGraphArchivePort,
  type WorkGraphOwnerDeletionErrorReason,
  type WorkGraphOwnerDeletionPort,
  ExecutionCapabilitiesUnavailableError,
  type ExecutionCapabilitiesPort,
} from "../ports"

type Variables = { workGraphContext: WorkGraphContext }

export function createWorkGraphHttpRouter<Queries extends WorkGraphHttpQueries>(input: Readonly<{
  service: WorkGraphHttpService<Queries>
  resolveContext: WorkGraphTrustedContextResolver
  attentionAcknowledgements?: AttentionAcknowledgementService
  archive: WorkGraphArchivePort
  deletion: WorkGraphOwnerDeletionPort
  executionCapabilities?: ExecutionCapabilitiesPort
  now?: () => number
  reportError?: (report: WorkGraphHttpErrorReport) => void
}>) {
  const router = new Hono<{ Variables: Variables }>()
  const now = input.now ?? Date.now
  const reportError = input.reportError ?? reportErrorToConsole

  router.use("*", async (context, next) => {
    const candidate = await Promise.resolve().then(() => input.resolveContext(context.req.raw)).catch(() => undefined)
    const resolved = WorkGraphHttpContextSchema.safeParse(candidate)
    if (!resolved.success) return errorResponse(context, 401, "unauthorized", "Trusted WorkGraph context is required", false)
    context.set("workGraphContext", candidate as WorkGraphContext)
    await next()
  })

  router.post("/commands", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Shared WorkGraph access is read-only", false)
    }
    const json = await context.req.json().catch(() => undefined)
    const request = WorkGraphHttpCommandRequestSchema.safeParse(json)
    if (!request.success) return errorResponse(context, 400, "validation_error", "Invalid WorkGraph command", false)

    const result = CommandResultSchema.parse(await input.service.execute(context.get("workGraphContext"), request.data))
    if (result.ok) return context.json(result)
    return context.json(result, commandStatus(result.error.code))
  })

  router.get("/archive", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Shared WorkGraph access is read-only", false)
    }
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "WorkGraph archive export does not accept query selectors", false)
    }
    try {
      const archive = WorkGraphArchiveSchema.parse(await input.archive.export(context.get("workGraphContext")))
      if (archive.ownerUserId !== context.get("workGraphContext").ownerUserId) {
        throw new Error("WorkGraph archive export crossed its trusted owner boundary")
      }
      return context.json(archive)
    } catch (error) {
      if (isArchiveRestoreError(error)) return archiveErrorResponse(context, error.reason)
      throw error
    }
  })

  router.post("/archive/restore", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Shared WorkGraph access is read-only", false)
    }
    const request = WorkGraphArchiveRestoreRequestSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!request.success) return archiveErrorResponse(context, "malformed")
    try {
      return context.json(WorkGraphHttpArchiveRestoreResultSchema.parse(
        await input.archive.restore(context.get("workGraphContext"), request.data),
      ))
    } catch (error) {
      if (isArchiveRestoreError(error)) return archiveErrorResponse(context, error.reason)
      throw error
    }
  })

  router.delete("/owner", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return ownerDeletionErrorResponse(context, "forbidden")
    }
    const request = WorkGraphHttpOwnerDeletionRequestSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!request.success) {
      return errorResponse(context, 400, "validation_error", "Invalid WorkGraph owner deletion request", false)
    }
    try {
      return context.json(WorkGraphHttpOwnerDeletionResultSchema.parse(
        await input.deletion.deleteOwner(context.get("workGraphContext"), request.data),
      ))
    } catch (error) {
      if (isOwnerDeletionError(error)) return ownerDeletionErrorResponse(context, error.reason)
      throw error
    }
  })

  router.get("/defaults", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "WorkGraph defaults reads do not accept query selectors", false)
    }
    const defaults = WorkGraphHttpDefaultsResponseSchema.parse(
      await input.service.queries.defaults.read(context.get("workGraphContext"), {}),
    )
    if (defaults.ownerUserId !== context.get("workGraphContext").ownerUserId) {
      throw new Error("WorkGraph defaults query crossed its trusted owner boundary")
    }
    return context.json(defaults)
  })

  router.get("/execution-capabilities", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Execution capabilities require owner access", false)
    }
    const query = WorkGraphHttpExecutionCapabilitiesQuerySchema.safeParse(context.req.query())
    if (!query.success) {
      return errorResponse(context, 400, "validation_error", "Invalid execution capabilities query", false)
    }
    if (!input.executionCapabilities) {
      return executionCapabilitiesErrorResponse(context, new ExecutionCapabilitiesUnavailableError(
        "runtime",
        "runtime_unavailable",
        "Execution capability discovery is not composed",
        false,
      ))
    }
    try {
      const result = WorkGraphHttpExecutionCapabilitiesResponseSchema.parse(
        await input.executionCapabilities.read(context.get("workGraphContext"), query.data),
      )
      if (
        result.organizationId !== context.get("workGraphContext").organizationId ||
        result.ownerUserId !== context.get("workGraphContext").ownerUserId
      ) {
        throw new Error("Execution capabilities query crossed its trusted tenant boundary")
      }
      if (!isExecutionCapabilityCatalogFresh(result, now())) {
        throw new ExecutionCapabilitiesUnavailableError(
          "runtime",
          "runtime_unavailable",
          "The execution capability catalog has expired and must be refreshed",
          true,
        )
      }
      return context.json(result)
    } catch (error) {
      if (isExecutionCapabilitiesUnavailableError(error)) {
        return executionCapabilitiesErrorResponse(context, error)
      }
      throw error
    }
  })

  router.post("/execution-capabilities/refresh", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Execution capabilities require owner access", false)
    }
    const query = WorkGraphHttpExecutionCapabilitiesQuerySchema.safeParse(context.req.query())
    if (!query.success) {
      return errorResponse(context, 400, "validation_error", "Invalid execution capabilities refresh query", false)
    }
    if (!input.executionCapabilities?.refresh) {
      return executionCapabilitiesErrorResponse(context, new ExecutionCapabilitiesUnavailableError(
        "catalog_workspace",
        "catalog_workspace_unavailable",
        "Hosted capability refresh is not composed",
        false,
      ))
    }
    try {
      const result = WorkGraphHttpExecutionCapabilitiesResponseSchema.parse(
        await input.executionCapabilities.refresh(context.get("workGraphContext"), {}),
      )
      if (
        result.organizationId !== context.get("workGraphContext").organizationId ||
        result.ownerUserId !== context.get("workGraphContext").ownerUserId
      ) {
        throw new Error("Execution capabilities refresh crossed its trusted tenant boundary")
      }
      if (!isExecutionCapabilityCatalogFresh(result, now())) {
        throw new ExecutionCapabilitiesUnavailableError(
          "runtime",
          "runtime_unavailable",
          "The refreshed execution capability catalog is already stale",
          true,
        )
      }
      return context.json(result)
    } catch (error) {
      if (isExecutionCapabilitiesUnavailableError(error)) {
        return executionCapabilitiesErrorResponse(context, error)
      }
      throw error
    }
  })

  router.get("/snapshot", async (context) => {
    const query = WorkGraphHttpSnapshotQuerySchema.safeParse(context.req.query())
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid snapshot query", false)
    const snapshot = await input.service.queries.snapshot.page(context.get("workGraphContext"), query.data)
      .then(WorkGraphSnapshotPageSchema.parse)
      .catch((error) => {
        if (isCursorError(error, "SnapshotResumeCursorError")) {
          return errorResponse(context, 409, "cursor_invalid", "Snapshot cursor is no longer valid", false)
        }
        throw error
      })
    if (snapshot instanceof Response) return snapshot
    if (snapshot.records.some((record) => record.ownerUserId !== context.get("workGraphContext").ownerUserId)) {
      throw new Error("Snapshot query crossed its trusted owner boundary")
    }
    return context.json(snapshot)
  })

  router.get("/attention", async (context) => {
    const query = WorkGraphHttpAttentionQuerySchema.safeParse(context.req.query())
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Attention query", false)
    try {
      const page = AttentionPageSchema.parse(
        await input.service.queries.attention.list(context.get("workGraphContext"), query.data),
      )
      if (page.items.some((item) => item.ownerUserId !== context.get("workGraphContext").ownerUserId)) {
        throw new Error("Attention query crossed its trusted owner boundary")
      }
      return context.json(page)
    } catch (error) {
      if (error instanceof AttentionCursorError) {
        return errorResponse(context, 409, "cursor_invalid", "Attention cursor is no longer valid", false)
      }
      throw error
    }
  })

  router.post("/attention/read", async (context) => {
    if (!input.attentionAcknowledgements) {
      return errorResponse(context, 404, "not_found", "Attention acknowledgements are unavailable", false)
    }
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Owner access is required", false)
    }
    const result = AttentionAcknowledgementSchema.parse(
      await input.attentionAcknowledgements.markAllRead(context.get("workGraphContext")),
    )
    if (result.ownerUserId !== context.get("workGraphContext").ownerUserId) {
      throw new Error("Attention acknowledgement crossed its trusted owner boundary")
    }
    return context.json(result)
  })

  router.post("/attention/clear", async (context) => {
    if (!input.attentionAcknowledgements) {
      return errorResponse(context, 404, "not_found", "Attention acknowledgements are unavailable", false)
    }
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Owner access is required", false)
    }
    const result = AttentionAcknowledgementSchema.parse(
      await input.attentionAcknowledgements.clear(context.get("workGraphContext")),
    )
    if (result.ownerUserId !== context.get("workGraphContext").ownerUserId) {
      throw new Error("Attention acknowledgement crossed its trusted owner boundary")
    }
    return context.json(result)
  })

  router.get("/streams/:streamId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Stream reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpStreamQuerySchema.safeParse({ streamId: context.req.param("streamId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Stream identifier", false)
    const stream = await input.service.queries.streams.read(context.get("workGraphContext"), query.data)
    if (!stream) return errorResponse(context, 404, "not_found", "Stream not found", false)
    const parsed = StreamDtoSchema.parse(stream)
    if (parsed.ownerUserId !== context.get("workGraphContext").ownerUserId) {
      throw new Error("Stream query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/proposals/:proposalId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Proposal reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpProposalReadSchema.safeParse({ proposalId: context.req.param("proposalId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Proposal identifier", false)
    const proposal = await input.service.queries.proposals.read(context.get("workGraphContext"), query.data)
    if (!proposal) return errorResponse(context, 404, "not_found", "Proposal not found", false)
    const parsed = AdmissionProposalDtoSchema.parse(proposal)
    if (parsed.ownerUserId !== context.get("workGraphContext").ownerUserId || parsed.id !== query.data.proposalId) {
      throw new Error("Proposal query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/streams/:streamId/replacement-review", async (context) => {
    if (context.get("workGraphContext").access.mode !== "owner") {
      return errorResponse(context, 403, "forbidden", "Replacement review requires owner access", false)
    }
    const raw = context.req.query()
    if (Object.keys(raw).some((key) => !["workSourceId", "revisionId", "contentHash"].includes(key))) {
      return errorResponse(context, 400, "validation_error", "Invalid replacement review query", false)
    }
    const query = WorkGraphHttpReplacementReviewQuerySchema.safeParse({
      streamId: context.req.param("streamId"),
      previousSource: {
        workSourceId: raw.workSourceId,
        revisionId: raw.revisionId,
        contentHash: raw.contentHash,
      },
    })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid replacement review query", false)
    const review = await input.service.queries.proposals.replacementReview(context.get("workGraphContext"), query.data)
    if (!review) return errorResponse(context, 404, "not_found", "Replacement review target was not found", false)
    const parsed = ReplacementReviewSchema.parse(review)
    if (parsed.streamId !== query.data.streamId) throw new Error("Replacement review crossed its trusted Stream boundary")
    return context.json(parsed)
  })

  router.get("/work-items/:workItemId/attempts", async (context) => {
    const id = WorkGraphHttpWorkItemReadSchema.safeParse({ workItemId: context.req.param("workItemId") })
    const query = WorkGraphHttpWorkItemAttemptsQuerySchema.safeParse(context.req.query())
    if (!id.success || !query.success) return errorResponse(context, 400, "validation_error", "Invalid Task Attempts query", false)
    try {
      const page = WorkItemAttemptPageSchema.parse(await input.service.queries.workItems.listAttempts(
        context.get("workGraphContext"),
        { workItemId: id.data.workItemId, ...query.data },
      ))
      if (page.attempts.some((detail) => detail.attempt.ownerUserId !== context.get("workGraphContext").ownerUserId || detail.attempt.workItemId !== id.data.workItemId)) {
        throw new Error("Task Attempts query crossed its trusted owner boundary")
      }
      return context.json(page)
    } catch (error) {
      if (isWorkItemAttemptPageCursorError(error)) {
        return errorResponse(context, 409, "cursor_invalid", "Task Attempt cursor is no longer valid", false)
      }
      throw error
    }
  })

  router.get("/work-items/:workItemId/activity", async (context) => {
    const id = WorkGraphHttpWorkItemReadSchema.safeParse({ workItemId: context.req.param("workItemId") })
    const query = WorkGraphHttpWorkItemActivityQuerySchema.safeParse(context.req.query())
    if (!id.success || !query.success) return errorResponse(context, 400, "validation_error", "Invalid Task activity query", false)
    try {
      const page = TaskActivityPageSchema.parse(await input.service.queries.workItems.listActivity(
        context.get("workGraphContext"),
        { workItemId: id.data.workItemId, ...query.data },
      ))
      if (page.entries.some((entry) => entry.workItemId !== id.data.workItemId)) {
        throw new Error("Task activity query crossed its trusted Task boundary")
      }
      return context.json(page)
    } catch (error) {
      if (error instanceof TaskActivityPageCursorError) {
        return errorResponse(context, 409, "cursor_invalid", "Task activity cursor is no longer valid", false)
      }
      throw error
    }
  })

  router.get("/work-items/:workItemId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Task reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpWorkItemReadSchema.safeParse({ workItemId: context.req.param("workItemId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Task identifier", false)
    const item = await input.service.queries.workItems.readDetail(context.get("workGraphContext"), query.data)
    if (!item) return errorResponse(context, 404, "not_found", "Task not found", false)
    const parsed = WorkItemDtoSchema.parse(item)
    if (parsed.ownerUserId !== context.get("workGraphContext").ownerUserId || parsed.id !== query.data.workItemId) {
      throw new Error("Task query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/attempts/:attemptId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Attempt reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpAttemptReadSchema.safeParse({ attemptId: context.req.param("attemptId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Attempt identifier", false)
    const detail = await input.service.queries.attempts.read(context.get("workGraphContext"), query.data)
    if (!detail) return errorResponse(context, 404, "not_found", "Attempt not found", false)
    const parsed = AttemptDetailDtoSchema.parse(detail)
    if (parsed.attempt.ownerUserId !== context.get("workGraphContext").ownerUserId || parsed.attempt.id !== query.data.attemptId) {
      throw new Error("Attempt query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/decisions/:decisionId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Decision reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpDecisionReadSchema.safeParse({ decisionId: context.req.param("decisionId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Decision identifier", false)
    const decision = await input.service.queries.decisions.read(context.get("workGraphContext"), query.data)
    if (!decision) return errorResponse(context, 404, "not_found", "Decision not found", false)
    const parsed = DecisionDtoSchema.parse(decision)
    if (parsed.ownerUserId !== context.get("workGraphContext").ownerUserId || parsed.id !== query.data.decisionId) {
      throw new Error("Decision query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/evidence", async (context) => {
    const query = WorkGraphHttpEvidenceListQuerySchema.safeParse(context.req.query())
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Evidence query", false)
    const listInput = workGraphEvidenceListInput(query.data)
    try {
      const page = EvidencePageSchema.parse(
        await input.service.queries.evidence.list(context.get("workGraphContext"), listInput),
      )
      if (page.evidence.some((evidence) => !sameEvidenceSubject(evidence.subject, listInput.subject))) {
        throw new Error("Evidence list query crossed its trusted subject boundary")
      }
      return context.json(page)
    } catch (error) {
      if (isEvidencePageCursorError(error)) {
        return errorResponse(context, 409, "cursor_invalid", "Evidence page cursor is no longer valid", false)
      }
      throw error
    }
  })

  router.get("/evidence/:evidenceId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Evidence reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpEvidenceReadQuerySchema.safeParse({ evidenceId: context.req.param("evidenceId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Evidence identifier", false)
    const evidence = await input.service.queries.evidence.read(context.get("workGraphContext"), query.data)
    if (!evidence) return errorResponse(context, 404, "not_found", "Evidence not found", false)
    const parsed = EvidenceDtoSchema.parse(evidence)
    if (parsed.id !== query.data.evidenceId) throw new Error("Evidence query returned a different identifier")
    return context.json(parsed)
  })

  router.get("/sources", async (context) => {
    const query = WorkGraphHttpSourcesQuerySchema.safeParse(context.req.query())
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Work Source query", false)
    try {
      const result = WorkGraphHttpSourcesResponseSchema.parse(
        await input.service.queries.sources.list(context.get("workGraphContext"), query.data),
      )
      if (result.sources.some((source) => source.ownerUserId !== context.get("workGraphContext").ownerUserId)) {
        throw new Error("Work Source query crossed its trusted owner boundary")
      }
      return context.json(result)
    } catch (error) {
      if (isCursorError(error, "WorkSourcePageCursorError")) {
        return errorResponse(context, 409, "cursor_invalid", "Work Source cursor is no longer valid", false)
      }
      throw error
    }
  })

  router.get("/sources/:workSourceId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Work Source reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpSourceQuerySchema.safeParse({ workSourceId: context.req.param("workSourceId") })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Work Source identifier", false)
    const source = await input.service.queries.sources.read(context.get("workGraphContext"), query.data)
    if (!source) return errorResponse(context, 404, "not_found", "Work Source not found", false)
    const parsed = WorkSourceDtoSchema.parse(source)
    if (parsed.ownerUserId !== context.get("workGraphContext").ownerUserId) {
      throw new Error("Work Source query crossed its trusted owner boundary")
    }
    return context.json(parsed)
  })

  router.get("/sources/:workSourceId/revisions/:revisionId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return errorResponse(context, 400, "validation_error", "Work Source revision reads do not accept query selectors", false)
    }
    const query = WorkGraphHttpSourceRevisionQuerySchema.safeParse({
      workSourceId: context.req.param("workSourceId"),
      revisionId: context.req.param("revisionId"),
    })
    if (!query.success) return errorResponse(context, 400, "validation_error", "Invalid Work Source revision identifier", false)
    const revision = await input.service.queries.sources.readRevision(context.get("workGraphContext"), query.data)
    if (!revision) return errorResponse(context, 404, "not_found", "Work Source revision not found", false)
    return context.json(WorkSourceRevisionDtoSchema.parse(revision))
  })

  router.onError((error, context) => {
    try {
      const workGraphContext = context.get("workGraphContext") as WorkGraphContext | undefined
      reportError({
        method: context.req.method,
        path: context.req.path,
        ...(workGraphContext?.requestId ? { requestId: workGraphContext.requestId } : {}),
        error,
      })
    } catch {
      // Reporting must never replace the generic error response.
    }
    return errorResponse(context, 500, "internal_error", "WorkGraph request failed", false)
  })

  return router
}

export type WorkGraphHttpErrorReport = Readonly<{
  method: string
  path: string
  requestId?: string
  error: unknown
}>

function reportErrorToConsole(report: WorkGraphHttpErrorReport) {
  const error = report.error
  console.error("workgraph http request failed", {
    method: report.method,
    path: report.path,
    ...(report.requestId ? { requestId: report.requestId } : {}),
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  })
}

function isCursorError(
  error: unknown,
  name: "SnapshotResumeCursorError" | "WorkSourcePageCursorError",
): error is SnapshotResumeCursorError | WorkSourcePageCursorError {
  return error instanceof Error && error.name === name && "code" in error && error.code === "cursor_invalid"
}

function commandStatus(code: CommandErrorCode) {
  if (code === "validation_error") return 400 as const
  if (code === "forbidden") return 403 as const
  if (code === "not_found") return 404 as const
  if (code === "version_conflict" || code === "idempotency_conflict") return 409 as const
  if (code === "execution_unavailable") return 503 as const
  if (code === "internal_error") return 500 as const
  return 422 as const
}

function errorResponse(
  context: Context,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  code: WorkGraphHttpErrorCode,
  message: string,
  retryable: boolean,
) {
  return context.json(WorkGraphHttpErrorSchema.parse({ error: { code, message, retryable } }), status)
}

function archiveErrorResponse(
  context: Context,
  reason: ConstructorParameters<typeof WorkGraphArchiveRestoreError>[0],
) {
  const retryable = reason === "not_quiescent" || reason === "dependency_unavailable"
  const status = reason === "malformed" ? 400 as const
    : reason === "cross_owner" ? 403 as const
      : reason === "dependency_unavailable" ? 503 as const
        : 409 as const
  return context.json(WorkGraphHttpArchiveErrorSchema.parse({
    error: {
      code: "archive_restore_rejected",
      reason,
      message: "WorkGraph archive operation was rejected",
      retryable,
    },
  }), status)
}

function executionCapabilitiesErrorResponse(
  context: Context,
  error: ExecutionCapabilitiesUnavailableError,
) {
  return context.json(WorkGraphHttpExecutionCapabilitiesErrorSchema.parse({
    error: {
      code: error.code,
      capability: error.capability,
      reason: error.reason,
      message: error.message,
      retryable: error.retryable,
    },
  }), 503)
}

function ownerDeletionErrorResponse(
  context: Context,
  reason: ConstructorParameters<typeof WorkGraphOwnerDeletionError>[0],
) {
  const retryable = reason === "not_quiescent" || reason === "in_progress" || reason === "cleanup_failed"
  const status = reason === "forbidden" ? 403 as const
    : reason === "not_quiescent" || reason === "in_progress" ? 409 as const
      : reason === "cleanup_failed" ? 503 as const
        : 500 as const
  return context.json(WorkGraphHttpOwnerDeletionErrorSchema.parse({
    error: {
      code: "owner_deletion_rejected",
      reason,
      message: "WorkGraph owner deletion was rejected",
      retryable,
    },
  }), status)
}

function isArchiveRestoreError(error: unknown): error is Error & { reason: WorkGraphArchiveRestoreErrorReason } {
  return error instanceof Error && error.name === "WorkGraphArchiveRestoreError" && "reason" in error &&
    ["malformed", "secret_material", "not_quiescent", "cross_owner", "target_not_empty", "operation_conflict", "target_incompatible", "dependency_unavailable"]
      .includes(String(error.reason))
}

function isExecutionCapabilitiesUnavailableError(error: unknown): error is ExecutionCapabilitiesUnavailableError {
  return error instanceof Error &&
    error.name === "ExecutionCapabilitiesUnavailableError" &&
    "code" in error &&
    error.code === "execution_capabilities_unavailable" &&
    "capability" in error &&
    ["catalog_workspace", "runtime", "harnesses", "agents", "models", "tools", "repository", "connections"]
      .includes(String(error.capability)) &&
    "reason" in error &&
    ["catalog_workspace_unavailable", "runtime_unavailable", "catalog_invalid", "repository_unavailable", "connections_unavailable"]
      .includes(String(error.reason)) &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
}

function isOwnerDeletionError(error: unknown): error is Error & { reason: WorkGraphOwnerDeletionErrorReason } {
  return error instanceof Error && error.name === "WorkGraphOwnerDeletionError" && "reason" in error &&
    ["forbidden", "not_quiescent", "in_progress", "cleanup_failed", "storage_failed"].includes(String(error.reason))
}

function isEvidencePageCursorError(error: unknown): error is EvidencePageCursorError {
  return error instanceof Error && error.name === "EvidencePageCursorError" && "reason" in error &&
    ["invalid", "owner_mismatch", "subject_mismatch"].includes(String(error.reason))
}

function isWorkItemAttemptPageCursorError(error: unknown): error is WorkItemAttemptPageCursorError {
  return error instanceof Error && error.name === "WorkItemAttemptPageCursorError" && "reason" in error &&
    ["invalid", "owner_mismatch", "work_item_mismatch"].includes(String(error.reason))
}

function sameEvidenceSubject(
  left: EvidenceSubject,
  right: EvidenceSubject,
) {
  if (left.type !== right.type) return false
  if (left.type === "stream" && right.type === "stream") return left.streamId === right.streamId
  if (left.type === "outcome" && right.type === "outcome") return left.outcomeId === right.outcomeId
  return left.type === "work_item" && right.type === "work_item" && left.workItemId === right.workItemId
}
