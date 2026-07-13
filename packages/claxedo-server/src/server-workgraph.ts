import type { Hono as HonoType } from "hono"
import { Hono } from "hono"
import type BetterSqlite3 from "better-sqlite3"
import {
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  type ConnectionsService,
  type ConnectionWebhookVerifier,
} from "@claxedo/connections"
import type { ExecutionCapabilitiesPort, WorkspaceExecutionPort } from "@claxedo/workgraph"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import {
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "./control-plane/auth"
import type { WorkGraphSessionGateway } from "./workgraph-host/local-execution"

export type LocalWorkGraphAuthOptions = Readonly<{
  authConfig: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}>

export type LocalEmbeddedWorkGraph = Awaited<ReturnType<typeof createLocalEmbeddedWorkGraph>>

/**
 * Compose WorkGraph v2 inside the Claxedo server process over a caller-owned
 * SQLite handle. Internal consumers use `service` directly; only northbound
 * clients cross the Hono router.
 */
export async function createLocalEmbeddedWorkGraph(input: Readonly<{
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
}>) {
  const workgraph = await import("@claxedo/workgraph")
  const adapter = workgraph.createSqliteWorkGraphService({ database: input.database, execution: input.execution })
  const recaps = workgraph.createSqliteRecapRuntime({
    database: input.database,
    ...(input.recaps?.clock ? { clock: input.recaps.clock } : {}),
    ...(input.recaps?.sessions ? {
      sessions: input.recaps.sessions,
      sessionDirectory: input.recaps.directory ?? process.cwd(),
    } : {}),
  })
  const sourcePlanning = workgraph.createSqliteSourcePlanningRuntime({
    database: input.database,
    ...(input.sourcePlanning ? {
      sessions: input.sourcePlanning.sessions,
      sessionDirectory: input.sourcePlanning.directory,
    } : {}),
  })
  const sessionIntake = workgraph.createSqliteSessionIntakePort(input.database)
  const notifications = workgraph.createNotificationService(workgraph.createSqliteNotificationStore(input.database))
  const archive = workgraph.createSqliteWorkGraphArchivePort(input.database, undefined, input.connections ? {
    connectionAvailable: async (context, connectionId) => {
      const connection = await input.connections!.getById(connectionId)
      return !!connection && connection.owner === (input.resolveTeamOwner ?? (() => undefined))(context)
    },
  } : undefined)
  const deletion = workgraph.createSqliteWorkGraphOwnerDeletionPort(input.database, input.execution)
  const webhookVerifier = input.webhookVerifier ?? (input.connections ? createConnectionWebhookVerifier({
    resolve: async (connectionId) => {
      const secret = await input.connections!.resolveWebhookSigningSecret(connectionId, "github")
      return secret ? { provider: "github", secret } : undefined
    },
    providers: { github: githubConnectionWebhookVerifier() },
  }) : undefined)
  const resolveContext = async (request: Request): Promise<WorkGraphContext> => {
    const auth = await controlPlaneAuthContext(request, input.auth
      ? { config: input.auth.authConfig, ...(input.auth.verifier ? { verifier: input.auth.verifier } : {}) }
      : undefined)
    const ownerUserId = auth.mode === "signed" ? auth.user.subject : "local"
    return {
      ownerUserId: ownerUserId as never,
      actor: { type: "user" as const, id: ownerUserId as never },
      requestId: (request.headers.get("x-request-id")?.trim() || crypto.randomUUID()) as never,
      access: { mode: "owner" as const },
    }
  }
  const authenticated = workgraph.createWorkGraphHttpRouter({
    service: adapter.service,
    resolveContext,
    notifications,
    archive,
    deletion,
    ...(input.executionCapabilities ? { executionCapabilities: input.executionCapabilities } : {}),
  })
  const intake = input.connections
    ? await import("./workgraph-host/intake").then((host) => host.createWorkGraphIntakeHost({
        database: input.database,
        service: adapter.service,
        connections: input.connections!,
        resolveContext,
        resolveTeamOwner: input.resolveTeamOwner ?? (() => undefined),
        ...(input.sourceIssueConnectors ? { sourceIssueConnectors: input.sourceIssueConnectors } : {}),
        ...(webhookVerifier ? { webhookVerifier } : {}),
      }))
    : undefined
  if (intake) authenticated.route("/", intake.router)
  const router = new Hono()
  if (intake?.webhookRouter) router.route("/", intake.webhookRouter)
  router.route("/", authenticated)
  const reconcile = async (context: WorkGraphContext) => {
    return Promise.all(workgraph.listSqliteReconcilableAttempts(input.database, context).map(async (attempt) => {
      const renewal = await adapter.attemptRuntime.renewLease(context, {
        attemptId: attempt.attemptId,
        expectedLeaseEpoch: attempt.leaseEpoch,
        occurredAt: Date.now(),
        durationMs: 300_000,
      })
      if (!renewal) return { settled: false as const }
      const result = await input.execution.result(context, { attemptId: attempt.attemptId, sessionId: attempt.sessionId })
      if (result.state === "pending" || result.state === "running") return { settled: false as const }
      const terminal = result.state === "succeeded"
        ? await input.execution.integrateResult(context, {
            streamId: attempt.streamId,
            workItemId: attempt.workItemId,
            attemptId: attempt.attemptId,
            sessionId: attempt.sessionId,
            envelopeId: attempt.envelopeId,
            ...(attempt.childIsolationId ? { childIsolationId: attempt.childIsolationId as never } : {}),
            profile: JSON.parse(attempt.profileJson),
            result,
          }).then((integrated) => ({ state: "succeeded" as const, ...integrated }))
        : result
      return workgraph.recordSemanticAttemptResult(
        context,
        { ...attempt, leaseEpoch: renewal.leaseEpoch },
        terminal,
        adapter.attemptResults,
      )
    }))
  }
  return { database: input.database, service: adapter.service, router, resolveContext, reconcile, recaps, sourcePlanning, sessionIntake, notifications, archive, deletion, intake }
}

export function mountEmbeddedWorkGraph(app: HonoType, embedded: LocalEmbeddedWorkGraph) {
  app.route("/api/workgraph", embedded.router)
}

export function mountLazyEmbeddedWorkGraph(
  app: HonoType,
  load: () => Promise<LocalEmbeddedWorkGraph>,
) {
  let loaded: Promise<LocalEmbeddedWorkGraph> | undefined
  const forward = (request: Request) => (loaded ??= load()).then((embedded) =>
    embedded.router.fetch(workgraphRequest(request, "/api/workgraph")))
  app.all("/api/workgraph", (context) => forward(context.req.raw))
  app.all("/api/workgraph/*", (context) => forward(context.req.raw))
}

function workgraphRequest(request: Request, mountPath: string) {
  const url = new URL(request.url)
  url.pathname = url.pathname === mountPath
    ? "/"
    : url.pathname.slice(mountPath.length)
  return new Request(url, request)
}
