import {
  IntakeCandidateNotFoundError,
  IntakeCandidateVersionConflictError,
  IntakeStateError,
  SourceViewConnectionError,
  SourceViewFilterError,
  SourceViewInUseError,
  SourceViewNotFoundError,
  SourceViewVersionConflictError,
  type IntakeCandidate,
  type SourceView,
} from "@claxedo/workgraph/hosted"
import {
  SourceIssueConfigurationError,
  SourceIssueProviderError,
  SourceIssueResponseError,
  SourceIssueTransportError,
  SourceIssueUnauthorizedError,
} from "@claxedo/workgraph/connectors"
import {
  CreateSourceViewInputSchema,
  IntakeCandidateDtoSchema,
  IntakeCandidatePageCursorError,
  IntakeCandidateListInputSchema,
  IntakeCandidatePageSchema,
  IntakeCandidateReadInputSchema,
  SourceViewVersionInputSchema,
  UpdateSourceViewInputSchema,
  type ConnectionID,
  type WorkGraphContext,
  type IntakeCandidateListInput,
  type IntakeCandidatePage,
} from "@claxedo/workgraph/contracts"
import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import {
  HostedConnectionCredentialUnavailableError,
  HostedConnectionReconnectRequiredError,
} from "./hosted-connections"

const syncInput = z.strictObject({ idempotencyKey: z.string().trim().min(1), summary: z.string().trim().min(1), status: z.string().trim().min(1).optional() })

type SourceViews = Readonly<{
  list(context: WorkGraphContext): Promise<readonly SourceView[]>
  create(context: WorkGraphContext, input: {
    teamConnectionId: ConnectionID
    provider: "github" | "linear" | "jira"
    providerUserId: string
    filters: Readonly<Record<string, string>>
    syncPolicy?: "silent" | "announce" | "full"
  }): Promise<SourceView>
  update(context: WorkGraphContext, id: string, input: z.infer<typeof UpdateSourceViewInputSchema>): Promise<SourceView>
  delete(context: WorkGraphContext, id: string, expectedVersion: number): Promise<SourceView>
}>

type Intake = Readonly<{
  refresh(context: WorkGraphContext, sourceViewId: string): Promise<{ created: number; updated: number; candidates: readonly IntakeCandidate[] }>
  read(context: WorkGraphContext, candidateId: string): Promise<IntakeCandidate | undefined>
  list(context: WorkGraphContext, sourceViewId?: string): Promise<readonly IntakeCandidate[]>
  page(context: WorkGraphContext, input: IntakeCandidateListInput): Promise<IntakeCandidatePage>
  stage(context: WorkGraphContext, candidateId: string): Promise<IntakeCandidate>
  dismiss(context: WorkGraphContext, candidateId: string, expectedVersion: number): Promise<IntakeCandidate>
  restore(context: WorkGraphContext, candidateId: string, expectedVersion: number): Promise<IntakeCandidate>
  syncExternal(context: WorkGraphContext, input: { candidateId: string; idempotencyKey: string; summary: string; status?: string }): Promise<unknown>
}>

