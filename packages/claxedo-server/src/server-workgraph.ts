import type { Hono as HonoType } from "hono"
import { Hono } from "hono"
import path from "node:path"
import type BetterSqlite3 from "better-sqlite3"
import {
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  jiraConnectionWebhookVerifier,
  linearConnectionWebhookVerifier,
  type ConnectionsService,
  type ConnectionWebhookVerifier,
} from "@claxedo/connections"
import type { ExecutionCapabilitiesPort, WorkspaceExecutionPort } from "@claxedo/workgraph"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "./control-plane/auth"
import type { WorkspaceAuthority } from "./control-plane/authority"
import type { WorkGraphSessionGateway } from "./workgraph-host/local-execution"
import type { ControlPlaneTelemetry } from "./control-plane/services"
import {
  createWorkGraphOperationalReporter,
  instrumentWorkGraphCommands,
  workGraphHttpTelemetry,
} from "./workgraph-host/operational-telemetry"

export type LocalWorkGraphAuthOptions = Readonly<{
  authConfig: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  authority?: WorkspaceAuthority
}>

export type LocalEmbeddedWorkGraph = Awaited<ReturnType<typeof createLocalEmbeddedWorkGraph>>

export class LocalWorkGraphRepositoryDirectoryRequiredError extends Error {
  readonly code = "local_workgraph_repository_directory_required"
  readonly retryable = false

  constructor() {
    super("Local WorkGraph requires CLAXEDO_WORKGRAPH_REPOSITORY to be an absolute repository directory")
    this.name = "LocalWorkGraphRepositoryDirectoryRequiredError"
  }
}

export function requireLocalWorkGraphRepositoryDirectory(value: string | undefined) {
  const directory = value?.trim()
  if (!directory || !path.isAbsolute(directory)) throw new LocalWorkGraphRepositoryDirectoryRequiredError()
  return path.normalize(directory)
}

/**
 * Compose WorkGraph v2 inside the Claxedo server process over a caller-owned
 * SQLite handle. Internal consumers use `service` directly; only northbound
 * clients cross the Hono router.
 */
