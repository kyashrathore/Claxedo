import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createNodeWebSocket } from "@hono/node-ws"
import { z } from "zod"
import { setupAgentHooks } from "@claxedo/workspace-runtime/host"
import { capture, initPostHog, shutdownPostHog } from "./posthog"
import { initNodeObservability } from "./observability/node"
import { reportError } from "./observability/report"
import { configureAgentConfig, defaultHarness, loadUserConfig } from "./agent-config"
import { eventsHandler } from "./routes/events"
import { peerAddressStamp } from "./routes/local-only-projection"
import { createConnectionsHost } from "./connections-host/connections-host"
import { hostedConnectionsEntitlement } from "./connections-host/connections-entitlement"
import { hostedOrgMembershipVerifier } from "./connections-host/org-membership"
import { createConnectionTurnCredentials } from "./connections-host/turn-credentials"
import { mirrorProcessEvents } from "./process-events"
import { PagesRoutes } from "./routes/pages"
import { DocsRoutes } from "./routes/docs"
import { sqliteDocumentStore } from "./doc-store"
import { AgentConfigRoutes } from "./routes/agent-config"
import { SessionMetaRoutes } from "./routes/session-meta"
import { WorkspaceRoutes } from "./routes/workspace"
import { OpenCodeCompatRoutes } from "./routes/opencode-compat"
import { createLocalWorkspaceRelayProxy, createWorkspaceRuntimeProxy } from "./proxy"
import { configureOpencodeMcpSync } from "./opencode-mcp-sync"
import {
  configureOpenCodeApplicationTools,
  configureOpenCodeEngine,
  drainOpenCodeEngine,
  opencodeEngineMode,
  opencodeRequest,
} from "./opencode-engine"
import { createOpencodeEvents, type OpencodeEvent, type OpencodeEventsHandle } from "./opencode-events"
import { globalBus } from "./bus"
import {
  configureWorkspaceSupervisor,
  createWorkspaceSupervisorSandboxManager,
  shutdownWorkspaceSupervisor,
} from "./workspace-supervisor"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "./embedded-workspace-runtime"
import { configureOpenCodeAuth, opencodeHeaders } from "./opencode-auth"
import { getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "./architecture"
import { createSqliteCentralStore } from "./control-plane/adapters/sqlite/central-store"
import { migrateCredentials } from "./credentials/migrate"
import { CredentialRoutes } from "./routes/credential"
import { ProviderAuthRoutes } from "./routes/provider-auth"
import { NetworkPolicyRoutes } from "./routes/network-policy"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  type ControlPlaneRelay,
  type ControlPlaneServices,
} from "./control-plane/services"
import { betterAuthAdapter, clerkAuthAdapter, signedCloudAuthRequested } from "./control-plane/auth"
import {
  assertHostedBootRequirements,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "./control-plane/deployment-mode"
import { EMBEDDED_AUTH_ISSUER, embeddedAuthEnabled, getEmbeddedAuth } from "./embedded-auth"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "./control-plane/adapters/convex/convex-authority"
import { createSqliteWorkspaceAuthority } from "./control-plane/adapters/sqlite/workspace-authority"
import { ControlPlaneHttpRoutes } from "./control-plane/http"
import { createCentralControlApp } from "./central-runtime"
import { JwksRoutes } from "./control-plane/routes/jwks"
import { InternalRelayResolverRoutes } from "./routes/internal-relay"
import { localRelayTargetExists, localRelayTargetLookup } from "./routes/internal-relay-local"
import { BootstrapRoutes } from "./routes/bootstrap"
import { LivingAppsRoutes } from "./routes/living-apps"
import { hostTunnelTokenSigner, runtimeAccessTokenSigner } from "./control-plane/runtime-access-token"
import { createControlPlaneRelayProvider } from "./relay-provider"
import { ensureWorkspace, listProjects, resolveWorkspace } from "./workspace-store"
import { defaultHomeRegion, relayEndpointsFromEnv } from "./region"
import { mountControlPlaneChannels } from "./channels-control-plane"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "./server-workspace-pty-proxy"
import { createClaxedoSessionEnvFactory } from "./workspace-runtime-integration/session-env"
import {
  createLocalEmbeddedWorkGraph,
  mountLazyEmbeddedWorkGraph,
  requireLocalWorkGraphRepositoryDirectory,
} from "./server-workgraph"
import { mountLocalOnlyUsageLimits } from "./server-usage-limits"
import { centralModelBackend } from "./central-session-runtime"
import { dataDir } from "./paths"
import { createLocalWorkspaceExecution, type WorkGraphSessionGateway } from "./workgraph-host/local-execution"
import { createLocalExecutionCapabilities } from "./workgraph-host/local-execution-capabilities"
import { createLocalWorkGraphAgentTools, localSessionExecution } from "./workgraph-agent-tools"
import { provisionRegisteredWorktree, releaseRegisteredWorktree, workGraphWorkspaceId } from "./worktree-service"
import { createFileWorkGraphSessionBindingStore, createHarnessWorkGraphGateway } from "./workgraph-session-gateway"

const TrackBody = z.object({
  distinctId: z.string(),
  event: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
})

function trackErrorBody(code: string, message: string) {
  return { error: { code, message } }
}

function globalBusOpencodeEvents(): OpencodeEventsHandle {
  const handlers = new Set<(e: OpencodeEvent) => void>()
  const unsubscribe = globalBus.subscribe((event) => {
    for (const handler of handlers) handler(event)
  })
  return {
    on(fn) {
      handlers.add(fn)
    },
    off(fn) {
      handlers.delete(fn)
    },
    start() {},
    close() {
      handlers.clear()
      unsubscribe()
    },
  }
}

// Exported (not just used internally) so both wiring sites — the legacy
// single-instance `upstreamEvents` bridge below and the embedded per-workspace
// `onSessionMetaEvent` tap wired through `configureEmbeddedWorkspaceRuntime`
// — share one write path into the control plane's session projection, and so
// it can be exercised directly in tests without constructing a full `Hono`
// app. `Pick` keeps it decoupled from the rest of `ControlPlaneServices`.
export async function projectLocalSessionMetaFromEvent(
  services: Pick<ControlPlaneServices, "projectionStore">,
  event: OpencodeEvent,
) {
  try {
    const raw = event.payload.properties?.info
    const info = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    if (!info || typeof info.id !== "string") return
    const directory = typeof info.directory === "string" ? info.directory : event.directory
    const workspaceID = typeof info.workspaceID === "string" ? info.workspaceID : undefined
    const ws = await resolveWorkspace({ workspaceId: workspaceID, directory }).catch(() => undefined)
    if (ws?.kind === "cloud") return
    await services.projectionStore.sync_session_meta(ws, {
      ...info,
      ...(directory ? { directory } : {}),
    })
  } catch {
    // Best-effort projection; upstream events must never break the bridge.
  }
}

function authRouteOptions(services: ControlPlaneServices) {
  return {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }
}

function workspaceRouteOptions(services: ControlPlaneServices) {
  return {
    ...authRouteOptions(services),
    credentials: services.credentials,
    ...(services.relay.relayUrl ? { relayUrl: services.relay.relayUrl } : {}),
    ...(services.relay.relayUrls ? { relayUrls: services.relay.relayUrls } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    ...(services.relay.runtimeAccessTokenSigner
      ? { runtimeAccessTokenSigner: services.relay.runtimeAccessTokenSigner }
      : {}),
    ...(services.relay.hostTunnelTokenSigner ? { hostTunnelTokenSigner: services.relay.hostTunnelTokenSigner } : {}),
  }
}

// The connections credential routes, mounted under /api/claxedo/integrations
// (see `app.route("/api/claxedo/integrations", ...)` below). These return
// per-user tokens and must never be readable cross-origin — CORS must not
// hand back an Access-Control-Allow-Origin for them.
const CONNECTIONS_CREDENTIAL_PATH = /^\/api\/claxedo\/integrations\/connections\/[^/]+\/(token|auth-failure)\/?$/

export function isConnectionsCredentialPath(path: string): boolean {
  return CONNECTIONS_CREDENTIAL_PATH.test(path)
}

export function createApp(
  services: ControlPlaneServices,
  options: {
    onOpencodeAccess?: () => void
    beforeLocalSessionList?: () => Promise<void>
  } = {},
) {
  const app = new Hono()
  // Record the transport peer address for every request (including
  // @hono/node-ws upgrades, whose Requests lack the node-server internals)
  // so loopback gates verify the socket, not the spoofable Host header.
  app.use(peerAddressStamp())
  // D12 (ops floor ADR 2026-07-11-016 §4): top-level error handler. Hono's
  // default onError swallows route exceptions into bare 500s; this keeps that
  // exact response behavior (HTTPException responses pass through) while
  // reporting server exceptions through the observability seam — a no-op
  // unless Sentry was initialized (CLAXEDO_SENTRY_DSN set).
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    reportError(err, {
      tags: { source: "server_route" },
      extra: { path: c.req.path, method: c.req.method },
    })
    console.error(err)
    return c.text("Internal Server Error", 500)
  })
  const runtimeProxyOptions = {
    ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
    ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
  }
  const turnCredentials = createConnectionTurnCredentials()
  const centralControl = createCentralControlApp(services, {
    ...authRouteOptions(services),
    // Central Pi sessions run tools in the placement selected at session
    // creation: virtual (in-memory) by default, or a workspace runtime via
    // /api/wr/session-env/* when toolSandbox.kind === "workspace-runtime".
    createEnv: createClaxedoSessionEnvFactory({ fetchOptions: runtimeProxyOptions, turnCredentials }),
    turnCredentials,
    ...(options.beforeLocalSessionList ? { beforeLocalSessionList: options.beforeLocalSessionList } : {}),
  })
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
  const workspaceRuntimeProxy = createWorkspaceRuntimeProxy(runtimeProxyOptions)
  const localWorkspaceRelayProxy = createLocalWorkspaceRelayProxy(runtimeProxyOptions)

  app.use(
    cors({
      origin: (origin, c) => {
        if (!origin) return undefined
        // Credential-bearing connections routes are same-origin (loopback
        // control plane talking to itself). Never reflect an Access-Control-
        // Allow-Origin for them: the `x-claxedo-connections` header defense
        // relies on the browser blocking the cross-origin read, which it only
        // does when no ACAO is returned. Reflecting any http://localhost:*
        // origin here would let a page on any local port read the tokens.
        if (isConnectionsCredentialPath(c.req.path)) return undefined
        if (origin.startsWith("http://localhost:")) return origin
        if (origin.startsWith("http://127.0.0.1:")) return origin
        if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
        return undefined
      },
      maxAge: 86400,
    }),
  )

  // D9: the ONE global unsigned-local gate. In unsigned self-host mode this
  // is the PRIMARY gate — non-loopback requests are denied by default with an
  // explicit allowlist of machine-token/callback exceptions (see
  // control-plane/deployment-mode.ts). The per-route loopback checks further
  // down (connections gate, events allowLoopbackLocal, local-only
  // projections) are hereby demoted to defense-in-depth. In signed mode the
  // guard passes through and per-route bearer verification stays the gate.
  app.use(
    unsignedLocalRequestGuard({
      mode: deploymentMode(process.env),
      authConfig: services.auth.config,
    }),
  )

  app.post("/api/claxedo/track", async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = TrackBody.safeParse(body)
    if (!parsed.success) return c.json(trackErrorBody("telemetry_invalid_body", "Invalid telemetry request body"), 400)
    services.telemetry.capture(parsed.data.distinctId, parsed.data.event, parsed.data.properties)
    return c.json({ ok: true })
  })

  app.get("/api/claxedo/health", (c) =>
    c.json({
      ok: true,
      harnessMode: getHarnessMode(),
      workspaceProfile: getWorkspaceProfile(),
      localExecution: services.localExecution.enabled,
    }),
  )
  app.get("/global/health", (c) =>
    c.json({
      healthy: true,
      version: process.env.npm_package_version || "1.0.0",
    }),
  )
  if (embeddedAuthEnabled(process.env)) {
    // Embedded Better Auth issuer (self-host signed mode, no Convex/Clerk).
    // better-auth's default basePath is exactly /api/auth; the same instance
    // backs the control-plane bearer verifier (see
    // createDefaultLocalControlPlaneServices), so tokens minted here are the
    // ones the signed control-plane routes accept.
    const embedded = getEmbeddedAuth()
    app.all("/api/auth/*", (c) => embedded.handler(c.req.raw))
  }
  app.route("/", JwksRoutes(process.env))
  app.route(
    "/",
    InternalRelayResolverRoutes({
      ...(services.relay.resolverToken ? { resolverToken: services.relay.resolverToken } : {}),
      ...(services.authority ? { authority: services.authority } : {}),
      targetLookup: localRelayTargetLookup({
        ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
        telemetry: services.telemetry,
      }),
      localTargetExists: localRelayTargetExists({
        ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
      }),
    }),
  )
  app.route(
    "/",
    BootstrapRoutes({
      services,
      env: process.env,
      ...authRouteOptions(services),
    }),
  )
  app.route("/", ProviderAuthRoutes(services))

  mountWorkspaceRuntimePtyWebSocketProxy(app, upgradeWebSocket, runtimeProxyOptions)

  app.all("/workspaces/:workspaceId", localWorkspaceRelayProxy)
  app.all("/workspaces/:workspaceId/*", localWorkspaceRelayProxy)

  // Record local session metadata into the SQLite control-plane store
  // (claxedo_session_meta) as sessions are created / updated / deleted, so the
  // control plane is the source of truth for the session list on local
  // workspaces — with no dependence on querying the opencode server. Cloud
  // workspaces are owned by the workspace authority and skipped here. Best-effort:
  // recording never blocks or alters the proxied response. Registered before
  // workspaceRuntimeProxy so it taps the proxied `/session` response.
  app.use(async (c, next) => {
    await next()
    try {
      const url = new URL(c.req.url)
      const method = c.req.method
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/)
      const isCreate = method === "POST" && url.pathname === "/session"
      const isUpdate = method === "PATCH" && !!sessionMatch
      const isDelete = method === "DELETE" && !!sessionMatch
      if (!isCreate && !isUpdate && !isDelete) return
      const res = c.res
      if (!res || res.status < 200 || res.status >= 300) return
      const rawDir = c.req.query("directory") || c.req.header("x-opencode-directory") || undefined
      const directory = rawDir ? decodeURIComponent(rawDir) : undefined
      const workspaceId =
        c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id") || undefined
      const ws = await resolveWorkspace({ workspaceId, directory }).catch(() => undefined)
      // Cloud sessions are owned by the Convex control plane.
      if (ws?.kind === "cloud") return
      if (isDelete) {
        const sessionId = sessionMatch?.[1]
        if (!sessionId) return
        await services.projectionStore.delete_session_meta(decodeURIComponent(sessionId))
        return
      }
      const body = (await res
        .clone()
        .json()
        .catch(() => undefined)) as Record<string, any> | undefined
      if (!body || typeof body.id !== "string") return
      await services.projectionStore.put_session_meta(body.id, {
        ws: ws ?? undefined,
        directory: ws?.directory ?? directory ?? (typeof body.directory === "string" ? body.directory : null),
        title: typeof body.title === "string" ? body.title : null,
        parentID: typeof body.parentID === "string" ? body.parentID : null,
        archived: typeof body?.time?.archived === "number" ? body.time.archived : null,
      })
    } catch {
      // best-effort: never break the proxied response
    }
  })

  // Route workspace-owned traffic before route matching. This keeps scoped
  // `/global/event`, `/api/claxedo/events`, and `/api/wr/runtime-events`
  // as per-workspace runtime streams instead of central control-plane streams.
  app.use(workspaceRuntimeProxy)

  if (services.localExecution.enabled) {
    // OpenCode-compat routes (provider, config, project, session, agent, command)
    app.route(
      "/",
      OpenCodeCompatRoutes({
        services,
        env: process.env,
        onOpencodeAccess: options.onOpencodeAccess,
      }),
    )

    // Runtime-owned local routes are dispatched through the embedded
    // workspace-runtime host by workspaceRuntimeProxy above.
  }
  // Claxedo events SSE — auth-gated via the same control-plane bearer used
  // by /api/control/* and /api/workspace/* (rubric S1). authFetch on the
  // frontend already attaches the token because the consumer uses fetch+
  // ReadableStream, not raw EventSource.
  app.get(
    "/api/claxedo/events",
    eventsHandler({
      ...authRouteOptions(services),
      allowLoopbackLocal: true,
    }),
  )

  // Pages routes
  app.route(
    "/pages",
    PagesRoutes({
      env: process.env,
      services,
      ...authRouteOptions(services),
    }),
  )

  app.route(
    "/api/claxedo/docs",
    DocsRoutes({
      store: () => sqliteDocumentStore,
      services,
      ...authRouteOptions(services),
    }),
  )

  // Agent config routes (centralized MCP + commands management)
  app.route(
    "/api/claxedo/agent-config",
    AgentConfigRoutes({
      services,
      updateCentralSessionModel: centralControl.runtime.updateSessionModel,
      invalidateCentralSession: centralControl.runtime.invalidateSession,
      ...authRouteOptions(services),
      agentExtensionPolicyOverrides: services.extensionPolicy.agentExtensionPolicyOverrides,
    }),
  )
  app.route("/", SessionMetaRoutes({ services, ...authRouteOptions(services) }))
  app.route("/api/workspace", WorkspaceRoutes(services, workspaceRouteOptions(services)))
  app.route("/api/control", ControlPlaneHttpRoutes(services, authRouteOptions(services)))
  app.route("/", centralControl.app)
  app.route(
    "/api/claxedo/credentials",
    CredentialRoutes(services.credentials, {
      // Public/deployed boxes MUST set CLAXEDO_CREDENTIALS_TOKEN (see
      // CredentialRoutesOptions.token). Local loopback dev may leave it unset.
      ...(process.env.CLAXEDO_CREDENTIALS_TOKEN?.trim() ? { token: process.env.CLAXEDO_CREDENTIALS_TOKEN.trim() } : {}),
    }),
  )
  // Connections framework
  // (docs/plans/2026-07-03-004-feat-connections-framework-plan.md): kit routes
  // with host-injected gates — auth on every route, loopback+header on token.
  // F5: the hosted-connections entitlement hook — undefined on self-host (never
  // gated, byte-identical), a fail-closed billing gate in hosted mode so a free
  // org is denied once CLAXEDO_HOSTED_CREDENTIALS_ENABLED is flipped on.
  const requireHostedConnectionsEntitlement = hostedConnectionsEntitlement(process.env)
  // F12: hosted re-checks org membership in Convex before granting the team
  // partition (a Clerk `org_id` claim alone is not authorization — D2).
  // Undefined on self-host → the gate never consults it (byte-identical).
  const verifyOrgMembership = hostedOrgMembershipVerifier(process.env)
  const connectionsHost = createConnectionsHost({
    credentials: services.credentials,
    turnCredentials,
    ...authRouteOptions(services),
    ...(requireHostedConnectionsEntitlement ? { requireHostedConnectionsEntitlement } : {}),
    ...(verifyOrgMembership ? { verifyOrgMembership } : {}),
  })
  app.route("/api/claxedo/integrations", connectionsHost.routes)
  app.route("/api/claxedo/network-policy", NetworkPolicyRoutes(authRouteOptions(services)))
  app.route("/api/claxedo/living-apps", LivingAppsRoutes())
  mountLocalOnlyUsageLimits(app, authRouteOptions(services))
  mountControlPlaneChannels(app, {
    services,
    runtime: centralControl.runtime,
    includeFake: true,
  })

  // Web UI parity (W2): serve a built claxedo-app bundle from the box when
  // CLAXEDO_APP_DIST_DIR points at one (self-host single-process deploys).
  // Mounted LAST so every API route wins; unmatched GETs fall through to the
  // bundle, and unknown html paths get the SPA index (client-side routing,
  // e.g. /s/:sessionId). No env → no behavior change (local dev, hosted).
  const staticDir = process.env.CLAXEDO_APP_DIST_DIR?.trim()
  if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
    const root = path.relative(process.cwd(), staticDir) || "."
    app.get("*", serveStatic({ root }))
    app.get("*", async (c) => {
      if (!c.req.header("accept")?.includes("text/html")) return c.notFound()
      const html = await fs.promises.readFile(path.join(staticDir, "index.html"), "utf8")
      return c.html(html)
    })
    console.log(`[claxedo-server] serving web UI from ${staticDir}`)
  } else if (staticDir) {
    console.error(
      `[claxedo-server] WARN CLAXEDO_APP_DIST_DIR set but no index.html at ${staticDir} — web UI not mounted`,
    )
  }

  return {
    app,
    injectWebSocket,
    /** @claxedo/connections service — the one connections layer. Thread this
     * into consumers that need capability-handle token resolution (workgraph). */
    connections: connectionsHost.service,
  }
}

