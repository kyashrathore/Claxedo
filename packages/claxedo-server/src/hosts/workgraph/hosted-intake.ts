import {
  createGitHubSourceIssueConnector,
  createIntakeService,
  createJiraSourceIssueConnector,
  createLinearSourceIssueConnector,
  createSourceViewService,
  createWebhookIntakeService,
  type ExternalIntakeCandidate,
  type IntakeCandidate,
  type IntakeCandidateStore,
  type IntakeReceiptStore,
  type SourceView,
  type SourceViewStore,
  type WebhookIntakeStore,
} from "@claxedo/workgraph/hosted"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import {
  IntakeCandidatePageCursorError,
  IntakeCandidatePageSchema,
  SourceViewTargetSchema,
  type AdmissionProposalID,
  type CommandResult,
  type IntakeCandidatePageCursorErrorReason,
  type WorkGraphCommandRequest,
  type WorkGraphContext,
  type WorkSourceRevisionRef,
} from "@claxedo/workgraph/contracts"
import { hostedOrgCredentials } from "../../authority/worker-credentials"
import type { HostedWorkerEnv } from "../../authority/adapters/worker/hosted-compose"
import { createHostedWorkGraphConnectionsPort, type HostedConnectionMetadata } from "./hosted-connections"
import { workGraphConvexApi } from "./convex-api"
import { createWorkGraphIntakeRouter } from "./intake-router"
import { createWorkGraphWebhookRouter } from "./webhook-router"

type Executor = Readonly<{
  query(fn: unknown, args: Record<string, unknown>): Promise<unknown>
  mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>
}>