export async function createLocalEmbeddedWorkGraph(
  input: Readonly<{
    database: BetterSqlite3.Database
    auth?: LocalWorkGraphAuthOptions
    execution: WorkspaceExecutionPort
    executionCapabilities?: ExecutionCapabilitiesPort
    recaps?: Readonly<{
      sessions?: WorkGraphSessionGateway
      directory?: string
      clock?: Readonly<{ now(): number }>
    }>
    sourcePlanning?: Readonly<{
      sessions: WorkGraphSessionGateway
      directory: string
    }>
    connections?: ConnectionsService
    sourceIssueConnectors?: readonly SourceIssueConnector[]
    resolveTeamOwner?: (context: WorkGraphContext) => string | undefined
    webhookVerifier?: ConnectionWebhookVerifier
    telemetry?: ControlPlaneTelemetry
  }>,
) {
  const workgraph = await import("@claxedo/workgraph")
  const adapter = workgraph.createSqliteWorkGraphService({
    database: input.database,
    execution: input.execution,
    ...(input.executionCapabilities ? { executionCapabilities: input.executionCapabilities } : {}),
  })
  const operationalTelemetry = input.telemetry
    ? createWorkGraphOperationalReporter({ telemetry: input.telemetry, env: process.env })
    : undefined
  const service = operationalTelemetry
    ? instrumentWorkGraphCommands(adapter.service, operationalTelemetry)
    : adapter.service
  const recaps = workgraph.createSqliteRecapRuntime({
    database: input.database,
    ...(input.recaps?.clock ? { clock: input.recaps.clock } : {}),
    ...(input.recaps?.sessions
      ? {
          sessions: input.recaps.sessions,
          ...(input.recaps.directory ? { sessionDirectory: input.recaps.directory } : {}),
        }
      : {}),
  })
  const sourcePlanning = workgraph.createSqliteSourcePlanningRuntime({
    database: input.database,
    ...(input.sourcePlanning
      ? {
          sessions: input.sourcePlanning.sessions,
          sessionDirectory: input.sourcePlanning.directory,
        }
      : {}),
  })
  const sessionIntake = workgraph.createSqliteSessionIntakePort(input.database)
  const notifications = workgraph.createNotificationService(workgraph.createSqliteNotificationStore(input.database))
  const attentionAcknowledgements = workgraph.createAttentionAcknowledgementService(
    workgraph.createSqliteAttentionAcknowledgementStore(input.database),
  )
  const archive = workgraph.createSqliteWorkGraphArchivePort(
    input.database,
    undefined,
    input.connections
      ? {
          connectionAvailable: async (context, connectionId) => {
            const connection = await input.connections!.getById(connectionId)
            return !!connection && connection.owner === (input.resolveTeamOwner ?? (() => undefined))(context)
          },
        }
      : undefined,
  )
  const deletion = workgraph.createSqliteWorkGraphOwnerDeletionPort(input.database, input.execution)
  const webhookVerifier =
    input.webhookVerifier ??
    (input.connections
      ? createConnectionWebhookVerifier({
          resolve: async (connectionId) => {
            const connection = await input.connections!.getById(connectionId)
            const provider = connection?.integrationId === "atlassian" ? "jira" : connection?.integrationId
            if (provider !== "github" && provider !== "linear" && provider !== "jira") return undefined
            const secret = await input.connections!.resolveWebhookSigningSecret(connectionId, provider)
            return secret ? { provider, secret } : undefined
          },
          providers: {
            github: githubConnectionWebhookVerifier(),
            linear: linearConnectionWebhookVerifier(),
            jira: jiraConnectionWebhookVerifier(),
          },
        })
      : undefined)
  const resolveContext = async (request: Request): Promise<WorkGraphContext> => {
    const auth = await controlPlaneAuthContext(
      request,
      input.auth
        ? { config: input.auth.authConfig, ...(input.auth.verifier ? { verifier: input.auth.verifier } : {}) }
        : undefined,
    )
    const ownerUserId = auth.mode === "signed" ? auth.user.subject : "local"
    const organizationId =
      auth.mode === "signed" ? await resolveSignedOrganizationId(input.auth?.authority, auth) : "local"
    return {
      organizationId: organizationId as never,
      ownerUserId: ownerUserId as never,
      actor: { type: "user" as const, id: ownerUserId as never },
      requestId: (request.headers.get("x-request-id")?.trim() || crypto.randomUUID()) as never,
      access: { mode: "owner" as const },
    }
  }
  const authenticated = workgraph.createWorkGraphHttpRouter({
    service,
    resolveContext,
    notifications,
    attentionAcknowledgements,
    archive,
    deletion,
    ...(input.executionCapabilities ? { executionCapabilities: input.executionCapabilities } : {}),
  })
  const intake = input.connections
    ? await import("./workgraph-host/intake").then((host) =>
        host.createWorkGraphIntakeHost({
          database: input.database,
          service,
          connections: input.connections!,
          resolveContext,
          resolveTeamOwner: input.resolveTeamOwner ?? (() => undefined),
          ...(input.sourceIssueConnectors ? { sourceIssueConnectors: input.sourceIssueConnectors } : {}),
          ...(webhookVerifier ? { webhookVerifier } : {}),
        }),
      )
    : undefined
  if (intake) authenticated.route("/", intake.router)
  const router = new Hono()
  if (operationalTelemetry) router.use("*", workGraphHttpTelemetry(operationalTelemetry))
  if (intake?.webhookRouter) router.route("/", intake.webhookRouter)
  router.route("/", authenticated)
  const reconcile = async (context: WorkGraphContext) => {
    const startedAt = Date.now()
    const attempts = workgraph.listSqliteReconcilableAttempts(input.database, context)
    try {
      const results = await Promise.all(
        attempts.map(async (attempt) => {
          const renewal = await adapter.attemptRuntime.renewLease(context, {
            attemptId: attempt.attemptId,
            expectedLeaseEpoch: attempt.leaseEpoch,
            occurredAt: Date.now(),
            durationMs: 300_000,
          })
          if (!renewal) return { settled: false as const }
          const result = await input.execution.result(context, {
            attemptId: attempt.attemptId,
            sessionId: attempt.sessionId,
          })
          if (result.state === "pending" || result.state === "running") return { settled: false as const }
          return workgraph.recordSemanticAttemptResult(
            context,
            { ...attempt, leaseEpoch: renewal.leaseEpoch },
            result,
            adapter.attemptResults,
          )
        }),
      )
      operationalTelemetry?.queue({
        kind: "attempt",
        backlog: attempts.length,
        oldestAgeMs: 0,
        failed: results.filter((result) => result.settled && "state" in result && result.state === "failed").length,
        retried: 0,
        expiredRecoveries: 0,
        activeLeaseAgeMs: 0,
      })
      operationalTelemetry?.reconciliation({
        outcome: "succeeded",
        latencyMs: Date.now() - startedAt,
        lagMs: 0,
        claimed: attempts.length,
        running: results.filter((result) => !result.settled).length,
        settled: results.filter((result) => result.settled).length,
        failed: results.filter((result) => result.settled && "state" in result && result.state === "failed").length,
      })
      return results
    } catch (error) {
      operationalTelemetry?.reconciliation({
        outcome: "failed",
        latencyMs: Date.now() - startedAt,
        lagMs: 0,
        claimed: attempts.length,
        running: 0,
        settled: 0,
        failed: 1,
      })
      throw error
    }
  }
  return {
    database: input.database,
    service,
    router,
    resolveContext,
    reconcile,
    recaps,
    sourcePlanning,
    sessionIntake,
    notifications,
    attentionAcknowledgements,
    archive,
    deletion,
    intake,
    executionCapabilities: input.executionCapabilities,
    operationalTelemetry,
  }
}

async function resolveSignedOrganizationId(
  authority: WorkspaceAuthority | undefined,
  auth: Extract<Awaited<ReturnType<typeof controlPlaneAuthContext>>, { mode: "signed" }>,
) {
  if (authority) {
    try {
      const organizationId = await authority.resolveOrgId(auth)
      if (typeof organizationId === "string" && organizationId.trim()) return organizationId.trim()
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) throw error
    }
  }
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "WorkGraph organization identity is unavailable",
  )
}

export function mountEmbeddedWorkGraph(app: HonoType, embedded: LocalEmbeddedWorkGraph) {
  app.route("/api/workgraph", embedded.router)
}

export function mountLazyEmbeddedWorkGraph(app: HonoType, load: () => Promise<LocalEmbeddedWorkGraph>) {
  let loaded: Promise<LocalEmbeddedWorkGraph> | undefined
  const forward = (request: Request) =>
    (loaded ??= load()).then((embedded) => embedded.router.fetch(workgraphRequest(request, "/api/workgraph")))
  app.all("/api/workgraph", (context) => forward(context.req.raw))
  app.all("/api/workgraph/*", (context) => forward(context.req.raw))
}

function workgraphRequest(request: Request, mountPath: string) {
  const url = new URL(request.url)
  url.pathname = url.pathname === mountPath ? "/" : url.pathname.slice(mountPath.length)
  return new Request(url, request)
}
