import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import Database from "better-sqlite3"
import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createNodeWebSocket } from "@hono/node-ws"
import { z } from "zod"
import { optionalGit, setupAgentHooks } from "@claxedo/workspace-runtime/host"
import type { ProcessObserver } from "@claxedo/workspace-runtime"
import { capture, initPostHog, shutdownPostHog } from "../../posthog"
import { initNodeObservability } from "../../observability/node"
import { reportError } from "../../observability/report"
import { requestIsHttps, securityHeaderEntries, withSecurityHeaders } from "../../security-headers"
import { configureAgentConfig, defaultHarness, loadUserConfig } from "../../agent-config"
import { eventsHandler } from "../../routes/events"
import { peerAddressStamp } from "../../routes/local-only-projection"
import { createConnectionsHost } from "../../hosts/connections/connections-host"
import { createConnectionTurnCredentials } from "../../hosts/connections/turn-credentials"
import { mirrorProcessEvents } from "../../process-events"
import { DocumentsRoutes } from "../../routes/documents"
import { AgentConfigRoutes } from "../../routes/agent-config"
import { SessionMetaRoutes } from "../../routes/session-meta"
import { WorkspaceRoutes } from "../../routes/workspace"
import { OpenCodeCompatRoutes } from "../../routes/opencode-compat"
import { resolveHarnessId } from "../../routes/opencode-compat-provider-config"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"
import { createLocalWorkspaceRelayProxy, createWorkspaceRuntimeProxy } from "../../proxy"
import { configureOpencodeMcpSync } from "../../opencode/mcp-sync"
import {
  configureOpenCodeApplicationTools,
  configureOpenCodeEmbedPath,
  configureOpenCodeEngine,
  drainOpenCodeEngine,
  opencodeEngineMode,
  opencodeRequest,
} from "../../opencode/engine"
import { createOpencodeEvents, type OpencodeEvent, type OpencodeEventsHandle } from "../../opencode/events"
import { claxedoBus, globalBus } from "../../lib/bus"
import {
  configureWorkspaceSupervisor,
  createWorkspaceSupervisorSandboxManager,
  shutdownWorkspaceSupervisor,
} from "../../workspace/supervisor/supervisor"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "./embedded-workspace-runtime"
import { configureOpenCodeAuth, opencodeHeaders } from "../../opencode/auth"
import { getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "../../governance/architecture"
import { createSqliteCentralStore } from "../../control-plane/adapters/sqlite/central-store"
import { migrateCredentials } from "../../credentials/migrate"
import { CredentialRoutes } from "../../routes/credential"
import { ProviderAuthRoutes } from "../../routes/provider-auth"
import { NetworkPolicyRoutes } from "../../routes/network-policy"
import { ProjectRemoteRoutes } from "../../routes/project-remote"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  type ControlPlaneRelay,
  type ControlPlaneServices,
} from "../../control-plane/services"
import {
  betterAuthAdapter,
  clerkAuthAdapter,
  controlPlaneAuthContext,
  ControlPlaneAuthError,
  signedCloudAuthRequested,
} from "../../control-plane/auth"
import {
  assertHostedBootRequirements,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "../../control-plane/deployment-mode"
import { EMBEDDED_AUTH_ISSUER, embeddedAuthEnabled, getEmbeddedAuth } from "./embedded-auth"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "../../control-plane/adapters/convex/convex-authority"
import { createSqliteWorkspaceAuthority } from "../../control-plane/adapters/sqlite/workspace-authority"
import { ControlPlaneHttpRoutes } from "../../control-plane/http"
import { createCentralControlApp } from "../../central-runtime"
import { JwksRoutes } from "../../control-plane/routes/jwks"
import { InternalRelayResolverRoutes } from "../../routes/internal-relay"
import { localRelayTargetExists, localRelayTargetLookup } from "../../routes/internal-relay-local"
import { BootstrapRoutes } from "../../routes/bootstrap"
import { hostTunnelTokenSigner, runtimeAccessTokenSigner } from "../../control-plane/runtime-access-token"
import { createControlPlaneRelayProvider } from "../../relay-provider"
import { sandboxFetch } from "../../sandbox-target-fetch"
import { WorkspaceCheckpointRoutes } from "../../routes/workspace-checkpoints"
import {
  ensureWorkspace,
  getWorkspaceByDirectory,
  listProjects,
  listWorkspaces,
  resolveWorkspace,
  subscribeLocalWorkspaceChanges,
} from "../../workspace/store/store"
import { defaultHomeRegion, relayEndpointsFromEnv } from "../../region"
import { createControlPlaneChannels, mountControlPlaneChannels } from "../../channels/control-plane"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "../../server-workspace-pty-proxy"
import {
  createClaxedoSessionEnvFactory,
  prepareWorkspaceRuntimeSession,
} from "../../hosts/workspace-runtime/session-env"
import {
  createLocalEmbeddedWorkGraph,
  mountLazyEmbeddedWorkGraph,
  recordLocalWorkGraphLlmUsage,
  requireLocalWorkGraphRepositoryDirectory,
} from "../../server-workgraph"
import { mountLocalOnlyUsageLimits } from "../../server-usage-limits"
import { centralModelBackend } from "../../central-session-runtime"
import { dataDir } from "../../lib/paths"
import { withDataDirOwnership } from "../../data-dir-owner"
import { createLocalDocumentsBackend } from "../../documents/local-backend"
import { setDocumentChangedSink } from "../../documents/backend"
import { LocalInstallationDocumentBroker } from "../../documents/local-installation-broker"
import { createLocalWorkspaceExecution, type WorkGraphSessionGateway } from "../../hosts/workgraph/local-execution"
import { createLocalExecutionCapabilities } from "../../hosts/workgraph/local-execution-capabilities"
import { createSqlitePullRequestEffects } from "../../hosts/workgraph/sqlite-pull-request-effects"
import { createLocalWorkGraphAgentTools, localSessionContext, localSessionExecution, localSessionOwnerDirected } from "../../workgraph-agent-tools"
import { provisionRegisteredWorktree, releaseRegisteredWorktree, workGraphWorkspaceId } from "../../worktree/service"
import { StreamIDSchema, masterRunId, masterSessionId } from "@claxedo/workgraph/contracts"
import type { CommandResult, WorkGraphRunOperationRequest, WorkGraphContext } from "@claxedo/workgraph/contracts"
import { sessionMeta } from "../../session/meta/meta"
import { llmTurnRecord, workGraphSessionAttribution } from "../../telemetry/metering"
import { ClaxedoDB } from "../../storage/db"
import { RemoteAccessRoutes } from "../../routes/remote-access"
import { createRemoteAccessService, unavailableRemoteAccessService } from "../../remote-access-service"
import { localHostIdentity, registrationPayload, signHostPayload } from "../../routes/workspace-local-host"
import { hasUserHostedMachineTunnel, startUserHostedMachineTunnel, stopUserHostedMachineTunnel } from "../../user-hosted-tunnel"

const execFileAsync = promisify(execFile)

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

export function localDocumentsBackend() {
  return createLocalDocumentsBackend({
    resolveWorkspace,
    sessionMeta,
    dataDir,
    reportError,
    runGit: async (args, directory, options) =>
      (
        await execFileAsync("git", [...args], {
          cwd: directory,
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
          ...(options?.maxBufferBytes ? { maxBuffer: options.maxBufferBytes } : {}),
        })
      ).stdout.trim(),
  })
}

function workspaceRouteOptions(services: ControlPlaneServices, connections?: Pick<ReturnType<typeof createConnectionsHost>, "repositoryForAuth">) {
  return {
    ...authRouteOptions(services),
    credentials: services.credentials,
    ...(connections ? { connections } : {}),
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

/* -------------------------------------------------------------------------
 * Security headers for the local / self-host server.
 *
 * This server is the ONE surface that answers both response classes. The
 * hosted control plane (`hosted-app.ts` + `security-headers.ts`) serves only
 * JSON and SSE, so it enforces `default-src 'none'`. Cloudflare Pages
 * (`packages/claxedo-app/public/_headers`) serves only the SPA, so it ships a
 * far more permissive document policy. Self-host serves BOTH: API routes plus,
 * when `CLAXEDO_APP_DIST_DIR` is set, the built claxedo-app bundle and its
 * index.html — from the same origin, on the same Hono app.
 *
 * So it gets both policies, split by which of the two surfaces answered:
 *
 *   API responses          -> the hosted set, imported verbatim from
 *                             ./security-headers (enforcing `default-src
 *                             'none'`, `X-Frame-Options: DENY`).
 *   SPA bundle responses   -> the document set below (enforcing
 *                             `frame-ancestors` only, full policy
 *                             report-only), mirroring the Pages policy.
 *
 * Blanket-applying the API policy would white-screen the self-hosted UI, and
 * not only via the document: `dist/assets/*.worker-*.js` are same-origin
 * MODULE workers, and a worker's own response CSP becomes its global CSP, so
 * `default-src 'none'` on those bytes would kill Shiki's WASM compile inside
 * the worker with no document-level violation to explain it. That is the
 * reason the split is by "did the SPA bundle answer this?" rather than by
 * `Content-Type: text/html`.
 * ------------------------------------------------------------------------- */

/**
 * Loopback origins the self-hosted SPA legitimately talks to over PLAINTEXT.
 *
 * Pages gets away with `connect-src 'self' https: wss:` because a Cloudflare
 * deploy only ever reaches an HTTPS control plane; the previous pass recorded
 * plaintext-loopback as a known violation that policy would report (see the
 * KNOWN GAP note in packages/claxedo-app/public/_headers). On self-host it is
 * not a report, it is the normal case: the box commonly runs on
 * `http://127.0.0.1:<port>`, the desktop build points the SPA at a loopback
 * control plane on a different port than the one serving the document, and a
 * locally hosted workspace relay is plain `ws://`. Same-origin `'self'` covers
 * only the single-process case where the control plane also served the HTML.
 *
 * Port wildcards, not pinned ports: control plane, workspace runtime and relay
 * each pick their own and `claxedo up` moves them. IPv6 literals
 * (`http://[::1]:*`) are deliberately absent — CSP's host-source grammar has no
 * portable syntax for them, so a loopback control plane must be addressed as
 * `localhost` or `127.0.0.1` to stay inside the policy.
 */
const SELF_HOST_LOOPBACK_CONNECT_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "ws://localhost:*",
  "ws://127.0.0.1:*",
] as const

/**
 * The ENFORCING half of the document policy: who may frame us, nothing else.
 *
 * Same reasoning as the Pages surface — a policy limited to `frame-ancestors`
 * governs embedding only and cannot break resource loading, so it is safe to
 * enforce without browser validation. `'self'` rather than `'none'` because it
 * is the same bundle Pages serves (which does frame same-origin routes such as
 * `/demo/?embed=1`), and same-origin framing is not a clickjacking vector.
 * The two claxedo.com origins Pages allows are deliberately NOT here: nothing
 * on the public marketing site embeds a user's private self-hosted box.
 */
export const SELF_HOST_DOCUMENT_FRAME_ANCESTORS = "frame-ancestors 'self'"

/**
 * The full document policy — REPORT-ONLY, and it must stay that way until it
 * is validated against a running self-hosted app with a live backend.
 *
 * Directive-for-directive the Pages policy from
 * packages/claxedo-app/public/_headers (the source of truth for what this
 * bundle actually needs; every relaxation in it is load-bearing and documented
 * there), with two deliberate deltas:
 *
 *   1. `connect-src` adds SELF_HOST_LOOPBACK_CONNECT_SOURCES — see above.
 *   2. `frame-ancestors` drops the claxedo.com origins — see above.
 *
 * It is duplicated rather than imported because `_headers` is a Cloudflare
 * Pages config file with no importable form, and hoisting a shared constant
 * would mean editing files this pass does not own. Keep the two in sync: that
 * file is the source of truth, and security-headers.test.ts pins its contents.
 *
 * VALIDATED, by serving the real `packages/claxedo-app/dist` from this server
 * with these exact headers and driving it in a browser against a live backend:
 * the SPA boots and renders (project list, not a white screen), the module
 * entry + Clerk vendor bundle + CSS load, the inline <style> and the inline
 * style attribute on <html> apply, WASM compiles on the main thread, two blob
 * workers and `assets/markdown-shiki.worker-*.js` (a same-origin MODULE
 * worker, served by this mount with these headers) construct and run, the
 * `/api/wr/events` SSE stream and the JSON API routes work under the strict
 * API policy, and a `ws://127.0.0.1:*` open is not a CSP violation. Zero
 * report-only violations across all of it. The policy was confirmed live and
 * genuinely restrictive by probe: `http://192.0.2.1` reports a `connect-src`
 * violation with `disposition: "report"` while `http://127.0.0.1:4311` does
 * not.
 *
 * NOT yet exercised, which is why this stays REPORT-ONLY: sign-in/sign-up
 * (Clerk's frontend API origin, Turnstile at challenges.cloudflare.com, the
 * Clerk avatar host on img-src) — the box ran unsigned-local, so Clerk loaded
 * but no auth flow ran; a real workspace session and the terminal's wss to a
 * relay; file review actually driving the Shiki worker. KNOWN GAP: a LAN
 * self-host deploy whose control plane is a plaintext NON-loopback origin
 * (e.g. document on `http://192.168.1.5:3001`, control plane on
 * `http://192.168.1.5:4311` — a different origin, so `'self'` misses it) is
 * outside this policy and would report. Harmless while report-only; it must be
 * resolved before promotion.
 *
 * PROMOTION CHECKLIST (do not promote on "compat doesn't matter" — promote on
 * evidence): (1) re-run the box above, (2) exercise the four NOT-yet legs,
 * (3) fold in whatever reports show, (4) decide the LAN plaintext case,
 * (5) rename the header to `content-security-policy` in one reviewable diff.
 */
export const SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  SELF_HOST_DOCUMENT_FRAME_ANCESTORS,
  "script-src 'self' 'wasm-unsafe-eval' https://*.i.posthog.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "media-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  `connect-src 'self' https: wss: ${SELF_HOST_LOOPBACK_CONNECT_SOURCES.join(" ")}`,
  "frame-src https://challenges.cloudflare.com",
].join("; ")

/**
 * The header set for a response served out of the SPA bundle.
 *
 * Built ON TOP of the hosted `securityHeaderEntries` so `nosniff`,
 * `Referrer-Policy`, the HSTS value and — critically — the HTTPS gating stay
 * byte-identical across all three surfaces; only the two headers a document
 * surface must relax are overridden, plus the report-only policy appended.
 */
export function selfHostDocumentSecurityHeaderEntries(input: {
  https: boolean
}): ReadonlyArray<readonly [string, string]> {
  const overrides: Record<string, string> = {
    "content-security-policy": SELF_HOST_DOCUMENT_FRAME_ANCESTORS,
    // Legacy clickjacking header for pre-CSP2 browsers; every current browser
    // ignores it when `frame-ancestors` is present. SAMEORIGIN to match
    // `frame-ancestors 'self'` — DENY here would be the stricter policy on old
    // browsers only, and would break same-origin embeds for no security gain.
    "x-frame-options": "SAMEORIGIN",
  }
  return [
    ...securityHeaderEntries(input).map(([name, value]) => [name, overrides[name] ?? value] as const),
    ["content-security-policy-report-only", SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY] as const,
  ]
}

/**
 * Requests that reached the SPA bundle mount.
 *
 * Keyed on the raw `Request`, which is stable for the life of one request and
 * garbage-collected with it. The mark is set on ENTRY to the bundle handlers,
 * which are registered last and only run when no API route finalized the
 * response — so "marked" means exactly "the SPA bundle, not an API route,
 * answered this", including the index.html client-routing fallback and a
 * bundle 404.
 */
const spaBundleRequests = new WeakSet<Request>()

/** Marks a request as answered by the SPA bundle. Mounted on the bundle routes. */
const markSpaBundleRequest: MiddlewareHandler = async (c, next) => {
  spaBundleRequests.add(c.req.raw)
  await next()
}

/**
 * Outermost middleware for the local server — the counterpart to
 * `securityHeaders()` in hosted-app.ts, and mounted the same way: once, at
 * composition, ahead of everything, so "no route can ship bare" is a property
 * of the shell rather than a per-route review item.
 *
 * The write happens after `next()` so it also covers the CORS preflight, the
 * 404 handler and whatever `onError` produced — a 500 without `nosniff` is
 * precisely the response worth sniffing into a document.
 */
export function localSecurityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const https = requestIsHttps(c.req)
    const entries = spaBundleRequests.has(c.req.raw)
      ? selfHostDocumentSecurityHeaderEntries({ https })
      : securityHeaderEntries({ https })
    const stamped = withSecurityHeaders(c.res, entries)
    // Only needed when the immutable-headers fallback rebuilt the response
    // (proxied `fetch()` results carry an immutable header guard).
    if (stamped !== c.res) c.res = stamped
  }
}