export function createHostedWorkGraphIntake(input: Readonly<{
  env: HostedWorkerEnv
  serviceToken: string
  executor: Executor
  service: Readonly<{ execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult> }>
  resolveContext(request: Request): Promise<WorkGraphContext>
  webhookVerifier?: ConnectionWebhookVerifier
}>) {
  const read = (context: WorkGraphContext, query: Record<string, unknown>) => input.executor.query(
    workGraphConvexApi.workgraphIntake.readForService,
    { service_token: input.serviceToken, organization_id: context.organizationId, owner_subject: context.ownerUserId, query },
  )
  const execute = (context: WorkGraphContext, operation: Record<string, unknown>) => input.executor.mutation(
    workGraphConvexApi.workgraphIntake.executeForService,
    { service_token: input.serviceToken, organization_id: context.organizationId, owner_subject: context.ownerUserId, operation },
  )
  const sourceViews: SourceViewStore = {
    async create(context, view) {
      return ownedSourceView(await execute(context, { type: "create_source_view", orgId: context.organizationId, view }), context)
    },
    async read(context, id) {
      const value = await read(context, { kind: "source_view", sourceViewId: id })
      return value === null ? undefined : ownedSourceView(value, context)
    },
    async list(context) {
      return recordArray(record(await read(context, { kind: "source_views" }), "Source View result").sourceViews, "sourceViews")
        .map((value) => ownedSourceView(value, context))
    },
    async update(context, id, request) {
      return sourceViewMutation(await execute(context, {
        type: "update_source_view",
        sourceViewId: id,
        ...request,
      }), context)
    },
    async delete(context, id, request) {
      return sourceViewMutation(await execute(context, {
        type: "delete_source_view",
        sourceViewId: id,
        ...request,
      }), context)
    },
  }
  const candidates: IntakeCandidateStore = {
    async upsertExternal(context, request) {
      const result = record(await execute(context, { type: "upsert_external", ...request }), "candidate upsert result")
      return { candidate: ownedCandidate(result.candidate, context, "external_issue"), created: boolean(result.created, "created") }
    },
    async read(context, id) {
      const value = await read(context, { kind: "candidate", candidateId: id })
      return value === null ? undefined : ownedCandidate(value, context)
    },
    async list(context, sourceViewId) {
      const result = record(await read(context, { kind: "candidates", ...(sourceViewId ? { sourceViewId } : {}) }), "candidate result")
      return recordArray(result.candidates, "candidates").map((value) => ownedCandidate(value, context))
    },
    async page(context, request) {
      try {
        const result = IntakeCandidatePageSchema.parse(await read(context, {
          kind: "candidate_page",
          ...request,
        }))
        return {
          ...result,
          candidates: result.candidates.map((value) => ownedCandidate(value, context)),
        }
      } catch (error) {
        const reason = candidateCursorErrorReason(error)
        if (reason) throw new IntakeCandidatePageCursorError(reason)
        throw error
      }
    },
    async prepareStage(context, id, draft) {
      const result = record(await execute(context, { type: "prepare_stage_candidate", candidateId: id, draft, now: Date.now() }), "candidate stage preparation")
      const frozen = record(result.draft, "candidate stage draft")
      return {
        candidate: ownedCandidate(result.candidate, context),
        draft: { title: requiredString(frozen.title, "draft.title"), content: requiredString(frozen.content, "draft.content") },
      }
    },
    async stage(context, id, admission) {
      return ownedCandidate(await execute(context, { type: "stage_candidate", candidateId: id, ...admission, now: Date.now() }), context)
    },
    async transition(context, id, request) {
      return candidateMutation(await execute(context, {
        type: "transition_candidate",
        candidateId: id,
        ...request,
      }), context)
    },
  }
  const receipts: IntakeReceiptStore = {
    async begin(context, receipt) {
      return await execute(context, { type: "begin_receipt", ...receipt, now: Date.now() }) as Awaited<ReturnType<IntakeReceiptStore["begin"]>>
    },
    async complete(context, receipt) {
      await execute(context, { type: "complete_receipt", ...receipt, now: Date.now() })
    },
    async fail(context, receipt) {
      await execute(context, { type: "fail_receipt", ...receipt, now: Date.now() })
    },
  }
  const connections = createHostedWorkGraphConnectionsPort({
    async resolveMetadata(context, connectionIds) {
      const rows = await Promise.all(connectionIds.map(async (connectionId) => {
        const value = await read(context, { kind: "connection", connectionId })
        return value === null ? undefined : ownedConnection(value, context)
      }))
      const metadata = rows.filter((row): row is HostedConnectionMetadata => !!row)
      return metadata
    },
    credentials: (orgId) => hostedOrgCredentials(orgId, input.env),
  })
  const sourceViewService = createSourceViewService({
    store: sourceViews,
    connections,
    ids: { next: () => `source_view_${crypto.randomUUID()}` },
  })
  const connectors = [
    createGitHubSourceIssueConnector(),
    createLinearSourceIssueConnector(),
    createJiraSourceIssueConnector(),
  ]
  const intake = createIntakeService({
    sourceViews,
    candidates,
    receipts,
    connections,
    connectors: { get: (provider) => connectors.find((connector) => connector.provider === provider) },
    ids: { next: () => `intake_${crypto.randomUUID()}` },
    commands: input.service,
  })
  const webhookStore: WebhookIntakeStore = {
    async begin(signal) {
      return await input.executor.mutation(workGraphConvexApi.workgraphIntake.executeWebhookForService, {
        service_token: input.serviceToken,
        operation: { type: "begin_webhook", ...signal, now: Date.now() },
      }) as Awaited<ReturnType<WebhookIntakeStore["begin"]>>
    },
    async listSourceViews(request) {
      const result = record(await input.executor.query(workGraphConvexApi.workgraphIntake.readWebhookForService, {
        service_token: input.serviceToken,
        query: { kind: "source_views", ...request },
      }), "webhook Source View result")
      return recordArray(result.sourceViews, "sourceViews").map((value) => sourceView(value))
    },
    async complete(signal, leaseId) {
      return await input.executor.mutation(workGraphConvexApi.workgraphIntake.executeWebhookForService, {
        service_token: input.serviceToken,
        operation: { type: "complete_webhook", ...signal, leaseId, now: Date.now() },
      }) as boolean
    },
    async fail(signal, leaseId) {
      return await input.executor.mutation(workGraphConvexApi.workgraphIntake.executeWebhookForService, {
        service_token: input.serviceToken,
        operation: { type: "fail_webhook", ...signal, leaseId, now: Date.now() },
      }) as boolean
    },
  }
  const webhooks = createWebhookIntakeService({ store: webhookStore, refresh: intake.refresh })
  return {
    router: createWorkGraphIntakeRouter({ sourceViews: sourceViewService, intake, resolveContext: input.resolveContext }),
    sourceViews: sourceViewService,
    intake,
    webhooks,
    ...(input.webhookVerifier ? {
      webhookRouter: createWorkGraphWebhookRouter({
        verifier: input.webhookVerifier,
        intake: webhooks,
        resolveOrganizationId: async (connectionId) => {
          const value = await input.executor.query(workGraphConvexApi.workgraphConnections.resolveWebhookMetadata, {
            service_token: input.serviceToken,
            connectionId,
          })
          if (!value || typeof value !== "object" || Array.isArray(value)) return
          const orgId = (value as Record<string, unknown>).orgId
          return typeof orgId === "string" && orgId.trim() ? orgId.trim() : undefined
        },
      }),
    } : {}),
  }
}

