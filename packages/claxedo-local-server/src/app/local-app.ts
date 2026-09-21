/**
 * The desktop-local server composition.
 *
 * Exactly the route families the split assigns to `local-server`. What it does
 * not mount is the point: no Connections, no Channels, no
 * hosted capability, no workspace authority, no cloud provisioning. Their absence from
 * an unsigned desktop is a composition fact here, not a runtime flag elsewhere.
 *
 * Registration order is load-bearing. Hono matches middleware and handlers in
 * registration order and a handler terminates the chain:
 *   - security headers and the peer-address stamp go first, ahead of CORS and
 *     the 404/onError paths, so no response can ship bare;
 *   - the session-meta tap and `/workspaces/:workspaceId` both go before the
 *     runtime proxy — the proxy answers those routes itself, so anything
 *     registered after it never sees them;
 *   - only routes registered after the proxy are subject to it.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { createNodeWebSocket } from "@hono/node-ws"
import { timingSafeEqual } from "node:crypto"
import { isLoopbackLocalRequest, peerAddressStamp } from "@claxedo/server-core/platform/http/peer-address"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"
import { unsignedLocalRequestGuard, deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import { controlPlaneAuthContext, ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { getHarnessMode, getWorkspaceProfile } from "@claxedo/server-core/platform/runtime/profile"
import { TelemetryTrackRoutes } from "@claxedo/server-core/platform/telemetry/track-route"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import {
  mountControlPlaneRouteContributions,
  type ControlPlaneRouteContribution,
} from "@claxedo/server-core/platform/http/route-contribution"
import type { RuntimeProxyOptions } from "../workspace/runtime-dispatch/internals"
import { createWorkspaceRuntimeProxy } from "../workspace/runtime-dispatch/middleware"
import { sessionMetaProjectionTap } from "../session/session-meta-tap"
import { AgentConfigRoutes } from "../agent-config/routes/index"
import { SessionMetaRoutes } from "../session/routes/meta-routes"
import { LocalWorkspaceRoutes } from "../workspace/routes/resolve-route"
import { ShellRoutes } from "../shell/routes"
import { createHostAggregateEventsHandler } from "../shell/host-events"
import { onEmbeddedWorkspaceRuntime } from "../deployments/local/embedded-workspace-runtime"
import { LocalProjectRoutes } from "../workspace/routes/projects-route"
import { CredentialRoutes } from "../credentials/routes/credential"
import { readMachineAgentUsage } from "../usage/adapters/token-tracker-usage-limits"
import { ProviderAuthRoutes } from "../credentials/routes/provider-auth"
import { NetworkPolicyRoutes } from "../sandbox/network/network-policy-routes"
import { hostServingEnrollmentId } from "@claxedo/host-serving/serving"
import { HostServingRoutes } from "../workspace/host-serving-routes"
import { HostProviderConfigRoutes } from "../workspace/host-provider-config-routes"
import { BootstrapRoutes } from "../deployments/shared-routes/bootstrap"
import { daemonAdmission, markInProcessDaemonRequest } from "./daemon-admission"
import { relayReplayAdmission } from "../workspace/runtime-dispatch/relay-admission"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "../deployments/local/server-workspace-pty-proxy"
import { LocalUsageRoutes } from "@claxedo/server-core/usage/routes"
import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  inProcessFetch,
  mcpAuditRecord,
  type LoopbackFirstPartyMcpOptions,
} from "@claxedo/mcp"
import { TASKS_OPERATIONS } from "@claxedo/server-core/tasks-host/capability"
import { SandboxDriverSettingsRoutes } from "@claxedo/server-core/sandbox/routes/sandbox-driver-settings-routes"
import { BROKER_ROUTE_PATTERN, isBrokerPath, loopbackBrokerRoutes } from "@claxedo/egress-broker"
import type { LocalDaemonLifecycle } from "./local-daemon-lifecycle"
import { raw, record } from "../platform/json"
import { localDocumentsRoutes } from "./local-documents"

/**
 * Paths whose responses carry credential material: the registry routers, and
 * the broker mount that spends a stored key at the vendor.
 *
 * They are same-origin by definition — the loopback control plane talking to
 * itself — so they must never get an ACAO header. The defense is the browser
 * refusing the cross-origin READ, which it only does when none comes back.
 */
