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
import {
  createWorkGraphChangeDoorbell,
  createWorkGraphChangeTipWatcher,
  instrumentAttentionDoorbell,
  instrumentWorkGraphChangeDoorbell,
} from "./workgraph-host/change-doorbell"
import { claxedoBus, type WorkgraphChangedEvent } from "./bus"
import { createLocalWorkGraphMasterRuntime } from "./workgraph-host/local-master-runtime"

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

export async function recordLocalWorkGraphLlmUsage(
  ...args: Parameters<typeof import("@claxedo/workgraph").recordSqliteWorkGraphLlmUsage>
) {
  return import("@claxedo/workgraph").then((workgraph) => workgraph.recordSqliteWorkGraphLlmUsage(...args))
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
    sourcePlanning?: Readonly<{
      sessions: WorkGraphSessionGateway
      directory: string
    }>
    master?: Readonly<{
      sessions: WorkGraphSessionGateway
      directory(context: WorkGraphContext, streamId: string): string
    }>
    connections?: ConnectionsService
    sourceIssueConnectors?: readonly SourceIssueConnector[]
    resolveTeamOwner?: (context: WorkGraphContext) => string | undefined
    webhookVerifier?: ConnectionWebhookVerifier
    telemetry?: ControlPlaneTelemetry
    /**
     * WorkGraph live-sync doorbell. Defaults to the central
     * `claxedoBus`, which feeds `/api/wr/events` + `/global/event`; injectable so
     * tests can observe nudges without the bus.
     */
    publishChanged?: (event: WorkgraphChangedEvent) => void
    /** Trailing coalesce window for the doorbell (default 100ms). */
    changeCoalesceMs?: number
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
  const doorbell = createWorkGraphChangeDoorbell({
    publish: input.publishChanged ?? ((event) => claxedoBus.publish(event)),
    ...(input.changeCoalesceMs === undefined ? {} : { coalesceMs: input.changeCoalesceMs }),
  })
  const changeTips = createWorkGraphChangeTipWatcher({ database: input.database, doorbell })
  // Wrapped before anything downstream (router, intake host, MCP, agent tools)
  // receives `service`, so every command path nudges post-commit.
  const service = instrumentWorkGraphChangeDoorbell(
    operationalTelemetry ? instrumentWorkGraphCommands(adapter.service, operationalTelemetry) : adapter.service,
    doorbell,
    changeTips,
  )
  const activityPorts = workgraph.createSqliteWorkGraphActivityPorts({ database: input.database })
  const master = input.master
    ? createLocalWorkGraphMasterRuntime({
        database: input.database,
        sessions: input.master.sessions,
        workspace: input.execution,
        sessionBindings: activityPorts.sessionBindings,
        execute: service.execute,
        directory: input.master.directory,
      })
    : undefined
  const sourcePlanning = workgraph.createSqliteSourcePlanningRuntime({
    database: input.database,
    ...(input.sourcePlanning
      ? {
          sessions: {
            classifyAdmissionError: input.sourcePlanning.sessions.classifyAdmissionError,
            admit: input.sourcePlanning.sessions.admit,
            result: input.sourcePlanning.sessions.result,
          },
          sessionDirectory: input.sourcePlanning.directory,
        }
      : {}),
  })
  const sessionIntake = workgraph.createSqliteSessionIntakePort(input.database)
  // ATTENTION PARITY: acknowledgement writes append no `wg_v2_changes` row, so
  // they carry their own nudge — otherwise a mark-all-read in one client would
  // never reach another.
  const attentionAcknowledgements = instrumentAttentionDoorbell(
    workgraph.createAttentionAcknowledgementService(
      workgraph.createSqliteAttentionAcknowledgementStore(input.database),
    ),
    doorbell,
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
  const workGraphDeletion = workgraph.createSqliteWorkGraphOwnerDeletionPort(input.database, input.execution)
  // Personal connections are owner-matched (`visibleConnection` 404s on owner
  // mismatch) and loopback callers are pinned to the team partition, so once a
  // subject is gone NO principal can ever match its rows again — the row and
  // its backing credential would leak forever, with the third-party OAuth token
  // still live at the provider. Deleting an owner's WorkGraph state is the
  // moment that subject stops existing, so the connection cascade rides here.
  //
  // Ordering is deliberate: WorkGraph state first, connections only after it
  // succeeds. A cascade that ran first would destroy connections and then leave
  // them destroyed when `deleteOwner` throws `not_quiescent`/`in_progress` —
  // and unlike WorkGraph deletion, `removeOwner` has no receipt to replay from.
  // The fail-safe direction is "an orphan lingers" (reclaimable on retry, since
  // `removeOwner` is idempotent), never "a live user loses their connection".
  //
  // The owner string MUST be the same one connect-time stores:
  // `controlPlaneAuthContext(...).user.subject`, which `resolveContext` below
  // already derives as `context.ownerUserId`.
  //
  // Hosted is unaffected: it mounts the connections routes with no personal
  // owner resolver (`hosted-connections-setup.ts`), so every hosted row is
  // `org:{orgId}` and a subject-keyed cascade correctly matches nothing.
  const deletion: typeof workGraphDeletion = input.connections
    ? {
        deleteOwner: async (context, deleteInput) => {
          const result = await workGraphDeletion.deleteOwner(context, deleteInput)
          await input.connections!.removeOwner(context.ownerUserId)
          return result
        },
      }
    : workGraphDeletion
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
    const runs = workgraph.listSqliteReconcilableRuns(input.database, context)
    try {
      const results = await Promise.all(
        runs.map(async (run) => {
          const renewal = await adapter.runRuntime.renewLease(context, {
            runId: run.runId,
            expectedLeaseEpoch: run.leaseEpoch,
            occurredAt: Date.now(),
            durationMs: 300_000,
          })
          if (!renewal) return { settled: false as const }
          const result = await input.execution.result(context, {
            runId: run.runId,
            sessionId: run.sessionId,
          })
          if (result.state === "pending" || result.state === "running") return { settled: false as const }
          return workgraph.recordSemanticRunResult(
            context,
            { ...run, leaseEpoch: renewal.leaseEpoch },
            result,
            adapter.runResults,
          )
        }),
      )
      // Launch reconciliation: re-drive the ready-stream drain every tick. The
      // per-command drain is one-shot — when a pass skips a Stream (capability
      // read hiccup, envelope worktree busy with a master turn) a launchable
      // pending Work Item would otherwise stay stranded until some unrelated
      // command runs, which is exactly the "dependent Task still pending"
      // stall the workgraph-real e2e kept hitting.
      await adapter.drainReadyStreams()
      await master?.runDue(context)
      operationalTelemetry?.queue({
        kind: "run",
        backlog: runs.length,
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
        claimed: runs.length,
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
        claimed: runs.length,
        running: 0,
        settled: 0,
        failed: 1,
      })
      throw error
    }
  }
  return {
    database: input.database,
    execution: input.execution,
    service,
    activity: activityPorts.activity,
    sessionBindings: activityPorts.sessionBindings,
    router,
    resolveContext,
    reconcile,
    master,
    sourcePlanning,
    sessionIntake,
    attentionAcknowledgements,
    archive,
    deletion,
    intake,
    executionCapabilities: input.executionCapabilities,
    operationalTelemetry,
    doorbell,
    /**
     * Nudge iff this owner's change log advanced since the last call. The server
     * reconciler drives this once per owner per tick so that writers outside the
     * command path (run settlement, source planning, activity, intake
     * stores) still reach clients, without costing anything when idle.
     */
    observeChanges: changeTips.observe,
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