export type ControlPlaneStackOptions = {
  services: ControlPlaneServices
  port?: number
  opencodeUrl?: string
  opencodePassword?: string | null
}

export function captureControlPlaneStartupTelemetry(
  services: ControlPlaneServices,
  input: {
    port: number
    engineMode: "embedded" | "external-url"
  },
) {
  try {
    services.telemetry.capture("control-plane", "control_plane.started", {
      port: input.port,
      // Embedded counts as configured; the mode string replaces the old URL bool.
      opencodeConfigured: true,
      opencodeEngineMode: input.engineMode,
      authMode: services.auth.config.enabled ? "signed" : services.auth.config.mode,
      signedAuth: services.auth.config.enabled,
      sessionWriteMode: getSessionWriteMode(),
      hasWorkspaceAuthority: !!services.authority,
      hasRelayUrl: !!services.relay.relayUrl,
      hasRelayResolverToken: !!services.relay.resolverToken,
      hasRuntimeAccessTokenSigner: !!services.relay.runtimeAccessTokenSigner,
      hasHostTunnelTokenSigner: !!services.relay.hostTunnelTokenSigner,
      sandboxDriverId: services.sandbox.defaultDriver ?? null,
    })
  } catch {
    // Startup telemetry must not prevent the local or hosted server from booting.
  }
}