export function isLocalCredentialPath(path: string): boolean {
  return /^\/api\/claxedo\/(credentials|integrations)\b/.test(path) || isBrokerPath(path)
}

/**
 * Which origins the desktop-local server answers.
 *
 * Its own — the only origin a page this daemon served can present — plus the
 * browser origins the composition explicitly declared, which today is the
 * development renderer the launcher names. Every other origin that can reach
 * the port is a caller, not a reader: a `localhost:*` page the user happens
 * to have open shares the loopback but holds nothing that proves it is the
 * application. Deliberately not paired with `credentials: true` — see the
 * cors mount below.
 */
export function localCorsOrigin(
  origin: string,
  ownOrigin: string,
  browserOrigins: readonly string[] = [],
): string | undefined {
  if (origin === ownOrigin) return origin
  return browserOrigins.includes(origin) ? origin : undefined
}

export type LocalAppOptions = {
  egressBroker?: (request: Request) => Promise<Response>
  services: ControlPlaneServicesContract
  corsOrigin?: (origin: string, path: string) => string | undefined
  /**
   * Browser origins beyond the daemon's own that may read its answers — the
   * development renderer the launcher declares. The default CORS policy
   * reflects exactly this set and the request's own origin; a `corsOrigin`
   * override owns the question entirely.
   */
  browserOrigins?: readonly string[]
  runtimeProxyOptions?: RuntimeProxyOptions
  /** Answers `/workspaces/:workspaceId`; registered ahead of the runtime proxy. */
  workspaceRelayProxy?: MiddlewareHandler
  onError?: Parameters<Hono["onError"]>[0]
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  env?: NodeJS.ProcessEnv
  usage?: Parameters<typeof LocalUsageRoutes>[0]
  /** Explicit build/composition contributions; absent in the disabled product. */
  routeContributions?: readonly ControlPlaneRouteContribution[]
  /**
   * The first-party MCP endpoint for the sessions this server launches. The
   * verifier is the runtime's own credential issuer; the client factory is
   * handed this app's in-process fetch for the credential's workspace.
   */
  firstPartyMcp?: LoopbackFirstPartyMcpOptions
  /** Machine-local daemon control surface. Never exposed to the renderer. */
  daemon?: {
    identity: {
      token: string
      protocol: number
      generation: string
      pid: number
    }
    lifecycle: LocalDaemonLifecycle
  }
}

function authRouteOptions(services: ControlPlaneServicesContract) {
  return {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }
}

/**
 * Outermost middleware: the counterpart to the hosted `securityHeaders()`,
 * mounted once at composition so "no route can ship bare" is a property of the
 * shell rather than a per-route review item. Written AFTER `next()` so it also
 * covers the CORS preflight, the 404 handler, and whatever `onError` produced —
 * a 500 without `nosniff` is precisely the response worth sniffing.
 */
export function localSecurityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const entries = [
      ...securityHeaderEntries({ https: requestIsHttps(c.req) }),
      ...(c.res.headers.get("cache-control")?.includes("public")
        ? []
        : [["cache-control", "no-store"]] as const),
    ]
    const stamped = withSecurityHeaders(c.res, entries)
    if (stamped !== c.res) c.res = stamped
  }
}