function sourceView(value: unknown): SourceView {
  const row = record(value, "Source View")
  return {
    id: requiredString(row.id, "id"),
    ownerUserId: requiredString(row.ownerUserId, "ownerUserId"),
    version: positiveInteger(row.version, "version"),
    teamConnectionId: requiredString(row.teamConnectionId, "teamConnectionId") as SourceView["teamConnectionId"],
    provider: provider(row.provider),
    providerUserId: requiredString(row.providerUserId, "providerUserId"),
    filters: stringRecord(row.filters, "filters"),
    ...(row.target === undefined ? {} : { target: SourceViewTargetSchema.parse(row.target) }),
    syncPolicy: syncPolicy(row.syncPolicy),
    status: row.status === "paused" ? "paused" : row.status === "active" ? "active" : invalid("status"),
    createdAt: number(row.createdAt, "createdAt"),
    updatedAt: number(row.updatedAt, "updatedAt"),
  }
}

function ownedSourceView(value: unknown, context: WorkGraphContext): SourceView {
  const row = record(value, "Source View")
  return {
    id: requiredString(row.id, "id"),
    ownerUserId: context.ownerUserId,
    version: positiveInteger(row.version, "version"),
    teamConnectionId: requiredString(row.teamConnectionId, "teamConnectionId") as SourceView["teamConnectionId"],
    provider: provider(row.provider),
    providerUserId: requiredString(row.providerUserId, "providerUserId"),
    filters: stringRecord(row.filters, "filters"),
    ...(row.target === undefined ? {} : { target: SourceViewTargetSchema.parse(row.target) }),
    syncPolicy: syncPolicy(row.syncPolicy),
    status: row.status === "paused" ? "paused" : row.status === "active" ? "active" : invalid("status"),
    createdAt: number(row.createdAt, "createdAt"),
    updatedAt: number(row.updatedAt, "updatedAt"),
  }
}

function ownedCandidate(value: unknown, context: WorkGraphContext, expected: "external_issue"): ExternalIntakeCandidate
function ownedCandidate(value: unknown, context: WorkGraphContext): IntakeCandidate
function ownedCandidate(value: unknown, context: WorkGraphContext, expected?: "external_issue"): IntakeCandidate {
  const row = record(value, "Intake candidate")
  const common = {
    id: requiredString(row.id, "id"),
    ownerUserId: context.ownerUserId,
    version: positiveInteger(row.version, "version"),
    title: requiredString(row.title, "title"),
    body: string(row.body, "body"),
    ...(row.observedRevision === undefined ? {} : { observedRevision: requiredString(row.observedRevision, "observedRevision") }),
    state: candidateState(row.state),
    ...(row.source === undefined ? {} : { source: sourceReference(row.source) }),
    ...(row.admissionProposalId === undefined ? {} : { admissionProposalId: requiredString(row.admissionProposalId, "admissionProposalId") as AdmissionProposalID }),
    createdAt: number(row.createdAt, "createdAt"),
    updatedAt: number(row.updatedAt, "updatedAt"),
  } as const
  if (row.candidateKind === "session") {
    if (expected) throw new Error("External candidate upsert returned a Session candidate")
    return { ...common, candidateKind: "session", sessionId: requiredString(row.sessionId, "sessionId") }
  }
  if (row.candidateKind !== "external_issue") throw new Error("Unsupported intake candidate kind")
  return {
    ...common,
    candidateKind: "external_issue",
    sourceViewId: requiredString(row.sourceViewId, "sourceViewId"),
    provider: provider(row.provider),
    externalId: requiredString(row.externalId, "externalId"),
    ...(row.externalKey === undefined ? {} : { externalKey: requiredString(row.externalKey, "externalKey") }),
    ...(row.externalUrl === undefined ? {} : { externalUrl: requiredString(row.externalUrl, "externalUrl") }),
    externalStatus: requiredString(row.externalStatus, "externalStatus"),
  } satisfies ExternalIntakeCandidate
}

