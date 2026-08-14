/**
 * The desktop-local server composition.
 *
 * Exactly the route families the split assigns to `local-server`. What it does
 * NOT mount is the point: no Documents, no Connections, no Channels, no
 * WorkGraph, no workspace authority, no cloud provisioning. Their absence from
 * an unsigned desktop is a composition fact here, not a runtime flag elsewhere.
 *
 * ORDER IS LOAD-BEARING. Hono matches middleware and handlers in registration
 * order and a handler terminates the chain:
 *   - security headers and the peer-address stamp go first, ahead of CORS and
 *     the 404/onError paths, so no response can ship bare;
 *   - the session-meta tap and `/workspaces/:workspaceId` both go BEFORE the
 *     runtime proxy — the proxy answers those routes itself, so anything
 *     registered after it never sees them;
 *   - only routes registered AFTER the proxy are subject to it.
 *
 * A first version of this file was deleted after review found six divergences
 * from the self-hosted composition it copies, none of which its route-inventory
 * test could see. Each is called out below at the line that fixes it.
 */

import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { createNodeWebSocket } from "@hono/node-ws"
import { z } from "zod"
import { peerAddressStamp } from "@claxedo/server-core/platform/http/peer-address"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"
import { unsignedLocalRequestGuard, deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import { controlPlaneAuthContext, ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { getHarnessMode, getWorkspaceProfile } from "@claxedo/server-core/platform/runtime/profile"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"
import type { RuntimeProxyOptions } from "../workspace/runtime-dispatch/internals"
import { createWorkspaceRuntimeProxy } from "../workspace/runtime-dispatch/middleware"
import { sessionMetaProjectionTap } from "../session/session-meta-tap"
import { AgentConfigRoutes } from "../agent-config/routes/index"
import { SessionMetaRoutes } from "../session/routes/meta-routes"
import { LocalWorkspaceRoutes } from "../workspace/routes/resolve-route"
import { OpenCodeCompatRoutes } from "../opencode/compat-routes/index"
import { CredentialRoutes } from "../credentials/routes/credential"
import { ProviderAuthRoutes } from "../credentials/routes/provider-auth"
import { NetworkPolicyRoutes } from "../sandbox/network/network-policy-routes"
import { BootstrapRoutes } from "../deployments/shared-routes/bootstrap"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "../deployments/local/server-workspace-pty-proxy"
import { resolveHarnessId } from "../opencode/compat-routes/provider-config"
import { LocalUsageRoutes } from "@claxedo/server-core/usage/routes"
import { UserExtensionRoutes } from "../extensions/user-extension-routes"

/**
 * Paths whose responses carry credential material.
 *
 * They are same-origin by definition — the loopback control plane talking to
 * itself — so they must never get an ACAO header. The defense is the browser
 * refusing the cross-origin READ, which it only does when none comes back.
 */
export function isLocalCredentialPath(path: string): boolean {
  return /^\/api\/claxedo\/(credentials|integrations)\b/.test(path)
}

/**
 * Which origins the desktop-local server answers.
 *
 * Loopback plus the product's own web origin. Deliberately NOT paired with
 * `credentials: true` — see the cors mount below.
 */
export function localCorsOrigin(origin: string): string | undefined {
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
  return undefined
}

export type LocalAppOptions = {
  services: ControlPlaneServicesContract
  /** Same-origin credential paths that must never receive an ACAO header. */
  isCredentialPath?: (path: string) => boolean
  corsOrigin?: (origin: string, path: string) => string | undefined
  runtimeProxyOptions?: RuntimeProxyOptions
  /** Answers `/workspaces/:workspaceId`; registered ahead of the runtime proxy. */
  workspaceRelayProxy?: MiddlewareHandler
  onOpencodeAccess?: () => void
  onError?: Parameters<Hono["onError"]>[0]
  updateCentralSessionModel?: (sessionId: string, model: { providerID: string; modelID: string }) => Promise<void>
  invalidateCentralSession?: (sessionId: string) => void
  env?: NodeJS.ProcessEnv
  usage?: Parameters<typeof LocalUsageRoutes>[0]
}

const TrackBody = z.object({
  distinctId: z.string().min(1),
  event: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
})

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
  // FINDING 3: the self-hosted composition fails fast here, and the first
  // version of this file did not — which also made an apparent
  // `deferToHarnessRoute` divergence a non-issue, since that ternary is
  // guaranteed true by this throw.
  if (!services.localExecution.enabled) {
    throw new Error("createLocalApp is the desktop-local composition; it requires localExecution")
  }
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  const runtimeProxyOptions = options.runtimeProxyOptions ?? {}

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
        if ((options.isCredentialPath ?? isLocalCredentialPath)(c.req.path)) return undefined
        return (options.corsOrigin ?? localCorsOrigin)(origin, c.req.path)
      },
      maxAge: 86400,
      // FINDING 1: `credentials: true` is deliberately NOT set. The self-hosted
      // composition never sets it, and setting it lets any origin this policy
      // approves complete a credentialed cross-origin read — which the shape of
      // the original made impossible regardless of policy.
    }),
  )

  app.use(unsignedLocalRequestGuard({ mode: deploymentMode(env), authConfig: services.auth.config }))

  app.post("/api/claxedo/track", async (c) => {
    // FINDING 6: validated against the canonical schema, not a hand-rolled
    // typeof check that lets any `properties` shape through.
    const parsed = TrackBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: "telemetry_invalid_body", message: "Invalid telemetry request body" } }, 400)
    }
    services.telemetry.capture(parsed.data.distinctId, parsed.data.event, parsed.data.properties)
    return c.json({ ok: true })
  })

  // FINDING 5: the same body the self-hosted composition returns. The shell
  // reads these fields; an `{ ok: true }` stub is a silent regression.
  app.get("/api/claxedo/health", (c) =>
    c.json({
      ok: true,
      harnessMode: getHarnessMode(),
      workspaceProfile: getWorkspaceProfile(),
      localExecution: services.localExecution.enabled,
    }))
  app.get("/global/health", (c) =>
    c.json({ healthy: true, version: env.npm_package_version || "1.0.0" }))

  app.route("/", BootstrapRoutes({ services, env, ...authRouteOptions(services) }))
  app.route("/", ProviderAuthRoutes(services, {
    ...authRouteOptions(services),
    deferToHarnessRoute: async (harness) =>
      await resolveHarnessId(harness ? normalizeHarnessIdentity(harness)?.id : undefined) === "opencode",
  }))
  app.route("/api/claxedo/credentials", CredentialRoutes(services.credentials, {
    ...(env.CLAXEDO_CREDENTIALS_TOKEN?.trim() ? { token: env.CLAXEDO_CREDENTIALS_TOKEN.trim() } : {}),
    // FINDING 2: derived from the environment, exactly as the self-hosted
    // composition derives it. The first version made this a caller-supplied
    // hook with no fallback, so a caller that omitted it left credential
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

  // FINDING 4: the session-meta projection tap, absent entirely from the first
  // version. Before the runtime proxy, which answers `/session` itself.
  app.use(sessionMetaProjectionTap(services.projectionStore))

  // Before the runtime proxy on purpose — both claim `/workspaces/:workspaceId`.
  if (options.workspaceRelayProxy) {
    app.all("/workspaces/:workspaceId", options.workspaceRelayProxy)
    app.all("/workspaces/:workspaceId/*", options.workspaceRelayProxy)
  }
  mountWorkspaceRuntimePtyWebSocketProxy(app, upgradeWebSocket, runtimeProxyOptions)
  if (options.usage) app.route("/api/claxedo/usage", LocalUsageRoutes(options.usage))

  // Routes workspace-owned traffic ahead of route matching, so scoped
  // `/global/event`, `/api/claxedo/events` and `/api/wr/runtime-events` stay
  // per-workspace runtime streams rather than central control-plane streams.
  app.use(createWorkspaceRuntimeProxy(runtimeProxyOptions))

  app.route("/", OpenCodeCompatRoutes({
    services,
    env,
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
  const localWorkspaceRoutes = LocalWorkspaceRoutes(authRouteOptions(services))
  app.route("/api/claxedo/workspace", localWorkspaceRoutes)
  // The renderer's inventory contract uses the hosted-compatible list path in
  // every product. On desktop, the authoritative local workspace store answers
  // it; this avoids treating an intentionally absent hosted router as a 404.
  app.route("/api/workspace", localWorkspaceRoutes)
  app.route("/api/claxedo/network-policy", NetworkPolicyRoutes(authRouteOptions(services)))
  // User-extension manifests and modules from `dataDir()/extensions`. The
  // route family disables itself on hosted/signed deployments; mounting it
  // unconditionally keeps that decision in one place (the routes) instead of
  // duplicating the environment check here.
  app.route("/api/claxedo/extensions", UserExtensionRoutes({ env }))

  return { injectWebSocket }
}

export function createLocalApp(options: LocalAppOptions) {
  const app = new Hono()
  const { injectWebSocket } = mountLocalRouteFamilies(app, options)
  return { app, injectWebSocket }
}