export function createDefaultLocalControlPlaneServices() {
  // The Convex adapter owns the authority URL env names (neutral name +
  // legacy aliases); the composition only threads the resolved presence.
  const authorityUrl = convexAuthorityUrlFromEnv(process.env)
  const embeddedAuth = embeddedAuthEnabled(process.env)
  if (deploymentMode(process.env) === "hosted") {
    // D9 fail-closed hosted boot: CLAXEDO_DEPLOYMENT_MODE=hosted REFUSES to
    // start unless signed auth is fully configured and a workspace authority
    // is resolved — one thrown error naming every missing piece. A hosted
    // deployment that cannot authenticate must be down, not open; absent
    // mode (self-host) keeps the zero-config boot below bit-for-bit.
    assertHostedBootRequirements(process.env, { authorityConfigured: !!authorityUrl })
  }
  if (signedCloudAuthRequested(process.env) && !authorityUrl && !embeddedAuth) {
    // Fail closed at BOOT (mirror of the hosted requiredHostedDependency rule):
    // signed auth without a workspace authority would otherwise answer 503 on
    // every request instead of telling the deployer what is missing.
    // Exception: CLAXEDO_EMBEDDED_AUTH=1 is a valid signed config WITHOUT a
    // remote authority URL — the local SQLite workspace authority plus the
    // embedded Better Auth issuer covers a self-host box with no Convex/Clerk.
    throw new ControlPlaneCompositionError(
      "hosted_dependency_missing",
      "Signed/cloud auth requires a workspace authority; set CLAXEDO_WORKSPACE_AUTHORITY_URL or enable CLAXEDO_EMBEDDED_AUTH=1",
    )
  }
  const sandboxManager = createWorkspaceSupervisorSandboxManager()
  const centralStore = createSqliteCentralStore({ mode: getSessionWriteMode })
  return createControlPlaneServices(
    {
      projectionStore: centralStore.projectionStore,
      durableSessionLog: centralStore.durableSessionLog,
    },
    {
      // Embedded Better Auth issuer (CLAXEDO_EMBEDDED_AUTH=1) => signed mode
      // backed by the in-process better-auth instance; otherwise Clerk env.
      auth: embeddedAuth
        ? betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: getEmbeddedAuth().verifier })
        : clerkAuthAdapter({ env: process.env, authorityConfigured: !!authorityUrl }),
      // Convex when a backend URL is configured; otherwise the local SQLite
      // authority so a fresh self-host deploy (no Convex/Clerk env) still has
      // working workspace/session features instead of `requireAuthority` 503s.
      // Signed mode without a URL never reaches here — the boot throw above
      // keeps signed/cloud auth fail-closed on Convex.
      authority: authorityUrl ? createConvexAuthority({ url: authorityUrl }) : createSqliteWorkspaceAuthority(),
      relay: localRelayFromEnv(sandboxManager),
      sandbox: {
        sandboxManager,
      },
      telemetry: { capture },
      defaultHomeRegion: defaultHomeRegion(process.env),
    },
  )
}

