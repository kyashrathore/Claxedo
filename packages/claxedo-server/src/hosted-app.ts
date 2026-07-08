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
 *   GET  /api/workspace/:id/connection
 *   POST /api/workspace/:id/connection/refresh
 *   POST /api/workspace/:id/user-hosted/challenge
 *   POST /api/workspace/:id/user-hosted/register
 *   POST /api/workspace/:id/user-hosted/heartbeat
 *   POST /api/workspace/:id/user-hosted/pause
 *   GET  /internal/relay/target
 *   GET  /internal/relay/revocation
 *   POST /internal/sandbox-manager/gc
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
import { HostedControlRoutes } from "./routes/hosted-control"
import { type HostedControlPlane } from "./control-plane/hosted-services"
import { createFixedWindowConnectionRateLimiter } from "./control-plane/rate-limit"
import { deploymentCompatibilityReport } from "./deployment-compatibility"

export type HostedAppOverrides = {
  /** Hosted relay target lookup. Omitted → the plane's composed lookup is used. */
  relayTargetLookup?: RelayTargetLookup
  /** Node-only hosted deployments mount the real central runtime separately. */
  centralSessionRuntime?: boolean
}

// Deployment-configured app origins (CLAXEDO_APP_ORIGINS, comma-separated).
// Exact `https://app.example.com` entries and `https://*.example.com` suffix
// entries are accepted, so staged app hosts (e.g. Cloudflare Pages) can call
// the central API without editing shared code per deployment.
export function configuredAppOrigins(raw: string | undefined) {
  const entries = (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)
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

export function createHostedApp(plane: HostedControlPlane, overrides: HostedAppOverrides = {}) {
  const { services } = plane
  const app = new Hono()

  app.use(
    corsMiddleware(
      configuredAppOrigins(plane.env.CLAXEDO_APP_ORIGINS),
      allowedOriginPatterns(plane.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES),
    ),
  )

  const workspaceOptions: HostedWorkspaceRouteOptions = {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    ...(services.relay.relayUrl ? { relayUrl: services.relay.relayUrl } : {}),
    ...(services.relay.relayUrls ? { relayUrls: services.relay.relayUrls } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    ...(services.relay.runtimeAccessTokenSigner
      ? { runtimeAccessTokenSigner: services.relay.runtimeAccessTokenSigner }
      : {}),
    ...(services.relay.hostTunnelTokenSigner
      ? { hostTunnelTokenSigner: services.relay.hostTunnelTokenSigner }
      : {}),
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
    }))

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
    }))

  app.get("/api/claxedo/compatibility", (c) =>
    c.json(deploymentCompatibilityReport(plane.env)))

  // Minimal hosted shell-boot surface (events bus, health, bootstrap, path/
  // project/provider) — see routes/hosted-shell.ts for the shape contracts.
  app.route("/", HostedShellRoutes({
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    ...(plane.env.npm_package_version ? { version: plane.env.npm_package_version } : {}),
    ...(services.authority
      ? { listWorkspaces: (auth) => services.authority!.listWorkspaces(auth) }
      : {}),
  }))

  app.route("/", JwksRoutes(plane.env))

  app.route("/", HostedDeviceAuthRoutes({
    ...(plane.deviceAuthProvider ? { provider: plane.deviceAuthProvider } : {}),
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    env: plane.env,
    ...(services.authority ? { ensureCliUser: (auth) => services.authority!.usersMe(auth) } : {}),
  }))

  app.route("/api/workspace", HostedWorkspaceRoutes(services, workspaceOptions))

  if (!overrides.centralSessionRuntime) {
    app.get("/api/control/sessions", async (c) => {
      const workspaceId = c.req.query("workspaceId")
      if (!workspaceId || !services.authority?.listSessions) return c.json({ sessions: [] })
      const authResult = await signedOrError(c.req.raw, {
        authConfig: services.auth.config,
        ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
        requireSigned: true,
      }, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      if (!authResult.auth) return c.json({ sessions: [] })
      return c.json({
        sessions: await services.authority.listSessions(authResult.auth, { workspaceId }),
      })
    })
  }

  app.route("/api/control", HostedControlRoutes(services, {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
    cliTokenEnv: plane.env,
  }))

  app.route("/", InternalRelayResolverRoutes({
    resolverToken: plane.resolverToken,
    ...(services.authority ? { authority: services.authority } : {}),
    targetLookup: overrides.relayTargetLookup ?? plane.relayTargetLookup,
    // No localTargetExists — the hosted control plane has no local disk store.
  }))

  app.route("/", HostedSandboxAdminRoutes({
    adminToken: plane.env.CLAXEDO_RUNTIME_ADMIN_TOKEN,
    sandboxManager: services.sandbox.sandboxManager,
    telemetry: services.telemetry,
  }))

  return app
}