function sourceReference(value: unknown): WorkSourceRevisionRef {
  const row = record(value, "candidate source")
  return {
    workSourceId: requiredString(row.workSourceId, "source.workSourceId") as WorkSourceRevisionRef["workSourceId"],
    revisionId: requiredString(row.revisionId, "source.revisionId") as WorkSourceRevisionRef["revisionId"],
    contentHash: requiredString(row.contentHash, "source.contentHash") as WorkSourceRevisionRef["contentHash"],
  }
}

function ownedConnection(value: unknown, context: WorkGraphContext): HostedConnectionMetadata {
  const row = record(value, "Connection metadata")
  return {
    id: requiredString(row.id, "connection.id") as HostedConnectionMetadata["id"],
    ownerUserId: context.ownerUserId,
    orgId: requiredString(row.orgId, "connection.orgId"),
    integrationId: provider(row.integrationId),
    capabilities: stringArray(row.capabilities, "connection.capabilities"),
    status: connectionStatus(row.status),
    ...(row.tokenType === undefined ? {} : { tokenType: tokenType(row.tokenType) }),
    ...(row.fields === undefined ? {} : { fields: stringRecord(row.fields, "connection.fields") }),
    ...(row.accountLabel === undefined ? {} : { accountLabel: requiredString(row.accountLabel, "connection.accountLabel") }),
  }
}

function sourceViewMutation(value: unknown, context: WorkGraphContext): Awaited<ReturnType<SourceViewStore["update"]>> {
  const result = record(value, "Source View mutation")
  if (result.ok === true) return { ok: true, view: ownedSourceView(result.view, context) }
  if (result.ok !== false) throw new Error("Source View mutation result must identify success")
  if (result.reason === "not_found" || result.reason === "version_conflict" || result.reason === "in_use") {
    return { ok: false, reason: result.reason }
  }
  throw new Error("Source View mutation result has an unsupported reason")
}

function candidateMutation(value: unknown, context: WorkGraphContext): Awaited<ReturnType<IntakeCandidateStore["transition"]>> {
  const result = record(value, "candidate mutation")
  if (result.ok === true) return { ok: true, candidate: ownedCandidate(result.candidate, context) }
  if (result.ok !== false) throw new Error("Candidate mutation result must identify success")
  if (result.reason === "not_found" || result.reason === "version_conflict" || result.reason === "invalid_state") {
    return { ok: false, reason: result.reason }
  }
  throw new Error("Candidate mutation result has an unsupported reason")
}

function candidateCursorErrorReason(error: unknown): IntakeCandidatePageCursorErrorReason | undefined {
  if (error instanceof IntakeCandidatePageCursorError) return error.reason
  if (candidateCursorErrorData(error)) return error.reason
  if (!error || typeof error !== "object" || !("data" in error) || !candidateCursorErrorData(error.data)) return
  return error.data.reason
}

function candidateCursorErrorData(value: unknown): value is Readonly<{
  code: "cursor_invalid"
  reason: IntakeCandidatePageCursorErrorReason
}> {
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "cursor_invalid" || !("reason" in value)) return false
  return value.reason === "invalid" || value.reason === "owner_mismatch" || value.reason === "source_view_mismatch"
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function recordArray(value: unknown, name: string) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

function requiredString(value: unknown, name: string) {
  const result = string(value, name).trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

function number(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

function positiveInteger(value: unknown, name: string) {
  const result = number(value, name)
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`)
  return value as string[]
}

function stringRecord(value: unknown, name: string) {
  const result = record(value, name)
  if (Object.values(result).some((item) => typeof item !== "string")) throw new Error(`${name} must contain strings`)
  return result as Record<string, string>
}

function provider(value: unknown) {
  if (value === "github" || value === "linear" || value === "jira") return value
  throw new Error("Unsupported Source View provider")
}

function syncPolicy(value: unknown) {
  if (value === "silent" || value === "announce" || value === "full") return value
  throw new Error("Unsupported sync policy")
}

function candidateState(value: unknown) {
  if (value === "unorganized" || value === "staged" || value === "confirmed" || value === "dismissed") return value
  throw new Error("Unsupported candidate state")
}

function connectionStatus(value: unknown) {
  if (value === "connected" || value === "degraded" || value === "broken") return value
  throw new Error("Unsupported Connection status")
}

function tokenType(value: unknown) {
  if (value === "bearer" || value === "basic") return value
  throw new Error("Unsupported Connection token type")
}

function invalid(name: string): never {
  throw new Error(`Unsupported ${name}`)
}