export function createWorkGraphIntakeRouter(input: Readonly<{
  sourceViews: SourceViews
  intake: Intake
  resolveContext(request: Request): Promise<WorkGraphContext>
}>) {
  const router = new Hono<{ Variables: { workGraphContext: WorkGraphContext } }>()

  router.use("*", async (context, next) => {
    const resolved = await input.resolveContext(context.req.raw).catch(() => undefined)
    if (!resolved) return context.json({ error: { code: "unauthorized", message: "Trusted WorkGraph context is required", retryable: false } }, 401)
    context.set("workGraphContext", resolved)
    await next()
  })

  router.get("/source-views", async (context) => context.json({ sourceViews: await input.sourceViews.list(context.get("workGraphContext")) }))
  router.post("/source-views", async (context) => {
    const parsed = CreateSourceViewInputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid Source View", retryable: false } }, 400)
    try {
      return context.json(await input.sourceViews.create(context.get("workGraphContext"), {
        ...parsed.data,
        teamConnectionId: parsed.data.teamConnectionId as ConnectionID,
      }), 201)
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.put("/source-views/:sourceViewId", async (context) => {
    const parsed = UpdateSourceViewInputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid Source View update", retryable: false } }, 400)
    try {
      return context.json(await input.sourceViews.update(
        context.get("workGraphContext"),
        context.req.param("sourceViewId"),
        parsed.data,
      ))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.delete("/source-views/:sourceViewId", async (context) => {
    const parsed = SourceViewVersionInputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid Source View deletion", retryable: false } }, 400)
    try {
      return context.json(await input.sourceViews.delete(
        context.get("workGraphContext"),
        context.req.param("sourceViewId"),
        parsed.data.expectedVersion,
      ))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.post("/source-views/:sourceViewId/refresh", async (context) => {
    try {
      return context.json(await input.intake.refresh(context.get("workGraphContext"), context.req.param("sourceViewId")))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.get("/intake", async (context) => {
    const query = context.req.query()
    if (Object.keys(query).some((key) => !["sourceViewId", "after", "limit"].includes(key))) {
      return context.json({ error: { code: "validation_error", message: "Invalid Candidate page", retryable: false } }, 400)
    }
    const parsed = IntakeCandidateListInputSchema.safeParse({
      ...(query.sourceViewId === undefined ? {} : { sourceViewId: query.sourceViewId }),
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: Number(query.limit),
    })
    if (!parsed.success) {
      return context.json({ error: { code: "validation_error", message: "Invalid Candidate page", retryable: false } }, 400)
    }
    try {
      return context.json(IntakeCandidatePageSchema.parse(await input.intake.page(context.get("workGraphContext"), parsed.data)))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.get("/intake/:candidateId", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      return context.json({ error: { code: "validation_error", message: "Candidate reads do not accept query selectors", retryable: false } }, 400)
    }
    const parsed = IntakeCandidateReadInputSchema.safeParse({ candidateId: context.req.param("candidateId") })
    if (!parsed.success) {
      return context.json({ error: { code: "validation_error", message: "Invalid Candidate identifier", retryable: false } }, 400)
    }
    const candidate = await input.intake.read(context.get("workGraphContext"), parsed.data.candidateId)
    if (!candidate) return context.json({ error: { code: "not_found", message: "Candidate not found", retryable: false } }, 404)
    const result = IntakeCandidateDtoSchema.parse(candidate)
    if (result.ownerUserId !== context.get("workGraphContext").ownerUserId || result.id !== parsed.data.candidateId) {
      throw new Error("Candidate query crossed its trusted owner boundary")
    }
    return context.json(result)
  })
  router.post("/intake/:candidateId/stage", async (context) => {
    try {
      return context.json(await input.intake.stage(context.get("workGraphContext"), context.req.param("candidateId")))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.post("/intake/:candidateId/dismiss", async (context) => {
    const parsed = SourceViewVersionInputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid candidate dismissal", retryable: false } }, 400)
    try {
      return context.json(await input.intake.dismiss(
        context.get("workGraphContext"),
        context.req.param("candidateId"),
        parsed.data.expectedVersion,
      ))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.post("/intake/:candidateId/restore", async (context) => {
    const parsed = SourceViewVersionInputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid candidate restoration", retryable: false } }, 400)
    try {
      return context.json(await input.intake.restore(
        context.get("workGraphContext"),
        context.req.param("candidateId"),
        parsed.data.expectedVersion,
      ))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })
  router.post("/intake/:candidateId/sync", async (context) => {
    const parsed = syncInput.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: { code: "validation_error", message: "Invalid intake sync", retryable: false } }, 400)
    try {
      return context.json(await input.intake.syncExternal(context.get("workGraphContext"), { candidateId: context.req.param("candidateId"), ...parsed.data }))
    } catch (error) {
      const failure = intakeFailure(error)
      return context.json({ error: failure.error }, failure.status)
    }
  })

  return router
}

function intakeFailure(error: unknown): Readonly<{
  status: ContentfulStatusCode
  error: Readonly<{ code: string; message: string; retryable: boolean }>
}> {
  if (error instanceof SourceViewFilterError) {
    return { status: 400, error: { code: error.code, message: "Source View input is invalid", retryable: false } }
  }
  if (isSourceViewConnectionError(error)) {
    return { status: 409, error: { code: "source_view_connection_unavailable", message: "Source View Connection is unavailable", retryable: false } }
  }
  if (error instanceof SourceViewNotFoundError) {
    return { status: 404, error: { code: error.code, message: "Source View not found", retryable: false } }
  }
  if (error instanceof SourceViewVersionConflictError) {
    return { status: 409, error: { code: error.code, message: "Source View version changed", retryable: false } }
  }
  if (error instanceof SourceViewInUseError) {
    return { status: 409, error: { code: error.code, message: "Source View still has active candidates", retryable: false } }
  }
  if (error instanceof IntakeCandidateNotFoundError) {
    return { status: 404, error: { code: error.code, message: "Candidate not found", retryable: false } }
  }
  if (error instanceof IntakeCandidateVersionConflictError) {
    return { status: 409, error: { code: error.code, message: "Candidate version changed", retryable: false } }
  }
  if (error instanceof IntakeCandidatePageCursorError) {
    return { status: 409, error: { code: error.code, message: "Candidate page cursor is no longer valid", retryable: false } }
  }
  if (error instanceof IntakeStateError) {
    return { status: 409, error: { code: error.code, message: "Candidate state does not allow this action", retryable: false } }
  }
  if (error instanceof SourceIssueConfigurationError) {
    return {
      status: 409,
      error: {
        code: error.code,
        message: "Source issue provider configuration is required",
        retryable: false,
      },
    }
  }
  if (error instanceof SourceIssueUnauthorizedError) {
    return {
      status: 401,
      error: {
        code: error.code,
        message: "Source issue provider authorization failed",
        retryable: false,
      },
    }
  }
  if (error instanceof SourceIssueResponseError) {
    return {
      status: 502,
      error: {
        code: "source_issue_response_invalid",
        message: "Source issue provider returned an invalid response",
        retryable: true,
      },
    }
  }
  if (error instanceof SourceIssueProviderError) {
    return {
      status: error.status as ContentfulStatusCode,
      error: {
        code: error.code,
        message: "Source issue provider request failed",
        retryable: error.retryable,
      },
    }
  }
  if (error instanceof SourceIssueTransportError) {
    return {
      status: 503,
      error: {
        code: error.code,
        message: "Source issue provider transport is unavailable",
        retryable: error.retryable,
      },
    }
  }
  if (error instanceof HostedConnectionReconnectRequiredError) {
    return {
      status: error.status,
      error: {
        code: error.code,
        message: "Connection requires reconnect",
        retryable: false,
      },
    }
  }
  if (error instanceof HostedConnectionCredentialUnavailableError) {
    return {
      status: 503,
      error: {
        code: error.code,
        message: "Connection credential is unavailable",
        retryable: true,
      },
    }
  }
  throw error
}

function isSourceViewConnectionError(error: unknown) {
  if (error instanceof SourceViewConnectionError) return true
  return typeof error === "object" && error !== null && "code" in error && error.code === "source_view_connection_unavailable"
}