export function createApp(
  services: ControlPlaneServices,
  options: {
    onOpencodeAccess?: () => void
    beforeLocalSessionList?: () => Promise<void>
  } = {},
) {
  if (!services.localExecution.enabled) {
    throw new ControlPlaneCompositionError(
      "self_host_app_required",
      "createApp is the self-host composition; use createHostedApp for hosted services",
    )
  }
  const localDocumentBrokerToken = process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN?.trim()
  delete process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN
  const app = new Hono()
  // Outermost ON PURPOSE, ahead of CORS, the unsigned-local gate and every
  // route — so the preflight CORS short-circuits, the 404 handler and anything
  // `onError` produces are all covered. Which of the two policies a response
  // gets is decided from the SPA-bundle mark set further down; see the block
  // above `createApp` for why this server needs two.
  app.use(localSecurityHeaders())
  // Record the transport peer address for every request (including
  // @hono/node-ws upgrades, whose Requests lack the node-server internals)
  // so loopback gates verify the socket, not the spoofable Host header.
  app.use(peerAddressStamp())
  // D12: top-level error handler. Hono's
  // default onError swallows route exceptions into bare 500s; this keeps that
  // exact response behavior (HTTPException responses pass through) while
  // reporting server exceptions through the observability seam — a no-op
  // unless a PostHog key is configured.
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
    admitWorkspaceSession: async (input) => {
      const workspace = await resolveWorkspace({ workspaceId: input.workspaceId })
      if (!workspace) throw new Error(`workspace not found: ${input.workspaceId}`)
      return prepareWorkspaceRuntimeSession({
        workspace,
        sessionId: input.sessionId,
        ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
        fetchOptions: runtimeProxyOptions,
      })
    },
    turnCredentials,
    ...(options.beforeLocalSessionList ? { beforeLocalSessionList: options.beforeLocalSessionList } : {}),
  })
  const controlPlaneChannels = createControlPlaneChannels({
    services,
    runtime: centralControl.runtime,
    includeFake: true,
  })
  const connectionsHost = createConnectionsHost({
    credentials: services.credentials,
    turnCredentials,
    ...authRouteOptions(services),
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
  app.route("/", ProviderAuthRoutes(services, {
    ...authRouteOptions(services),
    // Only when the OpenCode-compat routes are actually mounted below; with
    // local execution off nothing else serves `/provider/auth`, and deferring
    // would turn the registry's answer into a 404.
    ...(services.localExecution.enabled
      ? {
          deferToHarnessRoute: async (harness) =>
            // Normalize first so the legacy aliases (`?runner=`, `claude-acp`,
            // …) resolve the same way the compat routes resolve them; an
            // absent or unrecognised name falls back to the configured default.
            await resolveHarnessId(harness ? normalizeHarnessIdentity(harness)?.id : undefined) === "opencode",
        }
      : {}),
  }))
  const remoteAccessRelayUrl = services.relay.relayUrl ?? Object.values(services.relay.relayUrls ?? {})[0]
  const remoteAccessSigner = services.relay.hostTunnelTokenSigner
  app.route("/api/claxedo/remote-access", RemoteAccessRoutes({
    deviceLoginConfigured: !!process.env.CLAXEDO_DEVICE_LOGIN_ISSUER?.trim(),
    relayConfigured: !!remoteAccessRelayUrl && !!remoteAccessSigner,
    authenticate: async (request) => {
      const auth = await controlPlaneAuthContext(request, {
        config: services.auth.config,
        ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
      })
      if (auth.mode === "signed") return auth
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    },
    service: services.authority ? createRemoteAccessService({
      authority: services.authority,
      relayUrl: remoteAccessRelayUrl ?? "",
      hostTunnelTokenSigner: remoteAccessSigner ?? (async () => {
        throw new ControlPlaneAuthError(503, "host_tunnel_token_signer_unavailable", "Host Tunnel Token signer is not configured")
      }),
      listLocalWorkspaces: async () => (await listWorkspaces()).map((workspace) => ({
        id: workspace.id,
        kind: workspace.kind,
        displayName: workspace.workspace_name ?? workspace.project_name ?? workspace.repo_name ?? workspace.id,
        projectId: workspace.project_id,
        repoUrl: workspace.repo_url ?? workspace.git_remote,
        repoName: workspace.repo_name,
        gitBranch: workspace.git_branch,
      })),
      subscribeLocalWorkspaces: (listener) => subscribeLocalWorkspaceChanges(listener),
      localHostIdentity,
      signHostPayload,
      registrationPayload,
      startMachineTunnel: startUserHostedMachineTunnel,
      stopMachineTunnel: stopUserHostedMachineTunnel,
      machineTunnelActive: hasUserHostedMachineTunnel,
      capture: (distinctId, event, properties) => services.telemetry.capture(distinctId, event, properties),
    }) : unavailableRemoteAccessService(),
  }))

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
    // `...authRouteOptions(services)` is load-bearing: the global
    // `unsignedLocalRequestGuard` above steps aside as soon as signed auth is
    // enabled, and a signed self-host box (CLAXEDO_EMBEDDED_AUTH=1) is remotely
    // reachable by design, so without it this router's destructive verbs are
    // open to anyone who can reach the box. See routes/opencode-compat.ts.
    app.route(
      "/",
      OpenCodeCompatRoutes({
        services,
        env: process.env,
        ...authRouteOptions(services),
        onOpencodeAccess: options.onOpencodeAccess,
      }),
    )

    // Runtime-owned local routes are dispatched through the embedded
    // workspace-runtime host by workspaceRuntimeProxy above.
  }
  // Claxedo events SSE — auth-gated via the same control-plane bearer used
  // by /api/control/* and /api/workspace/* (rubric S1). authFetch on the
  // frontend already attaches the token because the consumer uses fetch+
  // ReadableStream, not raw EventSource. Signed subscribers resolve their
  // AUTHORITY-INTERNAL org id at connect so org-scoped events
  // (document.changed/provision, stamped with internal ids) are visible.
  app.get(
    "/api/claxedo/events",
    eventsHandler({
      ...authRouteOptions(services),
      allowLoopbackLocal: true,
      ...(services.authority ? { resolveOrgId: (auth) => services.authority!.resolveOrgId(auth) } : {}),
    }),
  )

  const documentsBackend = localDocumentsBackend()
  // Documents doorbell. The documents backend is
  // Worker-safe and cannot import the bus, so the local composition root injects
  // the publish here. Every document mutation — saves AND `fs.watch` external
  // changes — funnels through `publishDocumentEvent`, so this one line covers
  // both paths. Hosted (`hosted-app.ts`) injects a LiveSyncRoom nudge sink
  // through the DocumentsRoutes option instead of this process-global one.
  setDocumentChangedSink((event) => claxedoBus.publish(event))
  app.route(
    "/documents",
    DocumentsRoutes({
      backend: documentsBackend,
      services,
      ...authRouteOptions(services),
    }),
  )
  app.route("/internal/documents", LocalInstallationDocumentBroker({
    backend: documentsBackend,
    ...(localDocumentBrokerToken ? { installationToken: localDocumentBrokerToken } : {}),
    env: process.env,
  }))

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
  app.route("/api/workspace", WorkspaceRoutes(services, workspaceRouteOptions(services, connectionsHost)))
  app.route("/api/workspace", WorkspaceCheckpointRoutes(services, {
    loopbackRelayUrl: services.relay.relayUrl,
    defaultHomeRegion: services.defaultHomeRegion,
    allowUnsignedLocal: true,
  }))
  app.route("/api/control", ControlPlaneHttpRoutes(services, authRouteOptions(services)))
  app.route("/", centralControl.app)
  app.route(
    "/api/claxedo/credentials",
    CredentialRoutes(services.credentials, {
      // Public/deployed boxes MUST set CLAXEDO_CREDENTIALS_TOKEN (see
      // CredentialRoutesOptions.token). Local loopback dev may leave it unset.
      ...(process.env.CLAXEDO_CREDENTIALS_TOKEN?.trim() ? { token: process.env.CLAXEDO_CREDENTIALS_TOKEN.trim() } : {}),
      ...((signedCloudAuthRequested(process.env) || deploymentMode(process.env) === "hosted") ? {
        authenticate: async (request: Request) => {
          const auth = await controlPlaneAuthContext(request, {
            config: services.auth.config,
            ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
          })
          if (auth.mode !== "signed") {
            throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
          }
        },
      } : {}),
    }),
  )
  // Self-host Connections routes use the local host composition. Hosted
  // Connections are mounted by createHostedApp with org, membership, and
  // entitlement checks bound to the hosted authority.
  app.route("/api/claxedo/integrations", connectionsHost.routes)
  app.route("/api/claxedo/network-policy", NetworkPolicyRoutes(authRouteOptions(services)))
  // Setup derives the cloud clone source from the folder the user picked, so
  // this reads the local filesystem and is mounted only in the local
  // composition. `optionalGit` supplies the bounded concurrency and 10s
  // timeout; the route maps its GitTimeoutError to a `git_timeout` answer.
  app.route("/api/claxedo/project", ProjectRemoteRoutes({
    ...authRouteOptions(services),
    git: optionalGit,
    isDirectory: async (directory) => (await fs.promises.stat(directory).catch(() => undefined))?.isDirectory() ?? false,
  }))
  mountLocalOnlyUsageLimits(app, authRouteOptions(services))
  mountControlPlaneChannels(app, {
    services,
    runtime: centralControl.runtime,
    includeFake: true,
    channels: controlPlaneChannels,
  })

  // Web UI parity (W2): serve a built claxedo-app bundle from the box when
  // CLAXEDO_APP_DIST_DIR points at one (self-host single-process deploys).
  // Mounted LAST so every API route wins; unmatched GETs fall through to the
  // bundle, and unknown html paths get the SPA index (client-side routing,
  // e.g. /s/:sessionId). No env → no behavior change (local dev, hosted).
  const staticDir = process.env.CLAXEDO_APP_DIST_DIR?.trim()
  if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
    const root = path.relative(process.cwd(), staticDir) || "."
    // `markSpaBundleRequest` runs first in the composed chain for both routes
    // below, so every response the bundle produces — asset, index.html
    // fallback, or bundle 404 — is stamped with the DOCUMENT policy instead of
    // the API lockdown. Reaching here at all already means no API route
    // finalized the response.
    app.get("*", markSpaBundleRequest, serveStatic({ root }))
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
    channels: controlPlaneChannels,
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
  opencodeEmbedPath?: string
  processObserver?: ProcessObserver
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
      sessionWriteMode: services.sessionWriteMode?.(),
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
  // The health endpoint means the central projection is ready to serve. Open
  // SQLite here so the renderer's first session-list request does not pay for
  // migrations, repair checks, WAL checkpointing, and statement preparation.
  ClaxedoDB.raw()
  const authority = authorityUrl ? createConvexAuthority({ url: authorityUrl }) : createSqliteWorkspaceAuthority()
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
      authority,
      relay: localRelayFromEnv(sandboxManager, authority),
      sandbox: {
        sandboxManager,
      },
      telemetry: { capture },
      defaultHomeRegion: defaultHomeRegion(process.env),
    },
  )
}

