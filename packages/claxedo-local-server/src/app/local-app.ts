/**
 * The desktop-local server composition.
 *
 * Exactly the route families this plan assigns to `local-server`, and nothing
 * else. What it does NOT mount is the point: no Documents, no Connections, no
 * Channels, no WorkGraph, no workspace authority, no cloud provisioning. Those
 * are hosted capabilities, and their absence from an unsigned desktop is a
 * composition fact here rather than a runtime flag somewhere else.
 *
 * `@claxedo/server`'s self-hosted `createApp` composes the same local mounts
 * alongside its hosted ones; this is the local half on its own, for a build
 * that has no hosted half at all.
 *
 * ORDER IS LOAD-BEARING. Hono matches middleware and handlers in registration
 * order and a handler terminates the chain, so:
 *   - the security headers and peer-address stamp go first, ahead of CORS and
 *     the 404/onError paths, so no response can ship bare;
 *   - `/workspaces/:workspaceId` is registered BEFORE `workspaceRuntimeProxy`
 *     precisely so the relay proxy answers it instead of the runtime proxy —
 *     both claim that path, and registration order is what picks;
 *   - the runtime proxy is a `use`, so only routes registered AFTER it are
 *     subject to it.
 */

import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { createNodeWebSocket } from "@hono/node-ws"
import { peerAddressStamp } from "@claxedo/server-core/platform/http/peer-address"
import { eventsHandler } from "@claxedo/server-core/platform/http/events"
import { unsignedLocalRequestGuard, deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { RuntimeProxyOptions } from "../workspace/runtime-dispatch/internals"
import { createWorkspaceRuntimeProxy } from "../workspace/runtime-dispatch/middleware"
import { AgentConfigRoutes } from "../agent-config/routes/index"
import { SessionMetaRoutes } from "../session/routes/meta-routes"
import { OpenCodeCompatRoutes } from "../opencode/compat-routes/index"
import { CredentialRoutes } from "../credentials/routes/credential"
import { ProviderAuthRoutes } from "../credentials/routes/provider-auth"
import { NetworkPolicyRoutes } from "../sandbox/network/network-policy-routes"
import { BootstrapRoutes } from "../deployments/shared-routes/bootstrap"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "../deployments/local/server-workspace-pty-proxy"
import { mountLocalOnlyUsageLimits } from "../deployments/local/server-usage-limits"
import { resolveHarnessId } from "../opencode/compat-routes/provider-config"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"

export type LocalAppOptions = {
  services: ControlPlaneServicesContract
  /** Applied outermost; the host supplies its own policy. */
  securityHeaders: MiddlewareHandler
  /** Same-origin credential paths that must never get an ACAO header. */
  isCredentialPath: (path: string) => boolean
  corsOrigin: (origin: string, path: string) => string | undefined
  runtimeProxyOptions?: RuntimeProxyOptions
  /** Answers `/workspaces/:workspaceId`; registered ahead of the runtime proxy. */
  workspaceRelayProxy?: MiddlewareHandler
  onOpencodeAccess?: () => void
  onError?: Parameters<Hono["onError"]>[0]
  updateCentralSessionModel?: (sessionId: string, model: { providerID: string; modelID: string }) => Promise<void>
  invalidateCentralSession?: (sessionId: string) => void
  health?: () => Record<string, unknown>
  /** Stricter credential-route authentication, when the host requires signed access. */
  authenticateCredentials?: (request: Request) => Promise<void>
}

function authRouteOptions(services: ControlPlaneServicesContract) {
  return {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }
}

export function mountLocalRouteFamilies(app: Hono, options: LocalAppOptions) {
  const { services } = options
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  const runtimeProxyOptions = options.runtimeProxyOptions ?? {}

  app.use(options.securityHeaders)
  app.use(peerAddressStamp())
  if (options.onError) app.onError(options.onError)

  app.use(
    cors({
      origin: (origin, c) => {
        if (!origin) return undefined
        // Credential-bearing routes are same-origin (the loopback control plane
        // talking to itself). Never reflect an Access-Control-Allow-Origin for
        // them: the header defense relies on the browser blocking the
        // cross-origin READ, which it only does when no ACAO comes back.
        if (options.isCredentialPath(c.req.path)) return undefined
        return options.corsOrigin(origin, c.req.path)
      },
      credentials: true,
    }),
  )

  app.use(
    unsignedLocalRequestGuard({
      mode: deploymentMode(process.env),
      authConfig: services.auth.config,
    }),
  )

  app.post("/api/claxedo/track", async (c) => {
    const body = await c.req.json().catch(() => null) as
      | { distinctId?: unknown; event?: unknown; properties?: unknown }
      | null
    if (!body || typeof body.distinctId !== "string" || typeof body.event !== "string") {
      return c.json({ error: { code: "telemetry_invalid_body", message: "Invalid telemetry request body" } }, 400)
    }
    services.telemetry.capture(body.distinctId, body.event, body.properties as Record<string, unknown> | undefined)
    return c.json({ ok: true })
  })

  app.get("/api/claxedo/events", eventsHandler({
    ...authRouteOptions(services),
    allowLoopbackLocal: true,
    ...(services.authority ? { resolveOrgId: (auth) => services.authority!.resolveOrgId(auth) } : {}),
  }))

  app.get("/api/claxedo/health", (c) => c.json({ ok: true, ...(options.health?.() ?? {}) }))
  app.get("/global/health", (c) =>
    c.json({ healthy: true, version: process.env.npm_package_version || "1.0.0" }))

  app.route("/", BootstrapRoutes({ services, env: process.env, ...authRouteOptions(services) }))
  app.route("/", ProviderAuthRoutes(services, {
    ...authRouteOptions(services),
    // The compat routes below serve `/provider/auth` for OpenCode; deferring
    // when they are NOT mounted would turn the registry's answer into a 404.
    deferToHarnessRoute: async (harness) =>
      await resolveHarnessId(harness ? normalizeHarnessIdentity(harness)?.id : undefined) === "opencode",
  }))
  app.route("/api/claxedo/credentials", CredentialRoutes(services.credentials, {
    // A public or deployed box MUST set CLAXEDO_CREDENTIALS_TOKEN; loopback dev
    // may leave it unset. The host supplies any stricter authentication.
    ...(process.env.CLAXEDO_CREDENTIALS_TOKEN?.trim()
      ? { token: process.env.CLAXEDO_CREDENTIALS_TOKEN.trim() }
      : {}),
    ...(options.authenticateCredentials ? { authenticate: options.authenticateCredentials } : {}),
  }))

  // Before the runtime proxy on purpose — both claim `/workspaces/:workspaceId`.
  if (options.workspaceRelayProxy) {
    app.all("/workspaces/:workspaceId", options.workspaceRelayProxy)
    app.all("/workspaces/:workspaceId/*", options.workspaceRelayProxy)
  }
  mountWorkspaceRuntimePtyWebSocketProxy(app, upgradeWebSocket, runtimeProxyOptions)
  mountLocalOnlyUsageLimits(app, authRouteOptions(services))

  // Routes workspace-owned traffic ahead of route matching, so scoped
  // `/global/event`, `/api/claxedo/events`, and `/api/wr/runtime-events` stay
  // per-workspace runtime streams rather than central control-plane streams.
  app.use(createWorkspaceRuntimeProxy(runtimeProxyOptions))

  app.route("/", OpenCodeCompatRoutes({
    services,
    env: process.env,
    ...authRouteOptions(services),
    ...(options.onOpencodeAccess ? { onOpencodeAccess: options.onOpencodeAccess } : {}),
  }))
  app.route("/api/claxedo/agent-config", AgentConfigRoutes({
    services,
    ...(options.updateCentralSessionModel ? { updateCentralSessionModel: options.updateCentralSessionModel } : {}),
    ...(options.invalidateCentralSession ? { invalidateCentralSession: options.invalidateCentralSession } : {}),
    ...authRouteOptions(services),
    agentExtensionPolicyOverrides: services.extensionPolicy.agentExtensionPolicyOverrides,
  }))
  app.route("/", SessionMetaRoutes({ services, ...authRouteOptions(services) }))
  app.route("/api/claxedo/network-policy", NetworkPolicyRoutes(authRouteOptions(services)))

  return { injectWebSocket }
}

export function createLocalApp(options: LocalAppOptions) {
  const app = new Hono()
  const { injectWebSocket } = mountLocalRouteFamilies(app, options)
  return { app, injectWebSocket }
}
