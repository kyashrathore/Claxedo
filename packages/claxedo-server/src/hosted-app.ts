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
 *   GET  /api/claxedo/events      (auth-gated SSE heartbeat stream)
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

import { Hono } from "hono"
import { cors } from "hono/cors"
import { allowedOriginPatterns } from "./cors-origins"
import { JwksRoutes } from "./control-plane/routes/jwks"
import { InternalRelayResolverRoutes, type RelayTargetLookup } from "./routes/internal-relay"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./routes/hosted-workspace"
import { signedOrError } from "./routes/workspace-user-hosted"
import { HostedDeviceAuthRoutes } from "./routes/hosted-device-auth"
import { HostedShellRoutes } from "./routes/hosted-shell"
import { HostedSandboxAdminRoutes } from "./routes/hosted-sandbox-admin"
import { HostedWorkGraphAdminRoutes, type WorkGraphReconcileResult } from "./routes/hosted-workgraph-admin"
import { HostedControlRoutes } from "./routes/hosted-control"
import { HostedWorkerCompositionError, type HostedControlPlane } from "./control-plane/hosted-services"
import type { ControlPlaneServices } from "./control-plane/services"
import { createFixedWindowConnectionRateLimiter } from "./control-plane/rate-limit"
import { BillingRoutes } from "./billing/billing-routes"
import { createEntitlementGate, type EntitlementGate } from "./billing/entitlement"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "./control-plane/auth"
import { deploymentCompatibilityReport } from "./deployment-compatibility"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "./control-plane/deployment-mode"
import {
  createHostedWorkGraph,
  type HostedWorkGraph,
  type HostedWorkGraphOwnerActivation,
} from "./workgraph-host/hosted"
import {
  createHostedConnectionOperationExecutor,
  createHostedConnectionOperationHandler,
} from "./workgraph-host/hosted-connection-operation"
import {
  createHostedAttemptOperationExecutor,
  createHostedAttemptOperationHandler,
} from "./workgraph-host/hosted-attempt-operation"
import { createHostedSessionTranscriptRetention } from "./workgraph-host/hosted-runtime"
import { createHostedConnectionsSetup } from "./workgraph-host/hosted-connections-setup"
import { DocsRoutes } from "./routes/docs"
import { createConvexDocumentStore } from "./document-host/convex-store"
import type { DocumentStore } from "./document-store"
import { workGraphHttpTelemetry } from "./workgraph-host/operational-telemetry"

export type HostedAppOverrides = {
  /** Hosted relay target lookup. Omitted → the plane's composed lookup is used. */
  relayTargetLookup?: RelayTargetLookup
  /** Node-only hosted deployments mount the real central runtime separately. */
  centralSessionRuntime?: boolean
  /** Test/custom composition seam; production composes Convex from env. */
  workgraph?: HostedWorkGraph
  /** Test/custom seam for signed bootstrap owner activation. */
  workGraphOwnerActivation?: (auth: SignedControlPlaneAuth) => Promise<HostedWorkGraphOwnerActivation>
  /** Bounded durable reconciler shared by cron and the protected admin trigger. */
  workGraphReconcile?: () => Promise<WorkGraphReconcileResult>
  /** Test seam for the complete_attempt transcript-retention gate. */
  attemptTranscriptRetention?: (input: {
    organizationId: string
    ownerUserId: string
    workspaceId: string
    sessionId: string
  }) => Promise<void>
  /** Deterministic hosted capability gate for component tests. */
  entitlementGate?: EntitlementGate
  /** Test/custom storage seam; production composes Convex from env. */
  documentStore?: (auth: SignedControlPlaneAuth) => DocumentStore
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

function corsMiddleware(appOriginAllowed: (origin: string) => boolean, originPatterns: RegExp[]) {
  return cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (origin.startsWith("http://localhost:")) return origin
      if (origin.startsWith("http://127.0.0.1:")) return origin
      if (originPatterns.some((pattern) => pattern.test(origin))) return origin
      if (appOriginAllowed(origin)) return origin
      return undefined
    },
    maxAge: 86400,
  })
}

