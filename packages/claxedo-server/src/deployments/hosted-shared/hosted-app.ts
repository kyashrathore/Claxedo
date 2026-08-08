/**
 * Hosted control-plane Hono app — the Worker-safe subset of the Claxedo API.
 *
 * Mounts ONLY runtime-neutral hosted routes. It imports no Node server adapter
 * (`@hono/node-server`/`@hono/node-ws`), no local workspace store/supervisor/
 * embedded runtime/tunnel, and no SQLite. The same app can be served from a
 * Node container adapter later — Cloudflare Workers is just the first target.
 *
 * Surface:
 *   GET  /api/claxedo/health
 *   GET  /api/claxedo/mode
 *   GET  /api/claxedo/compatibility
 *   GET  /api/claxedo/events      (auth-gated live-sync SSE stream)
 *   GET  /api/claxedo/bootstrap   (aggregate shell boot payload)
 *   GET  /global/health | /global/config
 *   GET  /project | /project/current | /path | /provider | /provider/auth
 *   GET  /.well-known/jwks.json
 *   POST /api/auth/device/code | /api/auth/device/token
 *   GET  /api/control/sessions   (signed session visibility inventory)
 *   GET  /api/control/sessions/:id/gateway | /messages
 *   GET  /api/workspace/:id/connection
 *   POST /api/workspace/:id/connection/refresh
 *   POST /api/workspace/:id/user-hosted/challenge
 *   POST /api/workspace/:id/user-hosted/register
 *   POST /api/workspace/:id/user-hosted/heartbeat
 *   POST /api/workspace/:id/user-hosted/pause
 *   GET  /internal/relay/target
 *   GET  /internal/relay/revocation
 *   POST /internal/sandbox-manager/gc
 *   POST /internal/workgraph/reconcile
 */