function localRelayFromEnv(sandboxManager = createWorkspaceSupervisorSandboxManager()): ControlPlaneRelay {
  const relayUrl = process.env.CLAXEDO_WORKSPACE_RELAY_URL?.trim()
  const resolverToken = process.env.CLAXEDO_RELAY_RESOLVER_TOKEN?.trim()
  const hasSigningKey = !!process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM?.trim()
  const runtimeSigner = hasSigningKey ? runtimeAccessTokenSigner() : undefined
  const hostSigner = hasSigningKey ? hostTunnelTokenSigner() : undefined
  const relayUrls = relayUrl ? relayEndpointsFromEnv(process.env, relayUrl) : undefined
  return {
    ...(relayUrl ? { relayUrl } : {}),
    ...(relayUrls ? { relayUrls } : {}),
    ...(resolverToken ? { resolverToken } : {}),
    ...(runtimeSigner && hostSigner
      ? {
          runtimeAccessTokenSigner: runtimeSigner,
          hostTunnelTokenSigner: hostSigner,
        }
      : {}),
    ...(relayUrl && relayUrls && runtimeSigner && hostSigner
      ? {
          provider: createControlPlaneRelayProvider({
            relay: { relayUrl, relayUrls },
            runtimeAccessTokenSigner: runtimeSigner,
            hostTunnelTokenSigner: hostSigner,
            targetLookup: localRelayTargetLookup({ sandboxManager }),
          }),
        }
      : {}),
  }
}

