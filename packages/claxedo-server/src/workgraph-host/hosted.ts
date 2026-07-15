import {
  ExecutionCapabilitiesSchema,
  isExecutionCapabilityCatalogFresh,
  WorkGraphConnectionToolNames,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import { ExecutionCapabilitiesUnavailableError, type ExecutionCapabilitiesPort } from "@claxedo/workgraph/ports"
import { createWorkGraphHttpRouter } from "@claxedo/workgraph/hosted"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import {
  HostedWorkerCompositionError,
  clean,
  type HostedWorkerEnv,
} from "../control-plane/adapters/worker/hosted-compose"
import {
  createConvexWorkGraphArchivePort,
  createConvexWorkGraphActivityPorts,
  createWorkGraphConvexExecutor,
  createConvexWorkGraphService,
  type WorkGraphConvexExecutor,
} from "./convex-store"
import { createHostedWorkGraphIntake } from "./hosted-intake"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import { createHostedNotificationService } from "./hosted-notifications"
import { createHostedAttentionAcknowledgementService } from "./hosted-attention"
import { Hono } from "hono"
import { createHostedConnectionWebhookVerifier } from "../connections-host/webhook-verifier"
import type { ControlPlaneCredentials } from "../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createConvexWorkGraphOwnerDeletionPort } from "./convex-owner-deletion"
import { createHostedOwnerDeletionExecution } from "./hosted-owner-deletion-execution"
import type { WorkspaceAuthority } from "../control-plane/authority"
import type { RelayProvider } from "../relay-provider"
import type { ClaxedoRegion } from "../region"
import { createHostedExecutionCapabilities } from "./hosted-execution-capabilities"
import { anyApi, type FunctionReference } from "convex/server"
import { workGraphConvexApi } from "./convex-api"
import type { ControlPlaneTelemetry } from "../control-plane/services"
import {
  createWorkGraphOperationalReporter,
  instrumentWorkGraphCommands,
  workGraphHttpTelemetry,
} from "./operational-telemetry"

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
    now?: () => number
    telemetry?: ControlPlaneTelemetry
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
  const clerkOrgByContext = new WeakMap<WorkGraphContext, string>()
  const signedAuthByContext = new WeakMap<WorkGraphContext, Awaited<ReturnType<typeof controlPlaneAuthContext>>>()
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
  const service = operationalTelemetry
    ? instrumentWorkGraphCommands(rawService, operationalTelemetry, input.now)
    : rawService
  const activityPorts = createConvexWorkGraphActivityPorts({
    ...(url ? { url } : {}),
    serviceToken,
    executor,
  })
  const ownerContext = async (auth: SignedControlPlaneAuth, requestId: string): Promise<WorkGraphContext> => {
    const organizationId = await trustedOrganizationId(authority, auth)
    const context: WorkGraphContext = {
      organizationId: organizationId as never,
      ownerUserId: auth.user.subject as never,
      actor: { type: "user", id: auth.user.subject as never },
      requestId: requestId as never,
      access: { mode: "owner" },
    }
    if (auth.user.orgId) clerkOrgByContext.set(context, auth.user.orgId)
    signedAuthByContext.set(context, auth)
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
    return ownerContext(auth, request.headers.get("x-request-id")?.trim() || input.requestId?.() || crypto.randomUUID())
  }
  const intake = createHostedWorkGraphIntake({
    env: input.env,
    serviceToken,
    executor,
    service,
    resolveContext,
    ...(webhookVerifier ? { webhookVerifier } : {}),
  })
  const notifications = createHostedNotificationService({ executor, serviceToken })
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
  const authenticated = createWorkGraphHttpRouter({
    service,
    resolveContext,
    notifications,
    attentionAcknowledgements,
    archive,
    deletion,
    ...(executionCapabilities ? { executionCapabilities } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  authenticated.route("/", intake.router)
  const router = new Hono()
  if (operationalTelemetry) router.use("*", workGraphHttpTelemetry(operationalTelemetry, input.now))
  if (intake.webhookRouter) router.route("/", intake.webhookRouter)
  router.route("/", authenticated)
  const ownerActivations = new Map<string, Promise<HostedWorkGraphOwnerActivation>>()
  const activateOwner = async (auth: SignedControlPlaneAuth) => {
    const context = await ownerContext(auth, input.requestId?.() || crypto.randomUUID())
    const key = JSON.stringify([context.organizationId, context.ownerUserId])
    const existing = ownerActivations.get(key)
    if (existing) return existing
    const pending = activateHostedOwner(executionCapabilities, context)
    ownerActivations.set(key, pending)
    const clear = () => {
      if (ownerActivations.get(key) === pending) ownerActivations.delete(key)
    }
    void pending.then(clear, clear)
    return pending
  }
  return {
    service,
    activity: activityPorts.activity,
    sessionBindings: activityPorts.sessionBindings,
    executor,
    serviceToken,
    resolveContext,
    router,
    intake,
    notifications,
    attentionAcknowledgements,
    archive,
    deletion,
    executionCapabilities,
    operationalTelemetry,
    activateOwner,
  }
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