function localRelayFromEnv(
  sandboxManager = createWorkspaceSupervisorSandboxManager(),
  authority = createSqliteWorkspaceAuthority(),
): ControlPlaneRelay {
  const relayUrl = process.env.CLAXEDO_WORKSPACE_RELAY_URL?.trim()
  const resolverToken = process.env.CLAXEDO_RELAY_RESOLVER_TOKEN?.trim()
  const hasSigningKeyPair =
    !!process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM?.trim()
    && !!process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.trim()
  const runtimeSigner = hasSigningKeyPair ? runtimeAccessTokenSigner() : undefined
  const hostSigner = hasSigningKeyPair ? hostTunnelTokenSigner() : undefined
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
            recordRuntimeAccessToken: (input) =>
              authority.recordRuntimeAccessTokenForService({
                jti: input.jti,
                workspaceId: input.workspaceId,
                hostId: input.hostId,
                subject: input.subject,
                expiresAt: input.expiresAt,
              }),
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
  return withDataDirOwnership(dataDir(), (dataDirOwner) => {
    const releaseDataDirOwner = () => {
      try {
        dataDirOwner.release()
      } catch (error) {
        console.warn("[claxedo-server] failed to release data directory ownership", error)
      }
    }
    process.once("exit", releaseDataDirOwner)
    try {
      return startOwnedControlPlaneStack(options, releaseDataDirOwner)
    } catch (error) {
      process.off("exit", releaseDataDirOwner)
      throw error
    }
  })
}