export async function shutdownControlPlaneRuntime() {
  shutdownEmbeddedWorkspaceRuntimes()
  await drainOpenCodeEngine()
  await shutdownWorkspaceSupervisor()
  await shutdownPostHog()
}

function sessionComposerHarness(harness: ReturnType<typeof defaultHarness>) {
  if (harness.access === "acp") return `${harness.id}-acp`
  if (harness.id === "claude") return "claude-sdk"
  if (harness.id === "codex") return "codex-app-server"
  if (harness.id === "cursor") return "cursor-sdk"
  return harness.id
}

export function startControlPlaneStack(options: ControlPlaneStackOptions) {
  const port = options.port ?? 3001
  // No external opencodeUrl configured => embed the engine in-process (default).
  // An explicit opencodeUrl is the external-URL opt-in. NOTHING listens on :4096.
  const opencodeCompat = process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT !== "1"
  const services = options.services
  configureOpenCodeAuth(options.opencodePassword)
  if (options.opencodeUrl) {
    configureOpenCodeEngine({ url: options.opencodeUrl, headers: opencodeHeaders() })
  } else {
    configureOpenCodeEngine({ embedded: true })
  }
  configureOpenCodeApplicationTools(undefined)
  initPostHog()
  // D12: Sentry on the Node server — no-op unless CLAXEDO_SENTRY_DSN is set
  // (release = git SHA via CLAXEDO_RELEASE/GIT_SHA; events tagged unit=server
  // + deployment_mode). See observability/node.ts.
  initNodeObservability(process.env)
  mirrorProcessEvents()
  configureOpencodeMcpSync({ enabled: opencodeCompat })
  configureEmbeddedWorkspaceRuntime({
    opencodeRequest,
    opencodeCompat,
    piModelBackend: centralModelBackend().modelBackend,
    // See `projectLocalSessionMetaFromEvent` above: a harness session's
    // async auto-title (opencode's own LLM rename, or an ACP harness's
    // post-turn `maybeEmitTitle`) is published only over that workspace's
    // own `/global/event` SSE stream, never an HTTP `PATCH /session/:id` the
    // response-sniffing tap below would observe. Without this, titles revert
    // to "Untitled" after a restart.
    onSessionMetaEvent: (event) => {
      if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
        void projectLocalSessionMetaFromEvent(services, event)
      }
    },
    onSessionMetaSnapshot: async (workspace, sessions) => {
      await Promise.all(sessions.map((session) => services.projectionStore.sync_session_meta(workspace, session)))
    },
  })
  async function refreshLocalSessionProjection() {
    await Promise.allSettled(
      (await listProjects())
        .flatMap((project) => Object.values(project.workspaces))
        .filter((workspace) => workspace.kind !== "cloud" && workspace.available !== false)
        .map((workspace) => ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" })),
    )
  }
  configureAgentConfig({
    ...(process.env.CLAXEDO_ACP_DIR ? { acpDir: process.env.CLAXEDO_ACP_DIR } : {}),
  })
  configureWorkspaceSupervisor({
    server_url: `http://127.0.0.1:${port}`,
    // opencode_url intentionally NOT forwarded: the supervisor never reads it,
    // and a 127.0.0.1 URL is meaningless inside a sandbox (the sandbox adapter's
    // supervised-spawn mode owns the runtime's opencode via SANDBOX env). See
    // workspace-supervisor-runtime-env.ts — only server_url / relay auth is used.
    ...(services.relay.relayUrl ? { relay_url: services.relay.relayUrl } : {}),
    ...(services.sandbox.defaultDriver ? { default_sandbox_driver: services.sandbox.defaultDriver } : {}),
  })

  // Migrate legacy plaintext credentials into the managed secret backend.
  migrateCredentials().catch((err) => {
    console.error("[claxedo-server] WARN  credential migration failed:", err)
  })

  // Persist control-plane worktree/provision messages that still intentionally
  // converge on the central bus. Workspace-runtime host events stream directly
  // from each sandbox.
  services.durableSessionLog.subscribe_message_replay(globalBus)
  captureControlPlaneStartupTelemetry(services, { port, engineMode: opencodeEngineMode() })

  const opencodeEvents = globalBusOpencodeEvents()
  const upstreamEvents = opencodeCompat ? createOpencodeEvents(opencodeRequest, { autoStart: false }) : undefined

  upstreamEvents?.on((event) => {
    if (!event.payload.type) return
    if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
      void projectLocalSessionMetaFromEvent(services, event)
    }
    globalBus.publish({
      directory: event.directory ?? "global",
      payload: {
        type: event.payload.type,
        properties: event.payload.properties,
      },
    })
  })

  let localSessionProjectionReady: Promise<void> | undefined
  const built = createApp(services, {
    onOpencodeAccess: () => upstreamEvents?.start(),
    beforeLocalSessionList: () => {
      localSessionProjectionReady ??= refreshLocalSessionProjection()
      return localSessionProjectionReady
    },
  })
  const workgraphRuntimes = new Map<string, Promise<{
    workspaceId: string
    runtime: Awaited<ReturnType<typeof ensureEmbeddedWorkspaceRuntime>>
  }>>()
  const workgraphRuntime = (directory: string) => {
    const hit = workgraphRuntimes.get(directory)
    if (hit) return hit
    const loading = (async () => {
      const workspace = await ensureWorkspace({
        workspaceId: workGraphWorkspaceId(directory),
        workspace_name: "WorkGraph stream",
        directory,
      })
      if (!workspace) throw new Error(`WorkGraph workspace could not be registered: ${directory}`)
      return {
        workspaceId: workspace.id,
        runtime: await ensureEmbeddedWorkspaceRuntime(workspace),
      }
    })().catch((error) => {
      workgraphRuntimes.delete(directory)
      throw error
    })
    workgraphRuntimes.set(directory, loading)
    return loading
  }
  const workgraphBindings = createFileWorkGraphSessionBindingStore(
    path.join(dataDir(), "workgraph-session-bindings.json"),
  )
  const workgraphSessions = Promise.resolve(
    createHarnessWorkGraphGateway(opencodeRequest, {
      connections: built.connections,
      resolveTeamOwner: (context) => `org:${context.organizationId}`,
      bindings: workgraphBindings,
      sessionRequest: async (directory, request) => {
        return (await workgraphRuntime(directory)).runtime.app.fetch(request)
      },
      releaseSessionRuntime: async (directory) => {
        const pending = workgraphRuntimes.get(directory)
        if (!pending) return
        workgraphRuntimes.delete(directory)
        releaseEmbeddedWorkspaceRuntime((await pending).workspaceId)
      },
    }),
  )
  void workgraphBindings.all().then((bindings) =>
    Promise.allSettled(bindings.map((binding) => workgraphRuntime(binding.directory))),
  )
  const workgraphSessionGateway = {
    supportsConnections: !!built.connections,
    classifyAdmissionError: (error: unknown) => {
      if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number")
        return "indeterminate" as const
      if (error.status === 404 || error.status === 501 || error.status === 503) return "unavailable" as const
      if (
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 425 &&
        error.status !== 429
      )
        return "rejected" as const
      return "indeterminate" as const
    },
    admit: (input: Parameters<WorkGraphSessionGateway["admit"]>[0]) =>
      workgraphSessions.then((sessions) => sessions.admit(input)),
    cancel: (sessionId: string, reason: string) =>
      workgraphSessions.then((sessions) => sessions.cancel(sessionId, reason)),
    result: (sessionId: string) => workgraphSessions.then((sessions) => sessions.result(sessionId)),
    releaseDirectory: (directory: string) =>
      workgraphSessions.then((sessions) => sessions.releaseDirectory?.(directory) ?? Promise.resolve()),
  }
  const workgraphRepositoryDirectory = requireLocalWorkGraphRepositoryDirectory(
    process.env.CLAXEDO_WORKGRAPH_REPOSITORY,
  )
  const workgraphDatabase = new Database(path.join(dataDir(), "workgraph-v2.db"))
  const workgraphExecution = createLocalWorkspaceExecution({
    worktreeRoot: path.join(dataDir(), "workgraph-worktrees"),
    legacyRepositoryDirectory: async () => workgraphRepositoryDirectory,
    worktrees: {
      provision: async (input) => {
        const workspace = await provisionRegisteredWorktree({
          repositoryDirectory: input.repositoryDirectory,
          directory: input.directory,
          workspaceId: workGraphWorkspaceId(input.directory),
          workspaceName: `WorkGraph ${input.streamId}`,
          checkout: { kind: "detached", revision: input.baseRevision },
        })
        return { directory: workspace.directory, workspaceId: workspace.id }
      },
      release: releaseRegisteredWorktree,
    },
    sessions: workgraphSessionGateway,
  })
  const workgraph = createLocalEmbeddedWorkGraph({
    database: workgraphDatabase,
    auth: {
      ...authRouteOptions(services),
      ...(services.authority ? { authority: services.authority } : {}),
    },
    execution: workgraphExecution,
    executionCapabilities: createLocalExecutionCapabilities({
      opencodeRequest,
      repositoryDirectory: workgraphRepositoryDirectory,
      harness: async () => sessionComposerHarness(defaultHarness(await loadUserConfig())),
      connections: built.connections,
      resolveTeamOwner: (context) => `org:${context.organizationId}`,
    }),
    recaps: { sessions: workgraphSessionGateway, directory: workgraphRepositoryDirectory },
    sourcePlanning: { sessions: workgraphSessionGateway, directory: workgraphRepositoryDirectory },
    connections: built.connections,
    resolveTeamOwner: (context) => `org:${context.organizationId}`,
    telemetry: services.telemetry,
  })
  if (!services.auth.config.enabled && services.auth.config.mode === "local-only" && !options.opencodeUrl) {
    configureOpenCodeApplicationTools(() =>
      workgraph.then((embedded) =>
        createLocalWorkGraphAgentTools(embedded, {
          organizationId: "local",
          ownerUserId: "local",
          sessionExecution: (sessionId) => localSessionExecution(opencodeRequest, sessionId),
        }),
      ),
    )
  }
  let unsubscribeWorkGraphSessionIntake = () => {}
  if (!services.auth.config.enabled && services.auth.config.mode === "local-only") {
    void Promise.all([workgraph, import("./workgraph-host/session-intake")]).then(([embedded, intake]) => {
      unsubscribeWorkGraphSessionIntake = intake.subscribeSessionIntake({
        events: globalBus,
        opencodeRequest,
        port: embedded.sessionIntake,
        resolveContext: () => ({
          organizationId: "local" as never,
          ownerUserId: "local" as never,
          actor: { type: "system" as const, id: "session_intake" as never },
          requestId: `session_intake_${crypto.randomUUID()}` as never,
          access: { mode: "owner" as const },
        }),
        onError: (error) => console.error("[claxedo-server] WARN WorkGraph Session intake failed:", error),
      })
    })
  }
  let reconcilingWorkGraph = false
  const workgraphReconciler = setInterval(() => {
    if (reconcilingWorkGraph || !workgraphDatabase.open) return
    reconcilingWorkGraph = true
    void workgraph
      .then(async (embedded) => {
        const owners = workgraphDatabase
          .prepare(
            `
        SELECT organization_id, owner_user_id FROM wg_v2_streams
        UNION
        SELECT organization_id, owner_user_id FROM wg_v2_attempts WHERE lifecycle = 'running' AND session_id IS NOT NULL
        UNION
        SELECT organization_id, owner_user_id FROM wg_v2_due_jobs WHERE job_type = 'source_plan' AND status IN ('pending', 'failed', 'running')
      `,
          )
          .all() as Array<{ organization_id: string; owner_user_id: string }>
        await Promise.all(
          owners.map(async (owner) => {
            const context = {
              organizationId: owner.organization_id as never,
              ownerUserId: owner.owner_user_id as never,
              actor: { type: "system" as const, id: "workgraph_reconciler" as never },
              requestId: `reconcile_${crypto.randomUUID()}` as never,
              access: { mode: "owner" as const },
            }
            await embedded.reconcile(context)
            await embedded.recaps.scheduleDue(context)
            await embedded.recaps.runDue(context)
            await embedded.sourcePlanning.runDue(context)
          }),
        )
      })
      .catch((error) => {
        console.error("[claxedo-server] WARN  workgraph reconciliation failed:", error)
      })
      .finally(() => {
        reconcilingWorkGraph = false
      })
  }, 1_000)
  workgraphReconciler.unref()

  mountLazyEmbeddedWorkGraph(built.app, async () => workgraph)

  // Loopback by default (safe for local dev); containers/self-host set
  // CLAXEDO_SERVER_HOST=0.0.0.0 to accept external traffic.
  const server = serve({
    fetch: built.app.fetch,
    port,
    hostname: process.env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1",
  })
  built.injectWebSocket(server)
  server.on("close", () => {
    clearInterval(workgraphReconciler)
    unsubscribeWorkGraphSessionIntake()
    if (workgraphDatabase.open) workgraphDatabase.close()
    void drainOpenCodeEngine()
  })

  // Initialize agent hooks (wrapper scripts, shell integration)
  setupAgentHooks({ port }).catch((err) => {
    console.error(`[claxedo-server] WARN  failed to setup agent hooks`, err)
  })

  process.on("SIGTERM", async () => {
    opencodeEvents.close()
    upstreamEvents?.close()
    await shutdownControlPlaneRuntime()
    server.close()
    process.exit(0)
  })

  return server
}

export function startServer(port = 3001, opencodeUrl?: string, opencodePassword?: string | null) {
  // `undefined` opencodeUrl => embedded engine (the default local composition).
  // An explicit URL is the external-URL opt-in.
  return startControlPlaneStack({
    services: createDefaultLocalControlPlaneServices(),
    port,
    ...(opencodeUrl ? { opencodeUrl } : {}),
    opencodePassword,
  })
}