/**
 * D9 fail-closed hosted boot assertion (runs for BOTH hosted entrypoints —
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

export function createHostedApp(plane: HostedControlPlane, overrides: HostedAppOverrides = {}) {
  assertHostedAppBootConfig(plane)
  const { services } = plane
  const app = new Hono()
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
      telemetry: services.telemetry,
    })
  const workGraphOwnerActivation = overrides.workGraphOwnerActivation
    ? overrides.workGraphOwnerActivation
    : workgraph.activateOwner
  const connectionOperationExecutor = createHostedConnectionOperationExecutor({ env: plane.env })
  const connectionOperationHandler = connectionOperationExecutor
    ? createHostedConnectionOperationHandler({ env: plane.env, execute: connectionOperationExecutor })
    : undefined
  const attemptTranscriptRetention =
    overrides.attemptTranscriptRetention ?? createHostedSessionTranscriptRetention(plane.env, services)
  const attemptOperationExecutor = createHostedAttemptOperationExecutor({
    env: plane.env,
    ...(attemptTranscriptRetention ? { retainTranscript: attemptTranscriptRetention } : {}),
  })
  const attemptOperationHandler = attemptOperationExecutor
    ? createHostedAttemptOperationHandler({ env: plane.env, execute: attemptOperationExecutor })
    : undefined
  const forwardWorkGraph = (request: Request) => {
    const url = new URL(request.url)
    url.pathname = url.pathname === "/api/workgraph" ? "/" : url.pathname.slice("/api/workgraph".length)
    return workgraph.router.fetch(new Request(url, request))
  }

  app.use(
    corsMiddleware(
      configuredAppOrigins(plane.env.CLAXEDO_APP_ORIGINS),
      allowedOriginPatterns(plane.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES),
    ),
  )

  // D9: global unsigned-local gate, defense-in-depth here — the boot
  // assertion above guarantees signed auth, so this only fires if a hosted
  // composition somehow reaches serving unsigned (then: down, not open).
  app.use(
    unsignedLocalRequestGuard({
      mode: "hosted",
      authConfig: services.auth.config,
    }),
  )

  // D6/B4 — the ONE entitlement predicate behind the hosted choke points
  // (src/billing/entitlement.ts). The org whose subscription matters is the
  // caller's ACTIVE org (Clerk org claim if a member, else the personal org),
  // resolved through the same authority call the rest of the control plane
  // uses. Gate errors resolve to fail-closed denials inside the gate.
  const entitlementGate = overrides.entitlementGate ?? createEntitlementGate({ env: plane.env })
  const connectionsSetup = createHostedConnectionsSetup({
    env: plane.env,
    authConfig: services.auth.config,
    executor: workgraph.executor,
    serviceToken: workgraph.serviceToken,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    requireEntitlement: (clerkOrgId) => entitlementGate({ clerkOrgId }, "hosted-connections"),
  })
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

  const workspaceOptions: HostedWorkspaceRouteOptions = {
    requireCloudWorkspaceEntitlement,
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

  app.all("/api/workgraph", (context) => forwardWorkGraph(context.req.raw))
  app.all("/api/workgraph/*", (context) => forwardWorkGraph(context.req.raw))
  app.route(
    "/api/claxedo/docs",
    DocsRoutes({
      services,
      authConfig: services.auth.config,
      ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      ...(services.authority ? { authority: services.authority } : {}),
      store: (auth) => {
        if (!auth) {
          throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
        }
        if (overrides.documentStore) return overrides.documentStore(auth)
        const url = plane.env.CLAXEDO_WORKSPACE_AUTHORITY_URL?.trim()
        const serviceToken = plane.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN?.trim()
        if (!url || !serviceToken) {
          throw new HostedWorkerCompositionError(
            "hosted_dependency_missing",
            "Hosted document storage requires Convex authority URL and Control Plane service token",
          )
        }
        return createConvexDocumentStore({ url, serviceToken, auth })
      },
    }),
  )
  app.route("/api/claxedo/integrations", connectionsSetup)
  if (connectionOperationHandler) {
    if (workgraph.operationalTelemetry) {
      app.use("/internal/workgraph/connection-operation", workGraphHttpTelemetry(workgraph.operationalTelemetry))
    }
    app.post("/internal/workgraph/connection-operation", (context) => connectionOperationHandler(context.req.raw))
  }
  if (attemptOperationHandler) {
    if (workgraph.operationalTelemetry) {
      app.use("/internal/workgraph/attempt-operation", workGraphHttpTelemetry(workgraph.operationalTelemetry))
    }
    app.post("/internal/workgraph/attempt-operation", (context) => attemptOperationHandler(context.req.raw))
  }

  // WP-BILLING (D4, ADR 014 addendum): Polar webhook + checkout + portal live
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
    telemetry.capture(auth.user.subject, "workgraph.catalog_activation", {
      status: result.status,
      ...(result.status === "ready"
        ? {}
        : {
            code: result.error.code,
            capability: result.error.capability,
            reason: result.error.reason,
            retryable: result.error.retryable,
          }),
    })
  }
}