import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { allowedOriginPatterns } from "@claxedo/server-core/platform/http/cors-origins"
import { securityHeaders } from "../../platform/http/security-headers"
import { JwksRoutes } from "../../authority/routes/jwks"
import { InternalRelayResolverRoutes, type RelayTargetLookup } from "../shared-routes/internal-relay"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "../../routes/hosted/workspace"
import { WorkspaceCheckpointRoutes } from "../../workspace/routes/checkpoints"
import { signedOrError } from "../../workspace/route-support"
import { HostedDeviceAuthRoutes } from "../../routes/hosted/device-auth"
import { HostedShellRoutes } from "../../routes/hosted/shell"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../../deployments/hosted-workerd/live-sync-room.cf"
import { HostedSandboxAdminRoutes } from "../../routes/hosted/sandbox-admin"
import { HostedWorkGraphAdminRoutes, type WorkGraphReconcileResult } from "../../routes/hosted/workgraph-admin"
import { HostedControlRoutes } from "../../routes/hosted/control"
import { HostedWorkerCompositionError, type HostedControlPlane } from "../../authority/hosted-services"
import { configureCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import type { ControlPlaneServices } from "../../authority/services"
import {
  createFixedWindowConnectionRateLimiter,
  createLayeredRateLimiter,
  type SharedRateLimitStore,
} from "../../platform/auth/rate-limit"
import { defaultRequestGuard, hostedRouteGuardExemptions } from "../../platform/auth/request-guard"
import { BILLING_WEBHOOK_GUARD_EXEMPTION, BillingRoutes } from "../../billing/routes"
import { createEntitlementGate, type EntitlementGate } from "../../billing/entitlement"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { deploymentCompatibilityReport } from "../../platform/governance/deployment-compatibility"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "../../authority/deployment-mode"
import {
  createHostedWorkGraph,
  type HostedWorkGraph,
  type HostedWorkGraphOwnerActivation,
} from "../../hosts/workgraph/hosted/index"
import {
  createHostedConnectionOperationExecutor,
  createHostedConnectionOperationHandler,
} from "../../hosts/workgraph/hosted/connection-operation"
import {
  createHostedRunOperationExecutor,
  createHostedRunOperationHandler,
} from "../../hosts/workgraph/hosted/run-operation"
import { createHostedSessionTranscriptRetention } from "../../hosts/workgraph/hosted/runtime"
import { createHostedConnectionsSetup, createHostedRepositoryAccess } from "../../hosts/workgraph/hosted/connections-setup"
import { DocumentsRoutes, type DocumentsRouteBackend } from "../../documents/routes/index"
import { workGraphHttpTelemetry } from "../../hosts/workgraph/operational-telemetry"
import { captureProduct, productIdentity } from "../../platform/telemetry/product/product"
import type { SettlementDispatcher } from "../../hosts/workgraph/settlement-dispatcher"
import type { WorkGraphConvexExecutor } from "../../hosts/workgraph/convex/store"

export type HostedAppOverrides = {
  /** Hosted relay target lookup. Omitted → the plane's composed lookup is used. */
  relayTargetLookup?: RelayTargetLookup
  /** Node-only hosted deployments mount the real central runtime separately. */
  centralSessionRuntime?: boolean
  /** Test/custom composition seam; production composes Convex from env. */
  workgraph?: HostedWorkGraph
  /** Test/custom executor seam for the production WorkGraph composition. */
  workGraphExecutor?: WorkGraphConvexExecutor
  /** Test/custom seam for signed bootstrap owner activation. */
  workGraphOwnerActivation?: (auth: SignedControlPlaneAuth) => Promise<HostedWorkGraphOwnerActivation>
  /** Bounded durable reconciler shared by cron and the protected admin trigger. */
  workGraphReconcile?: () => Promise<WorkGraphReconcileResult>
  /** Fixed settlement adapter for Node/self-host compositions. */
  workGraphSettlementDispatcher?: SettlementDispatcher
  /** Request-bound Worker adapter; binds the active ExecutionContext. */
  workGraphSettlementDispatcherForRequest?: (
    waitUntil: (promise: Promise<unknown>) => void,
  ) => SettlementDispatcher
  /** Test seam for the complete_run transcript-retention gate. */
  runTranscriptRetention?: (input: {
    organizationId: string
    ownerSubject: string
    workspaceId: string
    sessionId: string
  }) => Promise<void>
  /** Node-hosted channel delivery seam for exact WorkGraph Stream masters. */
  workGraphNotifyOwner?: (input: {
    ownerUserId: string
    orgId: string
    idempotencyKey: string
    text: string
  }) => Promise<{ channel: string; reference: string; duplicate: boolean }>
  /** Deterministic hosted capability gate for component tests. */
  entitlementGate?: EntitlementGate
  /** D11 supplies hosted document index/blob storage through this Worker-safe seam. */
  documentsBackend?: DocumentsRouteBackend
  /**
   * Per-owner live-sync fan-out Durable Object namespace. Present on the
   * Cloudflare Worker (bound as LIVE_SYNC_ROOM); when present the hosted events
   * route holds the client SSE stream in the caller's room. Absent in
   * Node/self-host/test compositions, the route provides heartbeat fallback.
   */
  liveSyncRoom?: LiveSyncRoomNamespace
  /**
   * Cross-isolate rate-limit store for the default request guard.
   *
   * Present on the Cloudflare Worker (adapted from the `[[ratelimits]]`
   * binding); ABSENT on Node/self-host and in tests, where the per-isolate fuse
   * is the whole limiter. See authority/rate-limit.ts for why the degraded
   * mode is correct for a single-process topology rather than merely tolerated.
   */
  sharedRateLimitStore?: SharedRateLimitStore
}

// Deployment-configured app origins (CLAXEDO_APP_ORIGINS, comma-separated).
// Exact `https://app.example.com` entries and `https://*.example.com` suffix
// entries are accepted, so staged app hosts (e.g. Cloudflare Pages) can call
// the central API without editing shared code per deployment.
export function configuredAppOrigins(raw: string | undefined) {
  const entries = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const exact = new Set<string>()
  const suffixes: string[] = []
  for (const entry of entries) {
    if (entry.startsWith("https://*.")) suffixes.push(entry.slice("https://*".length))
    else exact.add(entry)
  }
  return (origin: string) => {
    if (exact.has(origin)) return true
    if (!origin.startsWith("https://")) return false
    return suffixes.some((suffix) => origin.endsWith(suffix) && origin.length > "https://".length + suffix.length)
  }
}

// Safely read the request's ExecutionContext `waitUntil` (present on the
// Cloudflare Worker; `context.executionCtx` THROWS on the Node adapter / tests
// where no ctx is threaded). Returns undefined when unavailable so callers fall
// back to best-effort in-request work.
function guardedExecutionWaitUntil(context: Context): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const execution = context.executionCtx
    if (typeof execution?.waitUntil !== "function") return undefined
    return execution.waitUntil.bind(execution)
  } catch {
    return undefined
  }
}

