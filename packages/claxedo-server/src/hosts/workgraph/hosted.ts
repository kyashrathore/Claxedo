import {
  ExecutionCapabilitiesSchema,
  isExecutionCapabilityCatalogFresh,
  WorkGraphConnectionToolNames,
  type WorkGraphCommandRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import {
  ExecutionCapabilitiesUnavailableError,
  type ExecutionCapabilitiesPort,
  type ExecutionCapabilitiesReadInput,
} from "@claxedo/workgraph/ports"
import { createWorkGraphHttpRouter } from "@claxedo/workgraph/hosted"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../../control-plane/auth"
import {
  HostedWorkerCompositionError,
  clean,
  type HostedWorkerEnv,
} from "../../control-plane/adapters/worker/hosted-compose"
import {
  createConvexWorkGraphArchivePort,
  createConvexWorkGraphActivityPorts,
  createWorkGraphConvexExecutor,
  createConvexWorkGraphService,
  type WorkGraphConvexExecutor,
} from "./convex-store"
import { createHostedWorkGraphIntake } from "./hosted-intake"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import { createHostedAttentionAcknowledgementService } from "./hosted-attention"
import { Hono } from "hono"
import { createHostedConnectionWebhookVerifier } from "../connections/webhook-verifier"
import type { ControlPlaneCredentials } from "../../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createConvexWorkGraphOwnerDeletionPort } from "./convex-owner-deletion"
import { createHostedOwnerDeletionExecution } from "./hosted-owner-deletion-execution"
import type { WorkspaceAuthority } from "../../control-plane/authority"
import type { RelayProvider } from "../../relay-provider"
import type { ClaxedoRegion } from "../../region"
import { createHostedExecutionCapabilities } from "./hosted-execution-capabilities"
import { anyApi, type FunctionReference } from "convex/server"
import { workGraphConvexApi } from "./convex-api"
import type { ControlPlaneTelemetry } from "../../control-plane/services"
import {
  createWorkGraphOperationalReporter,
  instrumentWorkGraphCommands,
  workGraphHttpTelemetry,
} from "./operational-telemetry"
import {
  noopSettlementDispatcher,
  type SettlementDispatcher,
  type SettlementTenant,
} from "./settlement-dispatcher"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../../deployments/hosted-workerd/live-sync-room.cf"
import type { WorkgraphChangedEvent } from "../../lib/bus"

// Command types whose successful application enqueues a control-effect outbox
// row (interrupt_run / finalize_stream / cleanup_stream). These get an
// extra nudge to the dedicated fast control lane. Conservative by design: a
// command absent here still drains via the settle lane + 15-min sweep.
const CONTROL_EFFECT_COMMAND_TYPES = new Set<WorkGraphCommandRequest["command"]["type"]>([
  "delete_stream",
  "close_stream",
  "set_stream_lifecycle",
  "cancel_run",
  "cancel_work_item",
  "confirm_admission",
])

const HOSTED_IDENTITY_CACHE_TTL_MS = 60_000
const HOSTED_IDENTITY_CACHE_MAX_ENTRIES = 256

export type HostedWorkGraph = ReturnType<typeof createHostedWorkGraph>

export type HostedWorkGraphOwnerActivation =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "pending" | "failed"
      error: Readonly<{
        code: string
        capability: string
        reason: string
        message: string
        retryable: boolean
      }>
    }>

/**
 * Compose the personal WorkGraph inside the hosted Claxedo server. Convex is
 * the durable Cloud store; callers and internal workers share this service
 * instance and only northbound clients cross the HTTP router.
 */