export function mountLocalRouteFamilies(app: Hono, options: LocalAppOptions) {
  const { services } = options
  const env = options.env ?? process.env
  if (!services.localExecution.enabled) {
    throw new Error("createLocalApp is the desktop-local composition; it requires localExecution")
  }
  // `@hono/node-ws` declares `injectWebSocket` with method syntax, so it is
  // called through the object rather than detached from it. `upgradeWebSocket`
  // is a plain property and is safe to pull off.
  const nodeWebSocket = createNodeWebSocket({ app })
  const { upgradeWebSocket } = nodeWebSocket
  const runtimeProxyOptions = options.runtimeProxyOptions ?? {}
  // The desktop daemon hosts every local runtime in-process and issues no
  // sessions, so it always serves the host aggregate. The bootstrap declares
  // this object's own `hostEventStream`, so a client cannot be told a stream
  // the proxy below does not answer.
  const runtimeProxy = {
    ...runtimeProxyOptions,
    hostEventStream: createHostAggregateEventsHandler({ observe: onEmbeddedWorkspaceRuntime }),
  }

  app.use(localSecurityHeaders())
  app.use(peerAddressStamp())
  if (options.onError) app.onError(options.onError)

  app.use(
    cors({
      origin: (origin, c) => {
        if (!origin) return undefined
        // Credential-bearing routes are same-origin: the loopback control plane
        // talking to itself. Never reflect an ACAO for them — the header
        // defense relies on the browser blocking the cross-origin READ, which
        // it only does when no ACAO comes back.
        if (isLocalCredentialPath(c.req.path)) return undefined
        // The MCP route is reached by harness processes, never by a page; a
        // loopback page granted an ACAO here could drive it from a browser.
        if (c.req.path === CLAXEDO_MCP_PATH) return undefined
        if (options.corsOrigin) return options.corsOrigin(origin, c.req.path)
        return localCorsOrigin(origin, new URL(c.req.url).origin, options.browserOrigins ?? [])
      },
      maxAge: 86400,
      // `credentials: true` is deliberately not set, matching the self-hosted
      // composition: turning it on would let any origin this policy approves
      // complete a credentialed cross-origin read.
    }),
  )

  app.use(unsignedLocalRequestGuard({ mode: deploymentMode(env), authConfig: services.auth.config }))

  // Admission is a property of the composition, so it is mounted once here
  // rather than reviewed on each family below. The exemptions are exactly the
  // callers that prove themselves another way: readiness probes, mounts that
  // verify a scoped credential of their own (the broker's runtime token, the
  // first-party MCP's runtime credential, the agent-hook token, and the
  // daemon lifecycle routes' bearer — the same secret under its own header),
  // and requests the relay dispatcher verifies for the workspace they name.
  // A composition with no daemon identity mints no capability and keeps the
  // unsigned local posture instead.
  if (options.daemon) {
    app.use(daemonAdmission({
      capability: options.daemon.identity.token,
      isPublicProbe: (method, pathname) =>
        method === "GET" && (pathname === "/api/claxedo/health" || pathname === "/global/health"),
      hasOwnCredentialAuthority: (pathname) =>
        pathname === CLAXEDO_MCP_PATH ||
        pathname.startsWith(`${CLAXEDO_MCP_PATH}/`) ||
        isBrokerPath(pathname) ||
        pathname === "/api/wr/hook" ||
        pathname.startsWith("/api/wr/hook/") ||
        pathname === "/api/claxedo/daemon" ||
        pathname.startsWith("/api/claxedo/daemon/"),
      relayReplay: (request) => relayReplayAdmission(request, runtimeProxy),
    }))
  }

  if (options.egressBroker) {
    const routes = loopbackBrokerRoutes({ broker: options.egressBroker, isLoopback: isLoopbackLocalRequest })
    app.all(BROKER_ROUTE_PATTERN, (c) => routes(c.req.raw))
  }

  app.route("/", TelemetryTrackRoutes({ auth: services.auth, telemetry: services.telemetry }))

  // The same body the self-hosted composition returns. The shell reads these
  // fields; an `{ ok: true }` stub would be a silent regression.
  app.get("/api/claxedo/health", (c) =>
    c.json({
      ok: true,
      harnessMode: getHarnessMode(),
      workspaceProfile: getWorkspaceProfile(),
      localExecution: services.localExecution.enabled,
    }))
  app.get("/global/health", (c) =>
    c.json({ healthy: true, version: env.npm_package_version || "1.0.0" }))
  if (options.daemon) {
    const { identity, lifecycle } = options.daemon
    const authorized = (provided: string | undefined) => {
      const token = provided?.replace(/^Bearer\s+/i, "") ?? ""
      const expectedBytes = Buffer.from(identity.token)
      const providedBytes = Buffer.from(token)
      return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
    }
    const unauthorized = (c: Context) =>
      c.json({ error: { code: "daemon_identity_unauthorized", message: "Daemon token is invalid" } }, 401)
    app.get("/api/claxedo/daemon", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      return c.json({
        service: "claxedo-local-daemon",
        protocol: identity.protocol,
        generation: identity.generation,
        pid: identity.pid,
      })
    })
    app.get("/api/claxedo/daemon/state", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      return c.json(lifecycle.snapshot())
    })
    app.post("/api/claxedo/daemon/leases", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      const lease = lifecycle.acquire(c.req.header("x-claxedo-daemon-client")?.trim() || "desktop")
      if (!lease) return c.json({ error: { code: "daemon_stopping", message: "Daemon is stopping" } }, 409)
      return c.json(lease, 201)
    })
    app.put("/api/claxedo/daemon/leases/:leaseId", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      const lease = lifecycle.renew(c.req.param("leaseId"))
      if (!lease) return c.json({ error: { code: "daemon_lease_not_found", message: "Daemon lease was not found" } }, 404)
      return c.json(lease)
    })
    app.delete("/api/claxedo/daemon/leases/:leaseId", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      return c.json({ released: lifecycle.release(c.req.param("leaseId")) })
    })
    app.post("/api/claxedo/daemon/shutdown", async (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      const leaseId = raw(record(await c.req.json().catch(() => undefined))?.leaseId)
      if (!leaseId) {
        return c.json({ error: { code: "daemon_shutdown_invalid_body", message: "A lease ID is required" } }, 400)
      }
      return c.json(lifecycle.requestShutdown(leaseId))
    })
  }

  app.route("/", BootstrapRoutes({
    services,
    env,
    hostAggregateEvents: !!runtimeProxy.hostEventStream,
    // Read per request off the live serving arrangement, which Electron main
    // installs through `/api/claxedo/host-serving` after this route is
    // mounted: the daemon starts before the machine has enrolled and outlives
    // every sign-out.
    hostEnrollmentId: hostServingEnrollmentId,
    ...authRouteOptions(services),
  }))
  app.route("/", ProviderAuthRoutes(services, authRouteOptions(services)))
  app.route("/api/claxedo/credentials", CredentialRoutes(services.credentials, {
    agentUsage: readMachineAgentUsage,
    ...authRouteOptions(services),
    ...(env.CLAXEDO_CREDENTIALS_TOKEN?.trim() ? { token: env.CLAXEDO_CREDENTIALS_TOKEN.trim() } : {}),
    // Derived from the environment, matching the self-hosted composition —
    // never caller-supplied, since an omitted hook would leave credential
    // mutation behind only the loopback guard on a signed box.
    ...(deploymentMode(env) === "hosted" || env.CLAXEDO_SIGNED_CLOUD_AUTH === "1"
      ? {
          authenticate: async (request: Request) => {
            const auth = await controlPlaneAuthContext(request, {
              config: services.auth.config,
              ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
            })
            if (auth.mode !== "signed") {
              throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
            }
          },
        }
      : {}),
  }))

  // Registered before the runtime proxy, which answers `/session` itself.
  app.use(sessionMetaProjectionTap(services.projectionStore))

  // Before the runtime proxy on purpose — both claim `/workspaces/:workspaceId`.
  if (options.workspaceRelayProxy) {
    app.all("/workspaces/:workspaceId", options.workspaceRelayProxy)
    app.all("/workspaces/:workspaceId/*", options.workspaceRelayProxy)
  }
  mountWorkspaceRuntimePtyWebSocketProxy(app, upgradeWebSocket, runtimeProxyOptions)
  if (options.usage) app.route("/api/claxedo/usage", LocalUsageRoutes(options.usage))

  // Route execution traffic to the workspace runtime. `/api/wr/*` is
  // workspace-owned; `/api/cp/events` stays with the control plane.
  app.use(createWorkspaceRuntimeProxy(runtimeProxy))

  app.route("/", ShellRoutes({
    upgradeWebSocket,
    services,
    env,
    ...authRouteOptions(services),
  }))
  app.route("/documents", localDocumentsRoutes(authRouteOptions(services)))
  app.route("/api/claxedo/agent-config", AgentConfigRoutes({
    services,
    ...authRouteOptions(services),
  }))
  app.route("/", SessionMetaRoutes({
    services,
    ...authRouteOptions(services),
    ...(options.refreshSessionProjection ? { refreshSessionProjection: options.refreshSessionProjection } : {}),
  }))
  const localWorkspaceRoutes = LocalWorkspaceRoutes(authRouteOptions(services))
  const sandboxDriverSettingsRoutes = SandboxDriverSettingsRoutes({
    credentials: services.credentials,
    env,
    ...authRouteOptions(services),
  })
  app.route("/api/claxedo/workspace", localWorkspaceRoutes)
  app.route("/api/claxedo/workspace", sandboxDriverSettingsRoutes)
  app.route("/api/claxedo/projects", LocalProjectRoutes(authRouteOptions(services)))
  // The renderer's inventory contract uses the hosted-compatible list path in
  // every product. On desktop, the authoritative local workspace store answers
  // it; this avoids treating an intentionally absent hosted router as a 404.
  app.route("/api/workspace", localWorkspaceRoutes)
  app.route("/api/workspace", sandboxDriverSettingsRoutes)
  app.route("/api/claxedo/network-policy", NetworkPolicyRoutes(authRouteOptions(services)))
  app.route("/api/claxedo/host-serving", HostServingRoutes())
  app.route("/api/claxedo/host-provider-config", HostProviderConfigRoutes())
  // Optional product route families (Agent Plugins today) arrive as
  // contributions from the composition rather than as imports here, so this
  // module keeps one mounting path and no knowledge of which products exist.
  mountControlPlaneRouteContributions({
    contributions: options.routeContributions ?? [],
    mount: (contribution) => app.route(contribution.path, contribution.routes),
  })
  if (options.firstPartyMcp) {
    const { firstPartyMcp } = options
    app.route(CLAXEDO_MCP_PATH, createClaxedoMcpRoutes({
      mount: "loopback",
      verifyRuntimeCredential: firstPartyMcp.verifyRuntimeCredential,
      createClient: async (credential, request) => {
        if (credential.kind !== "runtime") throw new Error("A local MCP client requires a runtime credential")
        const workspace = await resolveWorkspace({ workspaceId: credential.workspaceId })
        if (!workspace || workspace.kind !== "local") throw new Error("The runtime workspace is unavailable")
        const localFetch = inProcessFetch(
          (runtimeRequest) => app.fetch(markInProcessDaemonRequest(runtimeRequest)),
          { "x-workspace-id": credential.workspaceId },
        )
        return firstPartyMcp.createClient({
          deployment: "loopback",
          credential,
          request,
          documents: { fetch: localFetch },
          // Every operation, and no capability: this server is both the
          // runtime host and the control plane, so the grant a hosted root
          // carries has nothing to say here — the loopback fetch already
          // reaches the one machine whose tasks these are.
          tasks: { fetch: localFetch, operations: TASKS_OPERATIONS },
          local: {
            fetch: localFetch,
            workspace: { workspaceId: credential.workspaceId, directory: workspace.directory },
          },
        })
      },
      registerTools: firstPartyMcp.registerTools ?? [],
      enabledToolGroups: firstPartyMcp.enabledToolGroups,
      audit: (event) => console.info("[claxedo-local-server] mcp.audit", mcpAuditRecord(event)),
      ...(firstPartyMcp.crossMachineWrites ? { crossMachineWrites: firstPartyMcp.crossMachineWrites } : {}),
    }).routes)
  }

  return { injectWebSocket: (server: Parameters<typeof nodeWebSocket.injectWebSocket>[0]) => nodeWebSocket.injectWebSocket(server) }
}

export function createLocalApp(options: LocalAppOptions) {
  const app = new Hono()
  const { injectWebSocket } = mountLocalRouteFamilies(app, options)
  return { app, injectWebSocket }
}