// Hosted CORS reflects ONLY deployment-configured origins. There is
// deliberately no built-in `http://localhost:*` / `http://127.0.0.1:*` branch:
// This middleware runs on the internet-facing Worker, where a blanket loopback
// grant hands every port on a visitor's machine a same-origin read of the
// hosted control plane, and buys nothing the config cannot express. A
// deployment that genuinely wants a local app to talk to it (staging, a
// developer pointing a dev server at hosted) lists the exact origin in
// `CLAXEDO_APP_ORIGINS` — `configuredAppOrigins` matches it exactly, so
// `http://localhost:4444` works while `http://localhost:<anything else>` does
// not. The LOCAL control plane (src/server.ts) keeps its loopback grant: there
// the reflection is load-bearing for normal browser dev, and the credential
// routes are separately excluded (connections-cors.test.ts).
function corsMiddleware(appOriginAllowed: (origin: string) => boolean, originPatterns: RegExp[]) {
  return cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (originPatterns.some((pattern) => pattern.test(origin))) return origin
      if (appOriginAllowed(origin)) return origin
      return undefined
    },
    maxAge: 86400,
  })
}

/**
 * Fail-closed hosted boot assertion (runs for BOTH hosted entrypoints —
 * the Cloudflare Worker `worker.ts` and the Node container `hosted-node.ts`).
 * `composeHostedControlPlane` already fails closed per-piece on missing env
 * (auth, authority, relay, resolver, signing key); this asserts the parts the
 * hosted app itself must never serve without, aggregated into ONE error
 * naming every missing piece:
 *   1. CLAXEDO_DEPLOYMENT_MODE=hosted is EXPLICIT — a hosted deploy manifest
 *      that lost the flag must be a visible outage, not an inferred posture;
 *   2. signed auth resolved enabled (unsigned-local is impossible);
 *   3. a workspace authority is composed.
 * Thrown as HostedWorkerCompositionError so `worker.ts` keeps mapping it to
 * a fail-closed 503.
 */
function assertHostedAppBootConfig(plane: HostedControlPlane) {
  const failures: string[] = []
  try {
    if (deploymentMode(plane.env) !== "hosted") {
      failures.push(`deployment mode is not hosted (set ${DEPLOYMENT_MODE_ENV}=hosted in the hosted deploy manifest)`)
    }
  } catch (err) {
    if (!(err instanceof DeploymentModeError)) throw err
    failures.push(err.message)
  }
  if (!plane.services.auth.config.enabled) {
    failures.push("signed auth is not enabled (CLAXEDO_SIGNED_CLOUD_AUTH + CLERK_JWT_ISSUER + CLERK_JWKS_URL)")
  }
  if (!plane.services.authority) {
    failures.push("no workspace authority is composed (CLAXEDO_WORKSPACE_AUTHORITY_URL)")
  }
  if (failures.length > 0) {
    throw new HostedWorkerCompositionError(
      "hosted_deployment_mode_required",
      `Hosted control plane refuses to start: ${failures.join("; ")}`,
    )
  }
}

/**
 * Deployment-specific hosts appended to the hosted sandbox egress allowlist,
 * from `CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS` (comma-separated).
 *
 * This is the ONLY way an operator can widen what a hosted sandbox may reach.
 * `hostedSandboxNetworkPolicy` deliberately excludes general-purpose object
 * storage and CDN wildcards — each is a bucket an attacker can create in their
 * own account — so a deployment that genuinely needs a private registry or a
 * self-hosted model gateway names it here, and the widening is one grep away
 * from an auditor rather than a default nobody chose.
 *
 * Same comma-separated shape as `CLAXEDO_NETWORK_ALLOWLIST_EXTRA`
 * (`network/types.ts`), the credential layer's equivalent knob, so an operator
 * who has configured one already knows this one. Unset or blank yields an empty
 * list, which leaves the reviewed baseline exactly as it is: absent config
 * never widens the allowlist, it only declines to.
 */