function startOwnedControlPlaneStack(options: ControlPlaneStackOptions, releaseDataDirOwner: () => void) {
  const port = options.port ?? 3001
  // No external opencodeUrl configured => embed the engine in-process (default).
  // An explicit opencodeUrl is the external-URL opt-in. NOTHING listens on :4096.
  const opencodeCompat = process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT !== "1"
  const services = options.services
  let executeWorkGraphRun:
    | ((context: WorkGraphContext, request: WorkGraphRunOperationRequest) => Promise<CommandResult>)
    | undefined
  let recordWorkGraphPullRequest:
    | ((context: WorkGraphContext, input: Readonly<{
        streamId: string
        runId: string
        idempotencyKey: string
        pullRequestId: string
        url: string
        draft: boolean
      }>) => Promise<Readonly<{ durableEffectReceiptId: string; evidenceId?: string }>>)
    | undefined
  let authorizeWorkGraphPullRequest:
    | ((context: WorkGraphContext, input: Readonly<{
        streamId: string
        repository: string
        title: string
        draft: boolean
        publicRepository: boolean
      }>) => Promise<boolean>)
    | undefined
  const localWorkGraphRuns = new Map<
    string,
    Readonly<{
      identity: WorkGraphRunOperationRequest["identity"]
      context: WorkGraphContext
    }>
  >()
  const workgraphDatabase = new Database(path.join(dataDir(), "workgraph-v2.db"))
  const sameRunIdentity = (
    left: WorkGraphRunOperationRequest["identity"],
    right: WorkGraphRunOperationRequest["identity"],
  ) =>
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation
  const recordLocalWorkGraphUsage = (event: OpencodeEvent) => {
    if (event.payload.type !== "message.updated") return
    const info = event.payload.properties?.info
    const record = llmTurnRecord({ message: info, harness: "workgraph" })
    if (!record) return
    const binding = localWorkGraphRuns.get(record.session_id)
    if (!binding) return
    const completedAt =
      info &&
      typeof info === "object" &&
      "time" in info &&
      info.time &&
      typeof info.time === "object" &&
      "completed" in info.time &&
      typeof info.time.completed === "number"
        ? info.time.completed
        : undefined
    if (completedAt === undefined) return
    const attribution = workGraphSessionAttribution(record.session_id)
    void recordLocalWorkGraphLlmUsage(workgraphDatabase, binding.context, {
      id: `llm_turn:${record.session_id}:${record.message_id}`,
      sessionId: record.session_id,
      streamId: attribution?.streamId ?? binding.identity.streamId,
      runId: attribution?.runId ?? binding.identity.runId,
      workItemId: attribution?.workItemId,
      providerId: record.provider_id,
      modelId: record.model_id,
      inputTokens: record.input_tokens,
      outputTokens: record.output_tokens,
      reasoningTokens: record.reasoning_tokens,
      cacheReadTokens: record.cache_read_tokens,
      cacheWriteTokens: record.cache_write_tokens,
      createdAt: completedAt,
    }).catch((error) => {
      reportError(error, { tags: { source: "workgraph_llm_usage" } })
    })
  }
  configureOpenCodeAuth(options.opencodePassword)
  configureOpenCodeEmbedPath(options.opencodeEmbedPath)
  if (options.opencodeUrl) {
    configureOpenCodeEngine({ url: options.opencodeUrl, headers: opencodeHeaders() })
  } else {
    configureOpenCodeEngine({ embedded: true })
    // Stored AI credentials live in Claxedo's registry; the engine resolves
    // auth from its own store. Reconcile at boot so an already-stored key powers
    // the first turn — mutations after this keep the two in step (see
    // credentials/engine-bridge.ts). Deferred and non-blocking: it boots the
    // engine lazily and must not gate server startup.
    void import("../../credentials/engine-bridge")
      .then((bridge) => bridge.syncCredentialsToEngine())
      .catch(() => {})
  }
  configureOpenCodeApplicationTools(undefined)
  initPostHog()
  // Error tracking rides the client initPostHog just built — no-op unless a
  // PostHog key is configured (release = git SHA via CLAXEDO_RELEASE/GIT_SHA;
  // events carry unit=server + deployment_mode). See observability/node.ts.
  initNodeObservability(process.env)
  mirrorProcessEvents()
  configureOpencodeMcpSync({ enabled: opencodeCompat })
  configureEmbeddedWorkspaceRuntime({
    opencodeRequest,
    opencodeCompat,
    piModelBackend: centralModelBackend().modelBackend,
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    workgraphRunBroker: async (request, signal) => {
      if (signal.aborted) throw signal.reason ?? new Error("WorkGraph Run operation was cancelled")
      const binding = localWorkGraphRuns.get(request.identity.sessionId)
      if (!binding || !sameRunIdentity(binding.identity, request.identity)) {
        throw new Error("WorkGraph Run operation identity is not bound to this runtime")
      }
      if (!executeWorkGraphRun) throw new Error("WorkGraph Run command broker is not ready")
      return executeWorkGraphRun(binding.context, request)
    },
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
      recordLocalWorkGraphUsage(event)
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
    beforeLocalSessionList: async () => {
      if (localSessionProjectionReady) return
      localSessionProjectionReady = new Promise((resolve) => {
        setTimeout(() => {
          void refreshLocalSessionProjection()
            .catch((error) => {
              console.warn("[claxedo-server] local session projection refresh failed", error)
            })
            .finally(resolve)
        }, 250).unref()
      })
    },
  })
  const workgraphRuntimes = new Map<
    string,
    Promise<{
      workspaceId: string
      runtime: Awaited<ReturnType<typeof ensureEmbeddedWorkspaceRuntime>>
    }>
  >()
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
  const workgraphSessionModule = import("../../workgraph-session-gateway")
  const workgraphBindings = workgraphSessionModule.then((gateway) =>
    gateway.createFileWorkGraphSessionBindingStore(path.join(dataDir(), "workgraph-session-bindings.json")),
  )
  const workgraphSessions = Promise.all([workgraphSessionModule, workgraphBindings]).then(([gateway, bindings]) =>
    gateway.createHarnessWorkGraphGateway(opencodeRequest, {
      connections: built.connections,
      resolveTeamOwner: () => undefined,
      executeRun: async (context, request, signal) => {
        if (signal.aborted) throw signal.reason
        if (!executeWorkGraphRun) throw new Error("WorkGraph Run command broker is not ready")
        return executeWorkGraphRun(context, request)
      },
      recordPullRequest: async (context, input) => {
        if (!recordWorkGraphPullRequest) throw new Error("WorkGraph pull request receipt broker is not ready")
        return recordWorkGraphPullRequest(context, input)
      },
      authorizePullRequest: async (context, input) => {
        if (!authorizeWorkGraphPullRequest) throw new Error("WorkGraph pull request authorization broker is not ready")
        return authorizeWorkGraphPullRequest(context, input)
      },
      pullRequestEffects: createSqlitePullRequestEffects(workgraphDatabase),
      runContexts: {
        bind: async (input) => {
          const existing = localWorkGraphRuns.get(input.identity.sessionId)
          if (
            existing &&
            (!sameRunIdentity(existing.identity, input.identity) ||
              existing.context.organizationId !== input.context.organizationId ||
              existing.context.ownerUserId !== input.context.ownerUserId)
          )
            throw new Error("WorkGraph Session is already bound to another Run owner")
          localWorkGraphRuns.set(input.identity.sessionId, input)
        },
        release: async (sessionId) => {
          localWorkGraphRuns.delete(sessionId)
        },
      },
      bindings,
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
  void workgraphBindings
    .then((store) => store.all())
    .then((bindings) => Promise.allSettled(bindings.map((binding) => workgraphRuntime(binding.directory))))
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
  const workgraphWorktreeRoot = path.join(dataDir(), "workgraph-worktrees")
  const workgraphExecution = createLocalWorkspaceExecution({
    worktreeRoot: workgraphWorktreeRoot,
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
      resolveTeamOwner: () => undefined,
      // Validate a New-stream directory selector against the authoritative local
      // workspace catalog (the same registry that backs /project). Only a known
      // local (non-cloud) project directory is honored; everything else fails
      // closed so git never runs against an arbitrary user-supplied path.
      resolveRepositoryDirectory: async (directory) => {
        const workspace = await getWorkspaceByDirectory(directory).catch(() => undefined)
        if (!workspace || workspace.kind === "cloud") return undefined
        return workspace.directory
      },
      // Live SDK-harness model lists for the workgraph catalog, served by the
      // embedded workspace runtime (in-process for local workspaces). Failure
      // falls back to the static catalog inside sdkProviders.
      harnessConfigOptions: async (harness) => {
        const workspace = await getWorkspaceByDirectory(workgraphRepositoryDirectory).catch(() => undefined)
        if (!workspace || workspace.kind === "cloud") return undefined
        const search = new URLSearchParams({ directory: workspace.directory, harness })
        const response = await sandboxFetch(workspace, `/api/wr/harness-config-options?${search}`)
        if (!response.ok) return undefined
        return response.json()
      },
    }),
    sourcePlanning: { sessions: workgraphSessionGateway, directory: workgraphRepositoryDirectory },
    master: {
      sessions: workgraphSessionGateway,
      directory: (context, streamId) => path.join(
        workgraphWorktreeRoot,
        Buffer.from(context.organizationId).toString("base64url"),
        Buffer.from(context.ownerUserId).toString("base64url"),
        Buffer.from(streamId).toString("base64url"),
        "envelope",
      ),
    },
    connections: built.connections,
    resolveTeamOwner: () => undefined,
    telemetry: services.telemetry,
  })
  void workgraph.then((embedded) => {
    // Master identity must resolve to the server-authored master session
    // binding — self-consistent strings alone are forgeable by any local
    // caller of the run-tools route.
    const requireLocalMasterIdentity = async (
      context: Parameters<NonNullable<typeof executeWorkGraphRun>>[0],
      identity: Readonly<{ streamId?: string; sessionId: string; runId: string }>,
      label: string,
    ) => {
      const streamId = identity.streamId
      if (!streamId || identity.sessionId !== masterSessionId(streamId) || identity.runId !== masterRunId(streamId)) {
        throw new Error(`${label} requires an exact master identity`)
      }
      const binding = await embedded.sessionBindings.readForSession(context, identity.sessionId)
      if (binding?.streamId !== streamId) {
        throw new Error(`${label} is not bound to the Stream master session`)
      }
      return StreamIDSchema.parse(streamId)
    }
    executeWorkGraphRun = async (context, request) => {
      if (request.operation.type === "update_stream_notes") {
        const streamId = await requireLocalMasterIdentity(context, request.identity, "Stream notes")
        const masterContext = { ...context, actor: { type: "agent" as const, id: request.identity.sessionId as never } }
        const stream = await embedded.service.queries.streams.read(masterContext, { streamId })
        if (!stream) throw new Error("Stream notes master could not resolve its Stream")
        return embedded.service.execute(masterContext, {
          operationId: request.operation.operationId,
          command: {
            version: 1,
            type: "update_stream_notes",
            streamId: stream.id,
            expectedVersion: stream.version,
            status: request.operation.status,
            learnings: request.operation.learnings,
            externalReferences: request.operation.externalReferences,
          },
        })
      }
      if (request.operation.type === "notify_owner") {
        const streamId = await requireLocalMasterIdentity(context, request.identity, "Owner notification")
        const delivery = await built.channels.notifyOwner({
          ownerUserId: context.ownerUserId,
          idempotencyKey: request.operation.operationId,
          text: request.operation.message,
        })
        return embedded.service.execute({
          ...context,
          actor: { type: "agent", id: request.identity.sessionId as never },
        }, {
          operationId: request.operation.operationId,
          command: {
            version: 1,
            type: "record_evidence",
            subject: { type: "stream", streamId },
            evidence: {
              kind: "integration",
              summary: `Notified the Stream owner through ${delivery.channel}`,
              effect: "published",
              reference: delivery.reference,
            },
          },
        })
      }
      return embedded.service.execute(context, {
        operationId: request.operation.operationId,
        command:
          request.operation.type === "record_checkpoint"
            ? {
                version: 1,
                type: "record_run_checkpoint",
                runId: request.identity.runId,
                sessionId: request.identity.sessionId,
                workspaceId: request.identity.workspaceId,
                generation: request.identity.generation,
                level: request.operation.level,
                summary: request.operation.summary,
                evidenceIds: request.operation.evidenceIds,
              }
            : {
                version: 1,
                type: "complete_run",
                runId: request.identity.runId,
                sessionId: request.identity.sessionId,
                workspaceId: request.identity.workspaceId,
                generation: request.identity.generation,
                summary: request.operation.summary,
                artifacts: request.operation.artifacts,
                evidence: request.operation.evidence,
              },
      })
    }
    recordWorkGraphPullRequest = async (context, input) => {
      const result = await embedded.service.execute(context, {
        operationId: `pull_request_${input.idempotencyKey}` as never,
        command: {
          version: 1,
          type: "record_evidence",
          subject: { type: "stream", streamId: input.streamId as never },
          evidence: {
            kind: "integration",
            summary: `Opened ${input.draft ? "draft " : ""}pull request ${input.pullRequestId}`,
            effect: "published",
            reference: input.url,
          },
        },
      })
      if (!result.ok) throw new Error(result.error.message)
      const value = result.value as { durableEffectReceiptId?: string; evidenceId?: string }
      if (!value.durableEffectReceiptId) throw new Error("Pull request durable effect receipt is missing")
      return {
        durableEffectReceiptId: value.durableEffectReceiptId,
        ...(value.evidenceId ? { evidenceId: value.evidenceId } : {}),
      }
    }
    authorizeWorkGraphPullRequest = async (context, input) => {
      if (input.draft || !input.publicRepository) return true
      const stream = await embedded.service.queries.streams.read(context, { streamId: input.streamId as never })
      if (!stream) throw new Error("Pull request Stream is unavailable")
      if (stream.publicPrConfirmedAt !== undefined) return true
      // The request command is idempotent-by-design (an already-pending
      // confirmation is a success no-op), so every call gets a fresh
      // operation id — a fixed id plus a version-varying payload would turn
      // retries into idempotency conflicts. Any command failure denies:
      // an unconfirmed public PR never proceeds on an error path.
      const result = await embedded.service.execute(context, {
        operationId: `public_pr_confirmation_${input.streamId}_${crypto.randomUUID()}` as never,
        command: {
          version: 1,
          type: "request_public_pr_confirmation",
          streamId: input.streamId as never,
          expectedVersion: stream.version,
          repository: input.repository,
          title: input.title,
        },
      })
      if (!result.ok) {
        console.error("[claxedo-server] WARN  public PR confirmation request failed:", result.error.message)
      }
      return false
    }
  })
  if (!services.auth.config.enabled && services.auth.config.mode === "local-only" && !options.opencodeUrl) {
    configureOpenCodeApplicationTools(() =>
      workgraph.then((embedded) =>
        createLocalWorkGraphAgentTools(embedded, {
          organizationId: "local",
          ownerUserId: "local",
          sessionExecution: (sessionId) => localSessionExecution(opencodeRequest, sessionId),
          sessionContext: (sessionId) => localSessionContext(opencodeRequest, sessionId),
          sessionOwnerDirected: (sessionId) => localSessionOwnerDirected(opencodeRequest, sessionId),
          notifyOwner: (input) => built.channels.notifyOwner({ ownerUserId: "local", ...input }),
        }),
      ),
    )
  }
  let unsubscribeWorkGraphSessionIntake = () => {}
  if (!services.auth.config.enabled && services.auth.config.mode === "local-only") {
    void Promise.all([workgraph, import("../../hosts/workgraph/session-intake")]).then(([embedded, intake]) => {
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
        SELECT organization_id, owner_user_id FROM wg_v2_runs WHERE lifecycle = 'running' AND session_id IS NOT NULL
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
            await embedded.sourcePlanning.runDue(context)
            // Doorbell safety net: nudge clients when this
            // owner's change log advanced by any path that does not run through
            // `service.execute` (run settlement, source planning,
            // activity, intake). Tip-conditional, so an idle owner emits nothing.
            embedded.observeChanges(context)
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
  const stopServer = async () => {
    opencodeEvents.close()
    upstreamEvents?.close()
    await shutdownControlPlaneRuntime()
    server.close()
    process.exit(0)
  }
  server.on("close", () => {
    process.off("SIGTERM", stopServer)
    process.off("SIGINT", stopServer)
    process.off("exit", releaseDataDirOwner)
    releaseDataDirOwner()
    clearInterval(workgraphReconciler)
    unsubscribeWorkGraphSessionIntake()
    if (workgraphDatabase.open) workgraphDatabase.close()
    void drainOpenCodeEngine()
  })

  // Initialize agent hooks (wrapper scripts, shell integration)
  setupAgentHooks({ port }).catch((err) => {
    console.error(`[claxedo-server] WARN  failed to setup agent hooks`, err)
  })

  process.on("SIGTERM", stopServer)
  process.on("SIGINT", stopServer)

  return server
}

export function startServer(
  port = 3001,
  opencodeUrl?: string,
  opencodePassword?: string | null,
  options: { processObserver?: ProcessObserver; opencodeEmbedPath?: string } = {},
) {
  // `undefined` opencodeUrl => embedded engine (the default local composition).
  // An explicit URL is the external-URL opt-in.
  return startControlPlaneStack({
    services: createDefaultLocalControlPlaneServices(),
    port,
    ...(opencodeUrl ? { opencodeUrl } : {}),
    opencodePassword,
    ...(options.opencodeEmbedPath ? { opencodeEmbedPath: options.opencodeEmbedPath } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  })
}
