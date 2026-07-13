import { WorkGraphConnectionToolNames, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { ExecutionCapabilitiesPort } from "@claxedo/workgraph/ports"
import { createWorkGraphHttpRouter } from "@claxedo/workgraph/hosted"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"
import { HostedWorkerCompositionError, clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"
import {
  createConvexWorkGraphArchivePort,
  createWorkGraphConvexExecutor,
  createConvexWorkGraphService,
  type WorkGraphConvexExecutor,
} from "./convex-store"
import { createHostedWorkGraphIntake } from "./hosted-intake"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import { createHostedNotificationService } from "./hosted-notifications"
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

export type HostedWorkGraph = ReturnType<typeof createHostedWorkGraph>

/**
 * Compose the personal WorkGraph inside the hosted Claxedo server. Convex is
 * the durable Cloud store; callers and internal workers share this service
 * instance and only northbound clients cross the HTTP router.
 */
export function createHostedWorkGraph(input: Readonly<{
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
  /** Test/custom-host seam; Cloud uses the encrypted per-org credential store. */
  webhookCredentials?: (orgId: string) => ControlPlaneCredentials
}>) {
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
  const executor = input.executor ?? createWorkGraphConvexExecutor(url!)
  const webhookVerifier = input.webhookVerifier ?? createHostedConnectionWebhookVerifier({
    env: input.env,
    executor,
    serviceToken,
    ...(input.webhookCredentials ? { credentials: input.webhookCredentials } : {}),
  })
  const service = createConvexWorkGraphService({
    ...(url ? { url } : {}),
    serviceToken,
    executor,
  })
  const clerkOrgByContext = new WeakMap<WorkGraphContext, string>()
  const signedAuthByContext = new WeakMap<WorkGraphContext, Awaited<ReturnType<typeof controlPlaneAuthContext>>>()
  const resolveContext = async (request: Request): Promise<WorkGraphContext> => {
    const auth = await controlPlaneAuthContext(request, {
      config: input.authConfig,
      ...(input.verifier ? { verifier: input.verifier } : {}),
      cliTokenEnv: input.env,
    })
    if (auth.mode !== "signed") throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed WorkGraph auth is required")
    const context: WorkGraphContext = {
      ownerUserId: auth.user.subject as never,
      actor: { type: "user", id: auth.user.subject as never },
      requestId: (request.headers.get("x-request-id")?.trim() || input.requestId?.() || crypto.randomUUID()) as never,
      access: { mode: "owner" },
    }
    if (auth.user.orgId) clerkOrgByContext.set(context, auth.user.orgId)
    signedAuthByContext.set(context, auth)
    return context
  }
  const intake = createHostedWorkGraphIntake({
    env: input.env,
    serviceToken,
    executor,
    service,
    resolveContext,
    resolveClerkOrgId: (context) => clerkOrgByContext.get(context),
    ...(webhookVerifier ? { webhookVerifier } : {}),
  })
  const notifications = createHostedNotificationService({ executor, serviceToken })
  const archive = createConvexWorkGraphArchivePort({ executor, serviceToken })
  const deletion = createConvexWorkGraphOwnerDeletionPort({
    executor,
    serviceToken,
    execution: createHostedOwnerDeletionExecution(input.sandboxManager),
  })
  const executionCapabilities = input.executionCapabilities ?? (
    input.authority && input.sandboxManager && input.relayProvider && input.defaultHomeRegion
      ? createHostedExecutionCapabilities({
          authority: input.authority,
          sandboxManager: input.sandboxManager,
          relayProvider: input.relayProvider,
          defaultHomeRegion: input.defaultHomeRegion,
          auth: (context) => {
            const auth = signedAuthByContext.get(context)
            return auth?.mode === "signed" ? auth : undefined
          },
          readConnections: (context) => hostedExecutionConnections({
            context,
            clerkOrgId: clerkOrgByContext.get(context),
            executor,
            serviceToken,
          }),
          connectionToolIds: WorkGraphConnectionToolNames,
        })
      : undefined
  )
  const authenticated = createWorkGraphHttpRouter({
    service,
    resolveContext,
    notifications,
    archive,
    deletion,
    ...(executionCapabilities ? { executionCapabilities } : {}),
  })
  authenticated.route("/", intake.router)
  const router = new Hono()
  if (intake.webhookRouter) router.route("/", intake.webhookRouter)
  router.route("/", authenticated)
  return {
    service,
    executor,
    serviceToken,
    resolveContext,
    router,
    intake,
    notifications,
    archive,
    deletion,
    executionCapabilities,
  }
}

type Query = FunctionReference<"query">
const executionCapabilitiesApi = anyApi as unknown as {
  orgs: { membershipByClerkIds: Query }
  workgraphConnections: { listMetadata: Query }
}

async function hostedExecutionConnections(input: Readonly<{
  context: WorkGraphContext
  clerkOrgId?: string
  executor: WorkGraphConvexExecutor
  serviceToken: string
}>) {
  if (!input.clerkOrgId) return []
  const membership = await input.executor.query(executionCapabilitiesApi.orgs.membershipByClerkIds, {
    service_token: input.serviceToken,
    clerk_org_id: input.clerkOrgId,
    clerk_subject: input.context.ownerUserId,
  }) as { member?: boolean; org_id?: string; user_id?: string } | null
  if (!membership?.member || !membership.org_id || !membership.user_id) {
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
    if (row.status !== "connected" || typeof row.id !== "string" || typeof row.integrationId !== "string" || !Array.isArray(row.capabilities)) return []
    return [{
      id: row.id as never,
      integrationId: row.integrationId,
      scope: "team" as const,
      ...(typeof row.accountLabel === "string" && row.accountLabel.trim() ? { accountLabel: row.accountLabel.trim() } : {}),
      grantedCapabilities: row.capabilities.filter((capability): capability is string => typeof capability === "string" && !!capability.trim()),
    }]
  })
}