function sandboxEgressExtraHosts(env: HostedControlPlane["env"]): string[] {
  return (env.CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
}

export function createHostedApp(plane: HostedControlPlane, overrides: HostedAppOverrides = {}) {
  assertHostedAppBootConfig(plane)
  // Install the plane's durable CLI session token registry process-wide.
  //
  // This is the `configureX(...)` composition seam the registry port defines,
  // and this is the right moment to call it: the CLI routes are mounted below,
  // and CLI bearer verification happens deep inside `controlPlaneAuthContext`
  // on every request, far from any place a registry could be threaded through
  // by hand. Without this line minting returns 503 and no CLI bearer verifies —
  // the port fails closed when nothing is configured, on purpose.
  configureCliSessionTokenRegistry(plane.cliSessionTokenRegistry)
  const { services } = plane
  const app = new Hono()
  const liveSyncRoom = overrides.liveSyncRoom
  const settlementDispatcherByRequest = new WeakMap<Request, SettlementDispatcher>()
  // Per-request `waitUntil`, captured in `forwardWorkGraph` from the active
  // ExecutionContext, so the internal WorkGraph service can ring the live-sync
  // room past the mutation response without blocking it.
  const liveSyncWaitUntilByRequest = new WeakMap<Request, (promise: Promise<unknown>) => void>()
  const workgraph =
    overrides.workgraph ??
    createHostedWorkGraph({
      env: plane.env,
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
      ...(services.authority ? { authority: services.authority } : {}),
      ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
      ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
      ...(overrides.workGraphExecutor ? { executor: overrides.workGraphExecutor } : {}),
      ...(overrides.workGraphSettlementDispatcher
        ? { settlementDispatcher: overrides.workGraphSettlementDispatcher }
        : {}),
      ...(overrides.workGraphSettlementDispatcherForRequest
        ? { settlementDispatcherForRequest: (request: Request) => settlementDispatcherByRequest.get(request) }
        : {}),
      ...(liveSyncRoom ? { liveSyncRoom } : {}),
      waitUntilForRequest: (request: Request) => liveSyncWaitUntilByRequest.get(request),
      telemetry: services.telemetry,
    })
  const workGraphOwnerActivation = overrides.workGraphOwnerActivation
    ? overrides.workGraphOwnerActivation
    : workgraph.activateOwner
  const connectionOperationExecutor = createHostedConnectionOperationExecutor({ env: plane.env })
  const connectionOperationHandler = connectionOperationExecutor
    ? createHostedConnectionOperationHandler({ env: plane.env, execute: connectionOperationExecutor })
    : undefined
  const runTranscriptRetention =
    overrides.runTranscriptRetention ?? createHostedSessionTranscriptRetention(plane.env, services)
  const runOperationExecutor = createHostedRunOperationExecutor({
    env: plane.env,
    ...(overrides.workGraphExecutor ? { executor: overrides.workGraphExecutor } : {}),
    ...(runTranscriptRetention ? { retainTranscript: runTranscriptRetention } : {}),
    ...(overrides.workGraphNotifyOwner ? { notifyOwner: overrides.workGraphNotifyOwner } : {}),
    ...(liveSyncRoom
      ? {
          notifyChanged: async (
            principal: { ownerUserId: string; orgId: string },
            change: { cursor: string; streamId?: string },
          ) => {
            // Room by the WorkGraph tenant's org: `principal.orgId` is the
            // authority-internal org id carried by the runtime access token —
            // the SAME namespace subscriber rooms are keyed with (the hosted
            // events route resolves `authority.resolveOrgId` at connect), so
            // this nudge reaches every member held in the tenant's room,
            // including subscribers connected with an active-org Clerk token.
            // `eventVisibleTo` narrows the subject-keyed event to the owner's
            // own connections inside the shared room.
            await nudgeLiveSyncRoom(
              liveSyncRoom,
              liveSyncRoomNameForPrincipal({ ownerUserId: principal.ownerUserId, orgId: principal.orgId }),
              {
                type: "workgraph.changed",
                ownerUserId: principal.ownerUserId,
                cursor: change.cursor,
                ...(change.streamId ? { streamId: change.streamId } : {}),
                ts: Date.now(),
              },
            ).catch((error) => {
              console.error("[claxedo-server] WARN  hosted agent workgraph.changed nudge failed:", error)
            })
          },
        }
      : {}),
  })
  const runOperationHandler = runOperationExecutor
    ? createHostedRunOperationHandler({ env: plane.env, execute: runOperationExecutor })
    : undefined
  const forwardWorkGraph = (context: Context) => {
    const url = new URL(context.req.url)
    url.pathname = url.pathname === "/api/workgraph" ? "/" : url.pathname.slice("/api/workgraph".length)
    const request = new Request(url, context.req.raw)
    if (!overrides.workgraph) {
      const waitUntil = guardedExecutionWaitUntil(context)
      if (waitUntil) {
        // The internal WorkGraph service reads this to ring the live-sync
        // room after the response (it has no ExecutionContext of its own).
        liveSyncWaitUntilByRequest.set(request, waitUntil)
        if (overrides.workGraphSettlementDispatcherForRequest) {
          settlementDispatcherByRequest.set(request, overrides.workGraphSettlementDispatcherForRequest(waitUntil))
        }
      }
    }
    return workgraph.router.fetch(request)
  }

  // Outermost middleware ON PURPOSE, registered ahead of CORS so it also
  // covers the preflight response CORS short-circuits, the 404 handler, and
  // anything `onError` produces. Registering it here — once, at composition —
  // is what makes "no hosted route can ship without security headers" a
  // property of the shell rather than a per-route review item.
  // See src/security-headers.ts for why its CSP is safe to ENFORCE (this app
  // serves no HTML) and why HSTS is gated on HTTPS.
  app.use(securityHeaders())

  app.use(
    corsMiddleware(
      configuredAppOrigins(plane.env.CLAXEDO_APP_ORIGINS),
      allowedOriginPatterns(plane.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES),
    ),
  )

  // Global unsigned-local gate, defense-in-depth here — the boot
  // assertion above guarantees signed auth, so this only fires if a hosted
  // composition somehow reaches serving unsigned (then: down, not open).
  app.use(
    unsignedLocalRequestGuard({
      mode: "hosted",
      authConfig: services.auth.config,
    }),
  )

  // The DEFAULT body cap + abuse rate limit for every mounted route.
  // Registered here (after the auth-posture gate, before any route mounts) so a
  // route cannot ship without one: escaping the default requires a named entry
  // exemption (core list + each feature's own), which route-guard-inventory.test.ts reads.
  //
  // The rate limit is layered (authority/rate-limit.ts): a per-isolate
  // in-memory fuse first, then the cross-isolate shared store when one is
  // composed. `sharedRateLimitStore` is absent on Node/self-host, where a single
  // process makes the fuse the global limit anyway. This is ADDITIVE — the nine
  // route-level limiters keep their own tuned budgets untouched.
  app.use(
    defaultRequestGuard({
      exemptions: hostedRouteGuardExemptions([BILLING_WEBHOOK_GUARD_EXEMPTION]),
      rateLimiter: createLayeredRateLimiter({
        local: createFixedWindowConnectionRateLimiter({
          limit: plane.safetyLimits.defaultRequestRateLimit,
          windowMs: plane.safetyLimits.defaultRequestRateLimitWindowMs,
        }),
        ...(overrides.sharedRateLimitStore ? { sharedStore: overrides.sharedRateLimitStore } : {}),
      }),
    }),
  )

  // The ONE entitlement predicate behind the hosted choke points
  // (src/billing/entitlement.ts). The org whose subscription matters is the
  // caller's ACTIVE org (Clerk org claim if a member, else the personal org),
  // resolved through the same authority call the rest of the control plane
  // uses. Gate errors resolve to fail-closed denials inside the gate.
  const entitlementGate = overrides.entitlementGate ?? createEntitlementGate({ env: plane.env })
  const connectionsSetupInput = {
    env: plane.env,
    authConfig: services.auth.config,
    executor: workgraph.executor,
    serviceToken: workgraph.serviceToken,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    requireEntitlement: (clerkOrgId: string) => entitlementGate({ clerkOrgId }, "hosted-connections"),
  }
  const connectionsSetup = createHostedConnectionsSetup(connectionsSetupInput)
  // The workspace-create route resolves connected private repositories through
  // the same org-scoped connections the integrations surface serves.
  const hostedRepositoryForAuth = createHostedRepositoryAccess(connectionsSetupInput)
  const requireCloudWorkspaceEntitlement = async (
    auth: Parameters<NonNullable<HostedWorkspaceRouteOptions["requireCloudWorkspaceEntitlement"]>>[0],
  ) => {
    const authority = services.authority
    if (!authority) {
      return {
        status: 503 as const,
        body: { error: { code: "workspace_authority_unavailable", message: "Workspace authority is not configured" } },
      }
    }
    try {
      const orgId = await authority.resolveOrgId(auth)
      return await entitlementGate({ orgId }, "cloud-workspace")
    } catch (err) {
      // resolveOrgId failures are ordinary control-plane auth errors — keep
      // their own status/body instead of masking them as billing denials.
      if (err instanceof ControlPlaneAuthError) {
        return { status: err.status, body: controlPlaneAuthErrorBody(err) }
      }
      throw err
    }
  }

  const egressExtraHosts = sandboxEgressExtraHosts(plane.env)
  const workspaceOptions: HostedWorkspaceRouteOptions = {
    requireCloudWorkspaceEntitlement,
    connections: { repositoryForAuth: hostedRepositoryForAuth },
    // Omitted when empty rather than passed as `[]`: the route option is
    // optional, and an absent key is the shape that means "the baseline stands".
    ...(egressExtraHosts.length ? { sandboxEgressExtraHosts: egressExtraHosts } : {}),
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    ...(services.relay.relayUrl ? { relayUrl: services.relay.relayUrl } : {}),
    ...(services.relay.relayUrls ? { relayUrls: services.relay.relayUrls } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    ...(services.relay.runtimeAccessTokenSigner
      ? { runtimeAccessTokenSigner: services.relay.runtimeAccessTokenSigner }
      : {}),
    ...(services.relay.hostTunnelTokenSigner ? { hostTunnelTokenSigner: services.relay.hostTunnelTokenSigner } : {}),
    cliTokenEnv: plane.env,
    connectionRateLimiter: createFixedWindowConnectionRateLimiter({
      limit: plane.safetyLimits.connectionRateLimit,
      windowMs: plane.safetyLimits.connectionRateLimitWindowMs,
    }),
    controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({
      limit: plane.safetyLimits.controlPlaneRateLimit,
      windowMs: plane.safetyLimits.controlPlaneRateLimitWindowMs,
    }),
  }

  app.get("/api/claxedo/health", (c) =>
    c.json({
      ok: true,
      mode: "hosted-control-plane",
      localExecution: services.localExecution.enabled,
    }),
  )

  app.get("/api/claxedo/mode", (c) =>
    c.json({
      mode: "hosted-control-plane",
      signedAuth: services.auth.config.enabled,
      authority: !!services.authority,
      relay: !!services.relay.relayUrl,
      relayResolver: !!services.relay.resolverToken,
      runtimeAccessTokenSigner: !!services.relay.runtimeAccessTokenSigner,
      hostTunnelTokenSigner: !!services.relay.hostTunnelTokenSigner,
      deviceLogin: !!plane.deviceAuthProvider,
      workgraph: true,
    }),
  )

  app.get("/api/claxedo/compatibility", (c) => c.json(deploymentCompatibilityReport(plane.env)))

  // Minimal hosted shell-boot surface (events bus, health, bootstrap, path/
  // project/provider) — see routes/hosted-shell.ts for the shape contracts.
  app.route(
    "/",
    HostedShellRoutes({
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      ...(plane.env.npm_package_version ? { version: plane.env.npm_package_version } : {}),
      ...(services.authority ? { listWorkspaces: (auth) => services.authority!.listWorkspaces(auth) } : {}),
      ...(liveSyncRoom ? { liveSyncRoom } : {}),
      // The events route resolves the caller's AUTHORITY-INTERNAL org id at
      // connect so subscriber rooms + visibility share the namespace every
      // publisher stamps (documents/provision events, runtime-token claims).
      ...(services.authority ? { resolveOrgId: (auth) => services.authority!.resolveOrgId(auth) } : {}),
      activateOwner: ownerActivationWithTelemetry(services.telemetry, workGraphOwnerActivation),
    }),
  )

  app.route("/", JwksRoutes(plane.env))

  app.route(
    "/",
    HostedDeviceAuthRoutes({
      ...(plane.deviceAuthProvider ? { provider: plane.deviceAuthProvider } : {}),
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      env: plane.env,
      ...(services.authority ? { ensureCliUser: (auth) => services.authority!.usersMe(auth) } : {}),
    }),
  )

  app.route("/api/workspace", HostedWorkspaceRoutes(services, workspaceOptions))
  app.route("/api/workspace", WorkspaceCheckpointRoutes(services, {
    defaultHomeRegion: services.defaultHomeRegion,
  }))

  app.all("/api/workgraph", forwardWorkGraph)
  app.all("/api/workgraph/*", forwardWorkGraph)
  app.route(
    "/documents",
    DocumentsRoutes({
      ...(overrides.documentsBackend ? { backend: overrides.documentsBackend } : {}),
      services,
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      ...(services.authority ? { authority: services.authority } : {}),
      ...(liveSyncRoom
        ? {
            // Shared derivation + validation so this sink can never nudge an
            // `org:undefined`-style room the subscriber would not be held in.
            // `event.orgId` is the authority-internal org id (documents routes
            // scope by `authority.resolveOrgId`) — the SAME namespace the
            // hosted events route keys subscriber rooms with and
            // `eventVisibleTo` compares, so this frame reaches every signed
            // subscriber held in the document's org room. CAS-at-write remains
            // the correctness floor; this doorbell is freshness.
            documentChangedSink: (event) =>
              nudgeLiveSyncRoom(liveSyncRoom, liveSyncRoomNameForPrincipal({ orgId: event.orgId }), event),
          }
        : {}),
    }),
  )

  app.route("/api/claxedo/integrations", connectionsSetup)
  if (connectionOperationHandler) {
    if (workgraph.operationalTelemetry) {
      app.use("/internal/workgraph/connection-operation", workGraphHttpTelemetry(workgraph.operationalTelemetry))
    }
    app.post("/internal/workgraph/connection-operation", (context) => connectionOperationHandler(context.req.raw))
  }
  if (runOperationHandler) {
    if (workgraph.operationalTelemetry) {
      app.use("/internal/workgraph/run-operation", workGraphHttpTelemetry(workgraph.operationalTelemetry))
    }
    app.post("/internal/workgraph/run-operation", (context) => {
      // Build the per-request settlement dispatcher from the ExecutionContext
      // `waitUntil` (same as forwardWorkGraph) so a successful agent-tool operation
      // nudges continuous execution without waiting for the CF cron backstop.
      const waitUntil = guardedExecutionWaitUntil(context)
      const dispatcher =
        waitUntil && overrides.workGraphSettlementDispatcherForRequest
          ? overrides.workGraphSettlementDispatcherForRequest(waitUntil)
          : undefined
      return runOperationHandler(
        context.req.raw,
        dispatcher
          ? (principal) => dispatcher.nudge({ organizationId: principal.orgId, ownerUserId: principal.ownerUserId })
          : undefined,
      )
    })
  }

  // Billing (ADR 014 addendum): Polar webhook + checkout + portal live
  // on the CF Worker; all Polar code is confined to src/billing/** (enforced
  // by billing-architecture.test.ts). Unconfigured deployments keep the
  // routes mounted but every surface fails closed (503) at request time.
  app.route(
    "/api/billing",
    BillingRoutes({
      env: plane.env,
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    }),
  )

  if (!overrides.centralSessionRuntime) {
    app.get("/api/control/sessions", async (c) => {
      const workspaceId = c.req.query("workspaceId")
      if (!workspaceId || !services.authority?.listSessions) return c.json({ sessions: [] })
      const authResult = await signedOrError(
        c.req.raw,
        {
          authConfig: services.auth.config,
          ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
          requireSigned: true,
        },
        services,
      )
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      if (!authResult.auth) return c.json({ sessions: [] })
      return c.json({
        sessions: await services.authority.listSessions(authResult.auth, { workspaceId }),
      })
    })
    app.get("/api/control/sessions/:sessionId/gateway", async (c) => {
      const authResult = await signedOrError(
        c.req.raw,
        {
          authConfig: services.auth.config,
          ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
          requireSigned: true,
        },
        services,
      )
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      if (!authResult.auth || !services.authority?.resolveSession) {
        return c.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
      }
      const resolved = (await services.authority.resolveSession(authResult.auth, {
        sessionId: c.req.param("sessionId"),
      })) as { workspace_id?: string } | null
      if (!resolved?.workspace_id) {
        return c.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
      }
      return c.json({
        gatewayUrl: null,
        workspaceId: resolved.workspace_id,
        directory: null,
        harnessHost: "central",
      })
    })
    app.get("/api/control/sessions/:sessionId/messages", async (c) => {
      const workspaceId = c.req.query("workspaceId")
      if (!workspaceId || !services.authority?.readSessionMessages) {
        return c.json({ error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId is required" } }, 400)
      }
      const authResult = await signedOrError(
        c.req.raw,
        {
          authConfig: services.auth.config,
          ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
          requireSigned: true,
        },
        services,
      )
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      if (!authResult.auth) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, 401)
      }
      const body = await services.authority.readSessionMessages(authResult.auth, {
        sessionId: c.req.param("sessionId"),
        workspaceId,
      })
      return c.json({
        ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
        messages: hostedAuthorityMessages(body),
        maxEventOrdinal: 0,
      })
    })
  }

  app.route(
    "/api/control",
    HostedControlRoutes(services, {
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      cliTokenEnv: plane.env,
    }),
  )

  app.route(
    "/",
    InternalRelayResolverRoutes({
      resolverToken: plane.resolverToken,
      ...(services.authority ? { authority: services.authority } : {}),
      targetLookup: overrides.relayTargetLookup ?? plane.relayTargetLookup,
      // No localTargetExists — the hosted control plane has no local disk store.
    }),
  )

  app.route(
    "/",
    HostedSandboxAdminRoutes({
      adminToken: plane.env.CLAXEDO_RUNTIME_ADMIN_TOKEN,
      sandboxManager: services.sandbox.sandboxManager,
      telemetry: services.telemetry,
    }),
  )
  app.route(
    "/",
    HostedWorkGraphAdminRoutes({
      adminToken: plane.env.CLAXEDO_RUNTIME_ADMIN_TOKEN,
      ...(overrides.workGraphReconcile ? { reconcile: overrides.workGraphReconcile } : {}),
      telemetry: services.telemetry,
    }),
  )

  return app
}

function hostedAuthorityMessages(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const messages = (input as Record<string, unknown>).messages
  return Array.isArray(messages) ? messages : []
}

function ownerActivationWithTelemetry(
  telemetry: ControlPlaneServices["telemetry"],
  activate: (auth: SignedControlPlaneAuth) => Promise<HostedWorkGraphOwnerActivation>,
) {
  return async (auth: SignedControlPlaneAuth) => {
    const result = await activate(auth)
    const properties = {
      status: result.status,
      ...(result.status === "ready"
        ? {}
        : {
            code: result.error.code,
            capability: result.error.capability,
            reason: result.error.reason,
            retryable: result.error.retryable,
          }),
    }
    // A user turning on their catalog is a product-plane event, so it carries
    // the required-properties contract whenever the token names an org. This
    // shell only ever serves the hosted plane (createHostedApp asserts
    // CLAXEDO_DEPLOYMENT_MODE=hosted), which fixes deployment_mode. Personal-
    // account tokens carry no org claim; those stay on the plain capture rather
    // than inventing an org id that would corrupt every per-org aggregate.
    const identity = productIdentity(auth, { surface: "workgraph", deployment_mode: "cloud" })
    if (identity) {
      captureProduct(telemetry, "workgraph.catalog_activation", identity, properties)
      return
    }
    telemetry.capture(auth.user.subject, "workgraph.catalog_activation", properties)
  }
}