export function createHostedWorkGraph(
  input: Readonly<{
    env: HostedWorkerEnv
    authConfig: ControlPlaneAuthConfig
    verifier?: ClerkVerifier
    requestId?: () => string
    executor?: WorkGraphConvexExecutor
    webhookVerifier?: ConnectionWebhookVerifier
    sandboxManager?: SandboxManager
    authority?: WorkspaceAuthority
    relayProvider?: RelayProvider
    defaultHomeRegion?: ClaxedoRegion
    executionCapabilities?: ExecutionCapabilitiesPort
    /**
     * How long a capability GET waits on the persisted attestation before
     * surfacing a retryable unavailability. Owner activation runs from
     * bootstrap in another request — possibly another isolate — so the
     * persisted attestation is the only durable rendezvous.
     */
    capabilityReadWait?: Readonly<{ attempts: number; intervalMs: number }>
    now?: () => number
    telemetry?: ControlPlaneTelemetry
    settlementDispatcher?: SettlementDispatcher
    settlementDispatcherForRequest?: (request: Request) => SettlementDispatcher | undefined
    /**
     * W5.3: per-owner/org live-sync fan-out Durable Object namespace (Cloudflare
     * Worker only). When present, every successful WorkGraph command rings the
     * caller's `LiveSyncRoom` with a `workgraph.changed` doorbell so a client
     * whose SSE stream is held by another isolate reloads. Absent (Node/self-host
     * /tests) → the single-box in-memory `claxedoBus` path stays the sole nudge.
     */
    liveSyncRoom?: LiveSyncRoomNamespace
    /**
     * Per-request `waitUntil` binding so the live-sync nudge fetch never blocks
     * the mutation response and survives past it on the Worker. Absent → the
     * nudge is fired best-effort inside the request (Node/tests).
     */
    waitUntilForRequest?: (request: Request) => ((promise: Promise<unknown>) => void) | undefined
    /** Test/custom-host seam; Cloud uses the encrypted per-org credential store. */
    webhookCredentials?: (orgId: string) => ControlPlaneCredentials
  }>,
) {
  const url = clean(input.env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(input.env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  if (!url && !input.executor) {
    throw new HostedWorkerCompositionError(
      "hosted_dependency_missing",
      "Hosted WorkGraph requires Convex storage (CLAXEDO_WORKGRAPH_CONVEX_URL or CLAXEDO_WORKSPACE_AUTHORITY_URL)",
    )
  }
  const serviceToken = clean(input.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!serviceToken) {
    throw new HostedWorkerCompositionError(
      "hosted_dependency_missing",
      "Hosted WorkGraph requires CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN",
    )
  }
  if (!input.authority) {
    throw new HostedWorkerCompositionError(
      "hosted_dependency_missing",
      "Hosted WorkGraph requires a trusted WorkspaceAuthority",
    )
  }
  const authority = input.authority
  const executor = input.executor ?? createWorkGraphConvexExecutor(url!)
  type HostedIdentity = Readonly<{
    organizationId: string
    ownerUserId: string
    expiresAt: number
  }>
  const identityCache = new Map<string, HostedIdentity | Promise<HostedIdentity>>()
  const clerkOrgByContext = new WeakMap<WorkGraphContext, string>()
  const signedAuthByContext = new WeakMap<WorkGraphContext, SignedControlPlaneAuth>()
  const settlementTenantByContext = new WeakMap<WorkGraphContext, SettlementTenant>()
  const settlementDispatcherByContext = new WeakMap<WorkGraphContext, SettlementDispatcher>()
  const liveSyncWaitUntilByContext = new WeakMap<WorkGraphContext, (promise: Promise<unknown>) => void>()
  const webhookVerifier =
    input.webhookVerifier ??
    createHostedConnectionWebhookVerifier({
      env: input.env,
      executor,
      serviceToken,
      ...(input.webhookCredentials ? { credentials: input.webhookCredentials } : {}),
    })
  const rawService = createConvexWorkGraphService({
    ...(url ? { url } : {}),
    serviceToken,
    executor,
  })
  const operationalTelemetry = input.telemetry
    ? createWorkGraphOperationalReporter({
        telemetry: input.telemetry,
        env: input.env,
        ...(input.now ? { now: input.now } : {}),
      })
    : undefined
  const commandService = operationalTelemetry
    ? instrumentWorkGraphCommands(rawService, operationalTelemetry, input.now)
    : rawService
  const settlementDispatcher = input.settlementDispatcher ?? noopSettlementDispatcher
  const now = input.now ?? Date.now
  // W5.3: ring the caller's live-sync room after a successful command so a
  // client whose SSE stream is held by another Worker isolate reloads. The room
  // NAME is derived from the AUTHORITY-INTERNAL org id already resolved for
  // this context (`trustedOrganizationId` → the settlement tenant), identical
  // to how the hosted events route (`connectLiveSyncRoom`) keys the room the
  // client is held in — it resolves the same `authority.resolveOrgId` at
  // connect — so the nudge always reaches the right room. The Clerk org claim
  // is deliberately NOT used: it is a disjoint namespace that names a room no
  // subscriber joins. The event carries `ownerUserId = auth.user.subject`
  // (== `context.ownerUserId`), which the room's per-connection
  // `eventVisibleTo` narrows to the right subject inside a shared org room.
  // Advisory + fire-and-forget: a failing nudge never fails the command.
  const nudgeLiveSync = (
    context: WorkGraphContext,
    change?: Readonly<{ cursor: string; streamId?: string }>,
  ) => {
    const namespace = input.liveSyncRoom
    if (!namespace) return
    const auth = signedAuthByContext.get(context)
    if (!auth) return
    const tenant = settlementTenantByContext.get(context)
    const event: WorkgraphChangedEvent = {
      type: "workgraph.changed",
      ownerUserId: auth.user.subject,
      ...(change?.cursor ? { cursor: change.cursor } : {}),
      ...(change?.streamId ? { streamId: change.streamId } : {}),
      ts: now(),
    }
    let run: Promise<void>
    try {
      const roomName = liveSyncRoomNameForPrincipal({
        ownerUserId: auth.user.subject,
        ...(tenant ? { orgId: tenant.organizationId } : {}),
      })
      run = nudgeLiveSyncRoom(namespace, roomName, event).then(
        () => {},
        (error) => {
          console.error("[claxedo-server] WARN  hosted workgraph.changed nudge failed:", error)
        },
      )
    } catch (error) {
      // Room-name derivation rejects identity material that cannot name a real
      // room; the nudge stays advisory, so the command result must survive it.
      console.error("[claxedo-server] WARN  hosted workgraph.changed nudge failed:", error)
      return
    }
    const waitUntil = liveSyncWaitUntilByContext.get(context)
    if (waitUntil) waitUntil(run)
    else void run
  }
  const service = {
    ...commandService,
    async execute(context: WorkGraphContext, request: WorkGraphCommandRequest) {
      const result = await commandService.execute(context, request)
      if (!result.ok) return result
      try {
        const dispatcher = settlementDispatcherByContext.get(context) ?? settlementDispatcher
        const tenant = settlementTenantByContext.get(context)
        if (!tenant) throw new Error("Hosted WorkGraph settlement tenant is unavailable")
        dispatcher.nudge(tenant)
        // Commands that enqueue a control effect (Stream delete/close/lifecycle,
        // Run/Task cancel, replace-mode admission → interrupt/finalize/cleanup
        // outbox rows) ALSO nudge the dedicated fast control lane so the drain
        // does not queue behind this tenant's launch-provision reconcile. Missing
        // a type here only falls back to the settle lane + sweep — never a
        // regression — so the set stays intentionally conservative.
        if (CONTROL_EFFECT_COMMAND_TYPES.has(request.command.type)) dispatcher.nudgeControl?.(tenant)
      } catch {
        // A settlement nudge is advisory; the durable command result owns the response.
      }
      nudgeLiveSync(context, {
        cursor: result.cursor,
        ...("streamId" in request.command && typeof request.command.streamId === "string"
          ? { streamId: request.command.streamId }
          : {}),
      })
      return result
    },
  }
  const activityPorts = createConvexWorkGraphActivityPorts({
    ...(url ? { url } : {}),
    serviceToken,
    executor,
  })
  const ownerContext = async (auth: SignedControlPlaneAuth, requestId: string): Promise<WorkGraphContext> => {
    const cacheKey = await hostedIdentityCacheKey(auth.token, auth.user.orgId)
    const cached = identityCache.get(cacheKey)
    const resolvedCached = cached instanceof Promise ? await cached : cached
    if (resolvedCached && resolvedCached.expiresAt <= now()) identityCache.delete(cacheKey)
    const pending = resolvedCached && resolvedCached.expiresAt > now()
      ? Promise.resolve(resolvedCached)
      : Promise.all([
          trustedOrganizationId(authority, auth),
          trustedOwnerUserId(authority, auth),
        ]).then(([organizationId, ownerUserId]) => {
          const resolved = { organizationId, ownerUserId, expiresAt: now() + HOSTED_IDENTITY_CACHE_TTL_MS }
          if (identityCache.size >= HOSTED_IDENTITY_CACHE_MAX_ENTRIES) {
            identityCache.delete(identityCache.keys().next().value!)
          }
          identityCache.set(cacheKey, resolved)
          return resolved
        }).catch((error) => {
          identityCache.delete(cacheKey)
          throw error
        })
    if (!cached || (resolvedCached && resolvedCached.expiresAt <= now())) identityCache.set(cacheKey, pending)
    const identity = await pending
    const context: WorkGraphContext = {
      organizationId: identity.organizationId as never,
      ownerUserId: auth.user.subject as never,
      actor: { type: "user", id: auth.user.subject as never },
      requestId: requestId as never,
      access: { mode: "owner" },
    }
    if (auth.user.orgId) clerkOrgByContext.set(context, auth.user.orgId)
    signedAuthByContext.set(context, auth)
    settlementTenantByContext.set(context, {
      organizationId: identity.organizationId,
      ownerUserId: identity.ownerUserId,
    })
    return context
  }
  const resolveContext = async (request: Request): Promise<WorkGraphContext> => {
    const auth = await controlPlaneAuthContext(request, {
      config: input.authConfig,
      ...(input.verifier ? { verifier: input.verifier } : {}),
      cliTokenEnv: input.env,
    })
    if (auth.mode !== "signed")
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed WorkGraph auth is required")
    const context = await ownerContext(
      auth,
      request.headers.get("x-request-id")?.trim() || input.requestId?.() || crypto.randomUUID(),
    )
    const requestDispatcher = input.settlementDispatcherForRequest?.(request)
    if (requestDispatcher) settlementDispatcherByContext.set(context, requestDispatcher)
    const requestWaitUntil = input.waitUntilForRequest?.(request)
    if (requestWaitUntil) liveSyncWaitUntilByContext.set(context, requestWaitUntil)
    return context
  }
  const intake = createHostedWorkGraphIntake({
    env: input.env,
    serviceToken,
    executor,
    service,
    resolveContext,
    ...(webhookVerifier ? { webhookVerifier } : {}),
  })
  const attentionAcknowledgements = createHostedAttentionAcknowledgementService({
    executor,
    serviceToken,
    ...(input.now ? { now: input.now } : {}),
  })
  const archive = createConvexWorkGraphArchivePort({ executor, serviceToken })
  const deletion = createConvexWorkGraphOwnerDeletionPort({
    executor,
    serviceToken,
    execution: createHostedOwnerDeletionExecution(input.sandboxManager),
  })
  const capabilitySource =
    input.executionCapabilities ??
    (input.sandboxManager && input.relayProvider && input.defaultHomeRegion
      ? createHostedExecutionCapabilities({
          authority,
          sandboxManager: input.sandboxManager,
          relayProvider: input.relayProvider,
          defaultHomeRegion: input.defaultHomeRegion,
          auth: (context) => {
            const auth = signedAuthByContext.get(context)
            return auth?.mode === "signed" ? auth : undefined
          },
          readConnections: (context) =>
            hostedExecutionConnections({
              context,
              clerkOrgId: clerkOrgByContext.get(context),
              executor,
              serviceToken,
            }),
          connectionToolIds: WorkGraphConnectionToolNames,
          ...(input.now ? { now: input.now } : {}),
        })
      : undefined)
  const executionCapabilities = capabilitySource
    ? attestHostedExecutionCapabilities({
        source: capabilitySource,
        executor,
        serviceToken,
        ...(input.now ? { now: input.now } : {}),
      })
    : undefined
  const ownerActivations = new Map<string, Promise<HostedWorkGraphOwnerActivation>>()
  const activationKey = (auth: SignedControlPlaneAuth) =>
    JSON.stringify([auth.user.orgId ?? "", auth.user.subject])
  const activateOwner = (auth: SignedControlPlaneAuth) => {
    const key = activationKey(auth)
    const existing = ownerActivations.get(key)
    if (existing) return existing
    const pending = ownerContext(auth, input.requestId?.() || crypto.randomUUID())
      .then((context) => activateHostedOwner(executionCapabilities, context))
    ownerActivations.set(key, pending)
    const clear = () => {
      if (ownerActivations.get(key) === pending) ownerActivations.delete(key)
    }
    void pending.then(clear, clear)
    return pending
  }
  // Covers the 30s catalog-startup bound of a concurrently running activation.
  const capabilityReadWait = input.capabilityReadWait ?? { attempts: 16, intervalMs: 2_000 }
  const readableExecutionCapabilities = executionCapabilities
    ? {
        ...executionCapabilities,
        // A capability refresh can unblock Streams held by `capability_invalid`,
        // so nudge settlement (and ring live-sync) after a successful refresh —
        // the drain re-derives readiness and launches.
        ...(executionCapabilities.refresh
          ? {
              refresh: async (context: WorkGraphContext, request: ExecutionCapabilitiesReadInput) => {
                const result = await executionCapabilities.refresh!(context, request)
                try {
                  const dispatcher = settlementDispatcherByContext.get(context) ?? settlementDispatcher
                  const tenant = settlementTenantByContext.get(context)
                  if (tenant) dispatcher.nudge(tenant)
                } catch {
                  // A settlement nudge is advisory; the refresh result owns the response.
                }
                nudgeLiveSync(context)
                return result
              },
            }
          : {}),
        read: async (context: WorkGraphContext, request: ExecutionCapabilitiesReadInput) => {
          const auth = signedAuthByContext.get(context)
          const activation = auth ? ownerActivations.get(activationKey(auth)) : undefined
          if (activation) await activation
          // The read stays discovery-free: it only re-reads the persisted
          // attestation while bootstrap's owner activation — which may be
          // running in another isolate, invisible to the map above — publishes
          // a fresh one. Non-retryable failures surface immediately.
          for (let attempt = 1; ; attempt += 1) {
            try {
              return await executionCapabilities.read(context, request)
            } catch (error) {
              const retryable =
                error instanceof ExecutionCapabilitiesUnavailableError && error.retryable
              if (!retryable || attempt >= capabilityReadWait.attempts) throw error
            }
            await new Promise((resolve) => setTimeout(resolve, capabilityReadWait.intervalMs))
          }
        },
      }
    : undefined
  const authenticated = createWorkGraphHttpRouter({
    service,
    resolveContext,
    attentionAcknowledgements,
    archive,
    deletion,
    ...(readableExecutionCapabilities ? { executionCapabilities: readableExecutionCapabilities } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  authenticated.route("/", intake.router)
  const router = new Hono()
  router.use("*", async (context, next) => {
    await next()
    if (![401, 403].includes(context.res.status)) return
    const authorization = context.req.header("authorization")?.trim()
    if (!authorization?.toLowerCase().startsWith("bearer ")) return
    const token = authorization.slice("bearer ".length).trim()
    if (token) identityCache.clear()
  })
  if (operationalTelemetry) router.use("*", workGraphHttpTelemetry(operationalTelemetry, input.now))
  if (intake.webhookRouter) router.route("/", intake.webhookRouter)
  router.route("/", authenticated)
  return {
    service,
    activity: activityPorts.activity,
    sessionBindings: activityPorts.sessionBindings,
    executor,
    serviceToken,
    resolveContext,
    router,
    intake,
    attentionAcknowledgements,
    archive,
    deletion,
    executionCapabilities: readableExecutionCapabilities,
    operationalTelemetry,
    activateOwner,
  }
}

async function hostedIdentityCacheKey(token: string, organizationId?: string) {
  return [...new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([organizationId ?? "", token])),
  ))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function trustedOrganizationId(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth) {
  try {
    const organizationId = await authority.resolveOrgId(auth)
    if (typeof organizationId === "string" && organizationId.trim()) return organizationId.trim()
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) throw error
  }
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "WorkGraph organization identity is unavailable",
  )
}

async function trustedOwnerUserId(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth) {
  try {
    const identity = await authority.usersMe(auth)
    if (identity && typeof identity === "object" && !Array.isArray(identity)) {
      const ownerUserId = (identity as Record<string, unknown>).user_id
      if (typeof ownerUserId === "string" && ownerUserId.trim()) return ownerUserId.trim()
    }
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) throw error
  }
  throw new ControlPlaneAuthError(
    503,
    "workspace_authority_unavailable",
    "WorkGraph owner identity is unavailable",
  )
}

async function activateHostedOwner(
  executionCapabilities: ExecutionCapabilitiesPort | undefined,
  context: WorkGraphContext,
): Promise<HostedWorkGraphOwnerActivation> {
  if (!executionCapabilities?.refresh) {
    return {
      status: "failed",
      error: {
        code: "execution_capabilities_unavailable",
        capability: "catalog_workspace",
        reason: "catalog_workspace_unavailable",
        message: "Hosted capability activation is not composed",
        retryable: false,
      },
    }
  }
  try {
    await executionCapabilities.refresh(context, {})
    return { status: "ready" }
  } catch (error) {
    if (error instanceof ExecutionCapabilitiesUnavailableError) {
      return {
        status: error.retryable ? "pending" : "failed",
        error: {
          code: error.code,
          capability: error.capability,
          reason: error.reason,
          message: error.message,
          retryable: error.retryable,
        },
      }
    }
    throw error
  }
}

function attestHostedExecutionCapabilities(
  input: Readonly<{
    source: ExecutionCapabilitiesPort
    executor: WorkGraphConvexExecutor
    serviceToken: string
    now?: () => number
  }>,
): ExecutionCapabilitiesPort {
  const now = input.now ?? Date.now
  const attest = async (
    context: WorkGraphContext,
    capabilities: Awaited<ReturnType<ExecutionCapabilitiesPort["read"]>>,
  ) => {
    if (capabilities.organizationId !== context.organizationId || capabilities.ownerUserId !== context.ownerUserId) {
      throw new ExecutionCapabilitiesUnavailableError(
        "runtime",
        "runtime_unavailable",
        "Execution capabilities crossed their trusted owner boundary",
        false,
      )
    }
    await input.executor.mutation(workGraphConvexApi.workgraphCapabilities.attestForService, {
      service_token: input.serviceToken,
      organization_id: context.organizationId,
      owner_subject: context.ownerUserId,
      capabilities,
      attested_at: now(),
    })
    return capabilities
  }
  return {
    read: async (context) => {
      const observedAt = now()
      const stored = await input.executor
        .query(workGraphConvexApi.workgraphCapabilities.readForService, {
          service_token: input.serviceToken,
          organization_id: context.organizationId,
          owner_subject: context.ownerUserId,
          now: observedAt,
        })
        .catch(() => {
          throw new ExecutionCapabilitiesUnavailableError(
            "runtime",
            "runtime_unavailable",
            "The hosted execution capability attestation is stale or unavailable",
            true,
          )
        })
      if (!stored) {
        throw new ExecutionCapabilitiesUnavailableError(
          "catalog_workspace",
          "catalog_workspace_unavailable",
          "The hosted execution capability catalog has not been attested",
          true,
        )
      }
      const capabilities = ExecutionCapabilitiesSchema.safeParse(stored)
      if (!capabilities.success) {
        throw new ExecutionCapabilitiesUnavailableError(
          "runtime",
          "catalog_invalid",
          "The hosted execution capability attestation is invalid",
          false,
        )
      }
      if (
        capabilities.data.organizationId !== context.organizationId ||
        capabilities.data.ownerUserId !== context.ownerUserId
      ) {
        throw new ExecutionCapabilitiesUnavailableError(
          "runtime",
          "runtime_unavailable",
          "Execution capabilities crossed their trusted owner boundary",
          false,
        )
      }
      if (!isExecutionCapabilityCatalogFresh(capabilities.data, observedAt)) {
        throw new ExecutionCapabilitiesUnavailableError(
          "runtime",
          "runtime_unavailable",
          "The hosted execution capability attestation has expired",
          true,
        )
      }
      return capabilities.data
    },
    ...(input.source.refresh
      ? {
          refresh: async (context: WorkGraphContext, request: Readonly<Record<string, never>>) =>
            attest(context, await input.source.refresh!(context, request)),
        }
      : {}),
  }
}

type Query = FunctionReference<"query">
const executionCapabilitiesApi = anyApi as unknown as {
  orgs: { membershipByClerkIds: Query }
  workgraphConnections: { listMetadata: Query }
}

async function hostedExecutionConnections(
  input: Readonly<{
    context: WorkGraphContext
    clerkOrgId?: string
    executor: WorkGraphConvexExecutor
    serviceToken: string
  }>,
) {
  if (!input.clerkOrgId) return []
  if (!input.context.organizationId) throw new Error("Hosted WorkGraph organization identity is unavailable")
  const membership = (await input.executor.query(executionCapabilitiesApi.orgs.membershipByClerkIds, {
    service_token: input.serviceToken,
    clerk_org_id: input.clerkOrgId,
    clerk_subject: input.context.ownerUserId,
  })) as { member?: boolean; org_id?: string; user_id?: string } | null
  if (!membership?.member || membership.org_id !== input.context.organizationId || !membership.user_id) {
    throw new Error("Hosted Connection membership is unavailable")
  }
  const rows = await input.executor.query(executionCapabilitiesApi.workgraphConnections.listMetadata, {
    service_token: input.serviceToken,
    ownerUserId: membership.user_id,
    orgId: membership.org_id,
  })
  if (!Array.isArray(rows)) throw new Error("Hosted Connection catalog was malformed")
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    if (
      row.status !== "connected" ||
      typeof row.id !== "string" ||
      typeof row.integrationId !== "string" ||
      !Array.isArray(row.capabilities)
    )
      return []
    return [
      {
        id: row.id as never,
        integrationId: row.integrationId,
        scope: "team" as const,
        ...(typeof row.accountLabel === "string" && row.accountLabel.trim()
          ? { accountLabel: row.accountLabel.trim() }
          : {}),
        grantedCapabilities: row.capabilities.filter(
          (capability): capability is string => typeof capability === "string" && !!capability.trim(),
        ),
      },
    ]
  })
}
