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
import type { LocalDaemonLifecycle, MachineRecoveryCaller } from "./local-daemon-lifecycle"
import {
  RecoveryContractError,
  parseRecoveryRequest,
  serializeRecoveryOutcome,
  type RecoveryOutcome,
  type RecoveryRefusal,
  type RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { machineRecoveryFence } from "./daemon-admission"
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
 * Loopback plus the product's own web origin. Deliberately not paired with
 * `credentials: true` — see the cors mount below.
 */
/**
 * The management protocol the caller declares. Both halves of this protocol
 * are literals in two packages, so a client that does not send it is one built
 * before the header existed and is refused rather than guessed at.
 */
export const DAEMON_PROTOCOL_HEADER = "x-claxedo-daemon-protocol"

const RECOVERY_REFUSAL_STATUS: Readonly<Record<RecoveryRefusal["kind"], 403 | 409 | 410 | 426 | 503>> = {
  generation_conflict: 409,
  intent_conflict: 409,
  scope_changed: 409,
  receipt_expired: 410,
  unauthorized: 403,
  unavailable: 503,
  version_update_required: 426,
}

function recoveryOutcome(c: Context, outcome: RecoveryOutcome) {
  const status = outcome.kind === "operation" ? 200 : RECOVERY_REFUSAL_STATUS[outcome.refusal.kind]
  return c.body(serializeRecoveryOutcome(outcome), status, { "content-type": "application/json" })
}

/**
 * Only the daemon bearer reaches these routes, and that bearer IS this
 * machine's authority. The client name is a label for the receipt, never the
 * authority: a caller able to name its own authority could escalate itself.
 */
function daemonCaller(c: Context): MachineRecoveryCaller {
  const client = c.req.header("x-claxedo-daemon-client")?.trim()
  return { callerId: `daemon-capability:${client || "unnamed"}`, authority: "machine" }
}

export function localCorsOrigin(origin: string): string | undefined {
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
  return undefined
}

export type LocalAppOptions = {
  egressBroker?: (request: Request) => Promise<Response>
  services: ControlPlaneServicesContract
  corsOrigin?: (origin: string, path: string) => string | undefined
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
      /**
       * This process's OS creation identity, for a launcher that must signal
       * it. A reader rather than a value: it is read from the OS after the
       * listener is up, and the route answers whatever it says at request time.
       */
      creation?: () => unknown
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
        return (options.corsOrigin ?? localCorsOrigin)(origin, c.req.path)
      },
      maxAge: 86400,
      // `credentials: true` is deliberately not set, matching the self-hosted
      // composition: turning it on would let any origin this policy approves
      // complete a credentialed cross-origin read.
    }),
  )

  app.use(unsignedLocalRequestGuard({ mode: deploymentMode(env), authConfig: services.auth.config }))

  // Ahead of every route family, the broker and telemetry included: a machine
  // that has not established what it owns must not spend a stored key at a
  // vendor, and the fence is a property of the composition rather than a review
  // item on each mount.
  if (options.daemon) {
    const { lifecycle } = options.daemon
    app.use(machineRecoveryFence(() => lifecycle.recovery.ingressClosed()))
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
    /**
     * A client that does not state a protocol this daemon serves is refused
     * before anything else answers it. That refusal is what a launcher acts on
     * instead of deciding, from a failed call, that the daemon is unhealthy and
     * signalling a pid it never identified.
     */
    const incompatible = (c: Context) => {
      const declared = Number(c.req.header(DAEMON_PROTOCOL_HEADER))
      if (declared === identity.protocol) return undefined
      return c.body(
        serializeRecoveryOutcome({
          kind: "refused",
          refusal: {
            kind: "version_update_required",
            message: `This daemon serves management protocol ${identity.protocol}; the caller declared ${
              Number.isInteger(declared) ? String(declared) : "none"
            }. Update both halves and restart.`,
            contractVersion: identity.protocol,
          },
        }),
        426,
        { "content-type": "application/json" },
      )
    }
    const guard = (c: Context) => (authorized(c.req.header("authorization")) ? incompatible(c) : unauthorized(c))
    // The identity route answers its own protocol to any authorized caller:
    // refusing it on version would leave an old client unable to learn why.
    app.get("/api/claxedo/daemon", (c) => {
      if (!authorized(c.req.header("authorization"))) return unauthorized(c)
      const creation = identity.creation?.()
      return c.json({
        service: "claxedo-local-daemon",
        protocol: identity.protocol,
        generation: identity.generation,
        pid: identity.pid,
        ...(creation === undefined ? {} : { identity: creation }),
      })
    })
    app.get("/api/claxedo/daemon/state", (c) => {
      const refused = guard(c)
      if (refused) return refused
      return c.json(lifecycle.snapshot())
    })
    app.get("/api/claxedo/daemon/recovery", (c) => {
      const refused = guard(c)
      if (refused) return refused
      return c.json(lifecycle.recovery.inspect())
    })
    app.post("/api/claxedo/daemon/recovery", async (c) => {
      const refused = guard(c)
      if (refused) return refused
      let request: RecoveryRequest
      try {
        request = parseRecoveryRequest(await c.req.json().catch(() => undefined))
      } catch (error) {
        if (!(error instanceof RecoveryContractError)) throw error
        return c.json(
          { error: { code: "recovery_request_invalid", message: error.message, data: { code: error.code } } },
          400,
        )
      }
      return recoveryOutcome(c, lifecycle.recovery.submit(request, daemonCaller(c)))
    })
    app.get("/api/claxedo/daemon/recovery/operations/:operationId", (c) => {
      const refused = guard(c)
      if (refused) return refused
      return recoveryOutcome(c, lifecycle.recovery.read(c.req.param("operationId")))
    })
    app.post("/api/claxedo/daemon/leases", (c) => {
      const refused = guard(c)
      if (refused) return refused
      const lease = lifecycle.acquire(c.req.header("x-claxedo-daemon-client")?.trim() || "desktop")
      if (!lease) return c.json({ error: { code: "daemon_stopping", message: "Daemon is stopping" } }, 409)
      return c.json(lease, 201)
    })
    app.put("/api/claxedo/daemon/leases/:leaseId", (c) => {
      const refused = guard(c)
      if (refused) return refused
      const lease = lifecycle.renew(c.req.param("leaseId"))
      if (!lease) return c.json({ error: { code: "daemon_lease_not_found", message: "Daemon lease was not found" } }, 404)
      return c.json(lease)
    })
    app.delete("/api/claxedo/daemon/leases/:leaseId", (c) => {
      const refused = guard(c)
      if (refused) return refused
      return c.json({ released: lifecycle.release(c.req.param("leaseId")) })
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
        const localFetch = inProcessFetch((runtimeRequest) => app.fetch(runtimeRequest), { "x-workspace-id": credential.workspaceId })
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
