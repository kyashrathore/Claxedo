import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
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
import { importJWK, importSPKI } from "jose"
import { verifyRelayHostToken, verifyRuntimeAccessToken } from "@claxedo/workspace-relay"
import { z } from "zod"
import {
  optionalGit,
  setupAgentHooks,
} from "@claxedo/workspace-runtime/host"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessRequiresWrite,
  type ProcessObserver,
  type SessionAccessStreamDecision,
  type SessionAuthorityInput,
} from "@claxedo/workspace-runtime"
import { capture, initPostHog, shutdownPostHog } from "../../platform/telemetry/errors/posthog"
import { initNodeObservability } from "../../platform/telemetry/errors/node"
import { reportError } from "../../platform/telemetry/errors/report"
import { requestIsHttps, securityHeaderEntries, withSecurityHeaders } from "@claxedo/server-core/platform/http/security-headers"
import { configureAgentConfig, defaultHarness, loadUserConfig } from "@claxedo/server-core/agent-config/index"
import {
  mountControlPlaneRouteContributions,
  type ControlPlaneRouteContribution,
} from "@claxedo/server-core/platform/http/route-contribution"
import { peerAddressStamp } from "@claxedo/server-core/platform/http/peer-address"
import { createConnectionsHost } from "../../connections"
import { createConnectionTurnCredentials } from "../../connections/turn-credentials"
import type { ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { mirrorProcessEvents } from "../../platform/runtime/lib/process-events"
import { DocumentsRoutes } from "../../documents/routes/index"
import { AgentConfigRoutes, sessionMetaProjectionTap } from "@claxedo/local-server/self-hosted-execution"
import { SessionMetaRoutes } from "@claxedo/local-server/self-hosted-execution"
import { LocalWorkspaceRoutes } from "@claxedo/local-server/self-hosted-execution"
import { LocalProjectRoutes } from "@claxedo/local-server/self-hosted-execution"
import { WorkspaceRoutes } from "../../workspace/routes/index"
import { OpenCodeCompatRoutes } from "@claxedo/local-server/self-hosted-execution"
import { resolveHarnessId } from "@claxedo/local-server/self-hosted-execution"
import { normalizeHarnessIdentity } from "@claxedo/agent-sdk-runtime"
import { toCompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import { createWorkspaceRuntimeProxy } from "@claxedo/local-server/self-hosted-execution"
import { createLocalWorkspaceRelayProxy } from "../../workspace/runtime-dispatch/shared-workspace-endpoint"
import { configureOpencodeMcpSync } from "@claxedo/local-server/self-hosted-execution"
import {
  configureOpenCodeApplicationTools,
  configureOpenCodeEmbedPath,
  configureOpenCodeWorkerPath,
  configureOpenCodeEngine,
  drainOpenCodeEngine,
  opencodeEngineMode,
  opencodeRequest,
} from "@claxedo/server-core/opencode/engine"
import { createOpencodeEvents, type OpencodeEvent, type OpencodeEventsHandle } from "@claxedo/local-server/self-hosted-execution"
import { claxedoBus, globalBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import {
  configureWorkspaceSupervisor,
  createWorkspaceSupervisorSandboxManager,
  shutdownWorkspaceSupervisor,
} from "../../workspace/supervisor"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "@claxedo/local-server/self-hosted-execution"
import { configureOpenCodeAuth, opencodeHeaders } from "@claxedo/server-core/opencode/auth"
import { getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "@claxedo/server-core/platform/runtime/profile"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { migrateCredentials, projectLocalSessionMetaFromEvent } from "@claxedo/local-server/self-hosted-execution"
import { CredentialRoutes } from "@claxedo/local-server/self-hosted-execution"
import { ProviderAuthRoutes } from "@claxedo/local-server/self-hosted-execution"
import { NetworkPolicyRoutes } from "@claxedo/local-server/self-hosted-execution"
import { ProjectRemoteRoutes } from "../../workspace/routes/project-remote"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  type ControlPlaneRelay,
  type ControlPlaneServices,
  type WorkspaceAuthority,
} from "../../authority/services"
import {
  betterAuthAdapter,
  controlPlaneAuthContext,
  ControlPlaneAuthError,
} from "@claxedo/server-core/platform/auth/auth"
import {
  deploymentMode,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"
import { assertSelfHostedPosture, type SelfHostedPosture } from "./posture"
import { EMBEDDED_AUTH_ISSUER, embeddedAuthEnabled, getEmbeddedAuth } from "./embedded-auth"
import { embeddedBrowserAuthDescriptor, embeddedBrowserAuthSecurity, embeddedBrowserSessionBearer } from "./embedded-browser-auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { ControlPlaneHttpRoutes } from "../../authority/http"
import { OrgTeamControlRoutes } from "../../session/routes/org-team-routes"
import { createCentralControlApp } from "../../central-runtime"
import { JwksRoutes } from "../../authority/routes/jwks"
import { createRouteOwnership, mountOwnedRoute, withRouteOwnership } from "../route-ownership"
import { InternalRelayResolverRoutes } from "../shared-routes/internal-relay"
import { localRelayTargetExists, localRelayTargetLookup } from "./internal-relay-node"
import { BootstrapRoutes } from "@claxedo/local-server/self-hosted-execution"
import { hostTunnelTokenSigner, runtimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createControlPlaneRelayProvider } from "@claxedo/server-core/adapters/relay/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { WorkspaceCheckpointRoutes } from "../../workspace/routes/checkpoints"
import {
  authorizeRuntimeSessionStream,
  RuntimeSessionAuthorityRoutes,
  sessionStreamLeaseVerifier,
  type RuntimeSessionAuthorityOptions,
  type SessionStreamLeaseClaims,
} from "../../routes/runtime-session-authority"
import { PrivateSessionRegistrationRoutes } from "../../routes/private-session-registration"
import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { relayRole } from "../../workspace/route-support"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import {
  ensureWorkspace,
  getWorkspaceByDirectory,
  listProjects,
  listWorkspaces,
  resolveWorkspace,
  subscribeLocalWorkspaceChanges,
} from "@claxedo/server-core/workspace/store/index"
import { defaultHomeRegion, relayEndpointsFromEnv } from "@claxedo/server-core/platform/runtime/region/index"
import { createControlPlaneChannels, mountControlPlaneChannels } from "../../channels/control-plane"
import { mountWorkspaceRuntimePtyWebSocketProxy } from "@claxedo/local-server/self-hosted-execution"
import {
  createClaxedoSessionEnvFactory,
  prepareWorkspaceRuntimeSession,
} from "../../hosts/workspace-runtime/session-env"
import { getLocalUsageLimits } from "@claxedo/local-server/self-hosted-execution"
import { centralModelBackend } from "../../session/runtime"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { withDataDirOwnership } from "@claxedo/server-core/platform/runtime/lib/data-dir-owner"
import { createLocalDocumentsBackend } from "../../documents/backends/local/backend"
import { setDocumentChangedSink } from "../../documents/backend"
import { LocalInstallationDocumentBroker } from "../../documents/backends/local/installation-broker"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { llmTurnRecord } from "../../platform/telemetry/product/metering"
import { ClaxedoDB } from "../../platform/db"
import { RemoteAccessRoutes } from "../../routes/remote-access"
import { createRemoteAccessService, unavailableRemoteAccessService } from "./remote-access-service"
import { localHostIdentity, signHostPayload } from "../../workspace/local-host"
import { hasUserHostedMachineTunnel, startUserHostedMachineTunnel, stopUserHostedMachineTunnel } from "../../user-hosted-tunnel"
import { DEFAULT_CLAXEDO_SERVER_PORT, embeddedWorkspaceRuntimeSessionAuthority } from "@claxedo/local-server/self-hosted-execution"
import { createSqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
import { createSqliteUsageSourceCoverageStore, type UsageSourceCoverageStore } from "@claxedo/server-core/usage/adapters/sqlite-usage-provenance"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import type { UsageLedger } from "../../platform/telemetry/product/metering"
import { createUsageOutboxSync, type UsageOutboxSync } from "@claxedo/local-server/self-hosted-execution"
import { LocalUsageRoutes } from "@claxedo/local-server/self-hosted-execution"
import { scanTokenTrackerLocalHistory } from "@claxedo/local-server/self-hosted-execution"
import { createUsageProvenanceClassifier, tokenTrackerSourceForHarness } from "@claxedo/server-core/usage/provenance"
import { resolveHarnessForRequest } from "@claxedo/server-core/session/harness/resolution"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import { recordRelayRuntimeToken } from "../../authority/relay-token-record"

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
export { projectLocalSessionMetaFromEvent } from "@claxedo/local-server/self-hosted-execution"

function authRouteOptions(services: ControlPlaneServices) {
  return {
    authConfig: services.auth.config,
    ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
  }
}

function selfHostedRuntimeAuthority(authority: WorkspaceAuthority | undefined): RuntimeSessionAuthorityOptions["authority"] {
  const candidate = authority as (WorkspaceAuthority & Record<string, unknown>) | undefined
  const methods = [
    "registerRuntimeSession",
    "markSessionRegistrationAmbiguous",
    "beginSessionCompensation",
    "completeSessionCompensation",
    "authorizeRuntimeSession",
    "runtimeAccessTokenActive",
  ] as const
  if (!candidate || methods.some((method) => typeof candidate[method] !== "function")) {
    throw new ControlPlaneCompositionError(
      "self_host_app_required",
      "Self-hosted runtime session authority is incomplete",
    )
  }
  return candidate as unknown as RuntimeSessionAuthorityOptions["authority"]
}

function selfHostedTurnAuthority(authority: WorkspaceAuthority | undefined): SessionTurnAuthority {
  const candidate = authority as (WorkspaceAuthority & Record<string, unknown>) | undefined
  const methods = ["acquireSessionTurn", "renewSessionTurn", "releaseSessionTurn"] as const
  if (!candidate || methods.some((method) => typeof candidate[method] !== "function")) {
    throw new ControlPlaneCompositionError(
      "self_host_app_required",
      "Self-hosted session turn authority is incomplete",
    )
  }
  return candidate as unknown as SessionTurnAuthority
}

function selfHostedPrivateSessionAuthority(
  authority: WorkspaceAuthority | undefined,
): Pick<PrivateSessionAuthority, "reserveSession"> {
  const candidate = authority as (WorkspaceAuthority & Record<string, unknown>) | undefined
  if (!candidate || typeof candidate.reserveSession !== "function") {
    throw new ControlPlaneCompositionError(
      "self_host_app_required",
      "Self-hosted private-session reservation authority is incomplete",
    )
  }
  return candidate as unknown as Pick<PrivateSessionAuthority, "reserveSession">
}

/**
 * The private-session authority for the embedded workspace runtime.
 *
 * The runtime shares this process with the control plane, so it calls the
 * authority directly instead of crossing `POST /api/runtime-authority/
 * session-authorize`. Streams reach the same owner the HTTP oracle serves
 * (`authorizeRuntimeSessionStream`) and receive the same signed lease, bound
 * to the `embedded` transport: an in-process runtime holds no Relay Host
 * Token chain, so a renewal re-checks private-session membership rather than
 * a parent Runtime Access Token.
 *
 * Turn admission is the same story one layer down. Declaring
 * `sessionAuthority: "managed-private"` is what turns on the runtime's durable
 * prompt admission (`acquireManagedPromptLease`, workspace-runtime
 * routes/session-core.ts), so `ManagedSessionAuthority` (workspace-runtime
 * session-access-policy.ts) requires `acquireTurn`/`renewTurn`/`releaseTurn`
 * alongside read/write/stream/register: this authority bundle cannot be built
 * without them, so a managed-private policy can never authorize a turn and
 * then refuse to admit it. The callbacks below reach `selfHostedTurnAuthority`,
 * the same owner `RuntimeSessionAuthorityRoutes` serves remotely; the
 * authority's own `leaseId` travels back unwrapped because an in-process
 * caller needs no cross-process proof to bind it to (the remote oracle mints
 * a signed lease for exactly that reason).
 */
export function embeddedManagedPrivateSessionPolicy(authority: WorkspaceAuthority) {
  const runtimeAuthority = selfHostedRuntimeAuthority(authority)
  const turnAuthority = selfHostedTurnAuthority(authority)
  const principalOf = (input: SessionAuthorityInput) => input.actor.actorKind === "human"
    ? { principalKind: "user" as const, actorId: input.actor.actorId, actorKind: "human" as const }
    : { principalKind: "service" as const, actorId: input.actor.actorId, actorKind: "agent" as const }
  const denied = (error: unknown) => {
    if (error instanceof ControlPlaneAuthError && (error.status === 401 || error.status === 403 || error.status === 503)) {
      return { allowed: false as const, status: error.status, code: error.code, message: error.message }
    }
    return {
      allowed: false as const,
      status: 503 as const,
      code: "session_authority_unavailable",
      message: error instanceof Error ? error.message : "Session authority is unavailable",
    }
  }
  const decideStream = async (
    input: SessionAuthorityInput,
    lease?: string,
  ): Promise<SessionAccessStreamDecision> => {
    const action = sessionAccessRequiresWrite(input) ? "write" as const : "read" as const
    try {
      const claims: SessionStreamLeaseClaims = lease
        ? await sessionStreamLeaseVerifier()(lease)
        : {
            ...principalOf(input),
            transport: "embedded",
            orgId: input.authority.orgId,
            workspaceId: input.authority.workspaceId,
            sessionId: input.sessionId,
            action,
          }
      if (lease && (claims.sessionId !== input.sessionId || claims.action !== action)) {
        return {
          allowed: false,
          status: 401,
          code: "session_stream_lease_invalid",
          message: "Session stream lease is invalid or mismatched",
        }
      }
      return await authorizeRuntimeSessionStream({ authority: runtimeAuthority }, claims)
    } catch (error) {
      return denied(error)
    }
  }
  const decide = async (input: SessionAuthorityInput, action: "read" | "write" | "register") => {
    const principal = principalOf(input)
    try {
      if (action === "register") {
        if (!input.registrationOperationId) {
          return {
            allowed: false as const,
            status: 409 as const,
            code: "session_registration_operation_required",
            message: "Private session registration requires an immutable operation id",
          }
        }
        await runtimeAuthority.registerRuntimeSession({
          ...principal,
          operationId: input.registrationOperationId,
          workspaceId: input.authority.workspaceId,
          sessionId: input.sessionId,
          ...(input.sessionTitle ? { title: input.sessionTitle } : {}),
        })
      } else {
        await runtimeAuthority.authorizeRuntimeSession({
          ...principal,
          workspaceId: input.authority.workspaceId,
          sessionId: input.sessionId,
          action,
        })
      }
      return { allowed: true as const }
    } catch (error) {
      return denied(error)
    }
  }
  const turnDenied = (error: unknown) => {
    if (error instanceof SessionTurnConflictError) {
      return { allowed: false as const, status: 409 as const, code: error.code, message: error.message }
    }
    if (error instanceof SessionTurnLeaseLostError) {
      return { allowed: false as const, status: 409 as const, code: error.code, message: error.message }
    }
    return denied(error)
  }
  // A turn is admitted for a verified identity on a named workspace, exactly
  // like a stream: `managedWorkspaceSessionAccessPolicy` already refused the
  // call before reaching here if the actor or authority claims are absent.
  const turnInput = (input: SessionAuthorityInput & { turnId: string }) => ({
    ...principalOf(input),
    sessionId: input.sessionId,
    workspaceId: input.authority.workspaceId,
    turnId: input.turnId,
  })
  const policy = managedWorkspaceSessionAccessPolicy({
    authority: {
      authorizeSessionRead: (input) => decide(input, "read"),
      authorizeSessionWrite: (input) => decide(input, "write"),
      authorizeSessionStream: decideStream,
      registerSession: (input) => decide(input, "register"),
      acquireTurn: async (input) => {
        try {
          return { allowed: true as const, ...await turnAuthority.acquireSessionTurn(turnInput(input)) }
        } catch (error) {
          return turnDenied(error)
        }
      },
      renewTurn: async (input) => {
        try {
          return {
            allowed: true as const,
            ...await turnAuthority.renewSessionTurn({
              ...turnInput(input),
              leaseId: input.leaseId,
              fencingToken: input.fencingToken,
            }),
          }
        } catch (error) {
          return turnDenied(error)
        }
      },
      releaseTurn: async (input) => {
        try {
          return await turnAuthority.releaseSessionTurn({
            ...turnInput(input),
            leaseId: input.leaseId,
            fencingToken: input.fencingToken,
          })
        } catch (error) {
          return turnDenied(error)
        }
      },
    },
  })
  return policy
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

function workspaceRouteOptions(
  services: ControlPlaneServices,
  connections?: Pick<ReturnType<typeof createConnectionsHost>, "repositoryForAuth">,
  connectionRateLimiter?: ConnectionRateLimiter,
) {
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
    ...(connectionRateLimiter ? { connectionRateLimiter } : {}),
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
 * The SPA boots and renders (project list, not a white screen), the module
 * entry + auth vendor bundle + CSS load, the inline <style> and the inline
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
 * (auth provider origin, Turnstile at challenges.cloudflare.com) — the box
 * ran unsigned-local, so no auth flow ran; a real workspace session and the terminal's wss to a
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
  // Hosted-browser previews use an empty iframe sandbox, so HTTPS documents
  // receive no scripts, forms, popups, or same-origin privileges.
  "frame-src https:",
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
    const spaResponse = spaBundleRequests.has(c.req.raw)
    const entries = spaResponse
      ? selfHostDocumentSecurityHeaderEntries({ https })
      : [
          ...securityHeaderEntries({ https }),
          ...(c.res.headers.get("cache-control")?.includes("public")
            ? []
            : [["cache-control", "no-store"]] as const),
        ]
    const stamped = withSecurityHeaders(c.res, entries)
    // Only needed when the immutable-headers fallback rebuilt the response
    // (proxied `fetch()` results carry an immutable header guard).
    if (stamped !== c.res) c.res = stamped
  }
}

export function createSelfHostedApp(
  services: ControlPlaneServices,
  options: {
    onOpencodeAccess?: () => void
    beforeLocalSessionList?: () => Promise<void>
    /**
     * The deployment posture to validate before composing.
     *
     * PASSED IN rather than read from the environment, which is what lets this
     * be a real gate. The process entry supplies what it observed
     * (`selfHostedPosture(process.env)`); a test supplies what it is exercising.
     * Reading `process.env` here would instead mean every test either sets six
     * variables or the gate gets weakened until it accepts an empty
     * environment — and a gate weakened to pass its own tests is not a gate.
     *
     * Absent means "the caller is not booting a deployment": the `localExecution`
     * check below still runs, because that one is about this function's own
     * contract rather than about a deployment's configuration.
     */
    posture?: SelfHostedPosture
    usageRevisionStore?: ReturnType<typeof createSqliteUsageLedger>
    usageSourceCoverage?: UsageSourceCoverageStore
    usageSourceCoverageReady?: Promise<void>
    usageLedger?: UsageLedger
    usageOutbox?: UsageOutboxSync
    resolveUsageHostIdentity?: () => Promise<{ hostId: string }>
    /** Composition seam for tests/load fixtures; production keeps the default limiter. */
    connectionRateLimiter?: ConnectionRateLimiter
    /** Explicit build/composition contributions; absent in the disabled product. */
    routeContributions?: readonly ControlPlaneRouteContribution[]
  } = {},
) {
  if (options.posture) assertSelfHostedPosture(options.posture)
  if (!services.localExecution.enabled) {
    throw new ControlPlaneCompositionError(
      "self_host_app_required",
      "createSelfHostedApp is the self-host composition; use createHostedApp for hosted services",
    )
  }
  const localDocumentBrokerToken = process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN?.trim()
  delete process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN
  // Every `app.route()` below is recorded against this composition, the same
  // way `createSignedControlPlaneApp` records its own. What that buys HERE is
  // narrower than it looks and worth stating plainly: one owner cannot collide
  // with itself (`/api/workspace` is deliberately mounted twice), so this does
  // not catch a duplicate inside this function. It catches the arrangement
  // Unit 7 creates — a second composition mounting onto this app — which is
  // silent in Hono and decided by call order. `mountControlPlaneChannels` and
  // the other `mount*` helpers below run against this same wrapped app, so
  // their claims land under this owner too.
  const routeOwnership = createRouteOwnership()
  const app = withRouteOwnership(new Hono(), routeOwnership, "self-hosted-node")
  // Outermost ON PURPOSE, ahead of CORS, the unsigned-local gate and every
  // route — so the preflight CORS short-circuits, the 404 handler and anything
  // `onError` produces are all covered. Which of the two policies a response
  // gets is decided from the SPA-bundle mark set further down; see the block
  // above `createSelfHostedApp` for why this server needs two.
  app.use(localSecurityHeaders())
  // Record the transport peer address for every request (including
  // @hono/node-ws upgrades, whose Requests lack the node-server internals)
  // so loopback gates verify the socket, not the spoofable Host header.
  app.use(peerAddressStamp())
  // top-level error handler. Hono's
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
    subject: "control-plane",
    principalKind: "service" as const,
    actorId: "control-plane",
    actorKind: "agent" as const,
    role: "owner" as const,
    ...(services.auth.config.enabled ? { requireRelayActor: true } : {}),
    ...(services.authority
      ? {
          resolveRelayActor: async (request: Request, workspaceId: string) => {
            // Loopback browser traffic may carry a control-plane JWT. Relay-
            // forwarded user-hosted traffic carries a Runtime Access Token
            // (audience `workspace-relay`). Treat RAT as a first-class actor
            // proof — verifying it as a CP bearer throws `invalid_bearer_token`
            // and used to 503 every `/workspaces/:id/*` session route.
            try {
              const auth = await controlPlaneAuthContext(request, {
                config: services.auth.config,
                ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
              })
              if (auth.mode === "signed") {
                const [actor, workspace] = await Promise.all([
                  resolveRuntimeActor(services.authority!, auth),
                  services.authority!.openWorkspace(auth, { workspaceId }),
                ])
                const orgId = workspace.workspace?.org_id
                if (typeof orgId !== "string") throw new Error("Workspace organization is unavailable")
                return {
                  ...actor,
                  orgId,
                  role: relayRole(workspace.role),
                }
              }
            } catch (error) {
              if (!(error instanceof ControlPlaneAuthError)) throw error
            }

            const header = request.headers.get("authorization") ?? ""
            const match = /^Bearer\s+(\S+)/i.exec(header.trim())
            if (!match?.[1]) return
            const token = match[1]

            // Relay-forwarded user-hosted hops carry a Relay Host Token
            // (audience `workspace-host-service`). Direct loopback clients may
            // still present a Runtime Access Token (`workspace-relay`).
            const relayHostJwk = process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK?.trim()
            if (relayHostJwk) {
              try {
                const claims = await verifyRelayHostToken(
                  token,
                  await importJWK(JSON.parse(relayHostJwk), "EdDSA"),
                  { workspaceId },
                )
                if (claims.actor_id && claims.actor_kind && claims.actor_public_id && claims.actor_name) {
                  return {
                    actorId: claims.actor_id,
                    actorKind: claims.actor_kind,
                    actorPublicId: claims.actor_public_id,
                    actorName: claims.actor_name,
                    ...(claims.actor_avatar_url ? { actorAvatarUrl: claims.actor_avatar_url } : {}),
                    orgId: claims.org_id,
                    role: claims.role,
                  }
                }
              } catch {
                // Fall through to Runtime Access Token verification.
              }
            }

            const publicPem = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n")
            if (!publicPem?.trim()) return
            try {
              const claims = await verifyRuntimeAccessToken(
                token,
                await importSPKI(publicPem, "EdDSA"),
                { workspaceId },
              )
              if (!claims.actor_id || !claims.actor_kind || !claims.actor_public_id || !claims.actor_name) return
              return {
                actorId: claims.actor_id,
                actorKind: claims.actor_kind,
                actorPublicId: claims.actor_public_id,
                actorName: claims.actor_name,
                ...(claims.actor_avatar_url ? { actorAvatarUrl: claims.actor_avatar_url } : {}),
                orgId: claims.org_id,
                role: claims.role,
              }
            } catch {
              return
            }
          },
        }
      : {}),
  }
  const turnCredentials = createConnectionTurnCredentials()
  const usageOutbox = options.usageOutbox ?? (options.usageRevisionStore
      ? createUsageOutboxSync({
          local: options.usageRevisionStore,
          ...(options.usageLedger ? { central: options.usageLedger } : {}),
          telemetry: services.telemetry,
        })
    : undefined)
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
    ...(options.usageRevisionStore ? { usageRevisionStore: options.usageRevisionStore } : {}),
    ...(options.usageLedger ? { usageLedger: options.usageLedger } : {}),
    ...(options.resolveUsageHostIdentity ? { resolveUsageHostIdentity: options.resolveUsageHostIdentity } : {}),
    ...(usageOutbox ? { onUsageTerminal: () => { void usageOutbox.notify() } } : {}),
    mountPublicUsageRoute: !options.usageRevisionStore,
    ...(options.beforeLocalSessionList ? { beforeLocalSessionList: options.beforeLocalSessionList } : {}),
    sessionShareChangedSink: (event) => claxedoBus.publish(event),
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

  // The ONE global unsigned-local gate. In unsigned self-host mode this
  // is the PRIMARY gate — non-loopback requests are denied by default with an
  // explicit allowlist of machine-token/callback exceptions (see
  // authority/deployment-mode.ts). The per-route loopback checks further
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
    // Embedded Better Auth issuer (self-host signed mode, no hosted identity provider).
    // Better-auth's default basePath is exactly /api/auth; the same instance
    // backs the control-plane bearer verifier (see
    // createDefaultLocalControlPlaneServices), so tokens minted here are the
    // ones the signed control-plane routes accept.
    const embedded = getEmbeddedAuth()
    app.all("/api/auth/*", (c) => embedded.handler(c.req.raw))
    // The browser half (embedded-browser-auth.ts): the descriptor the signed
    // web app validates first, the guard cookie-authenticated mutations must
    // pass, and the bridge that lets a session cookie reach the bearer
    // verifier every signed route already uses. Present only behind an HTTPS
    // public origin, which is what makes the session cookie `Secure`. Mounted
    // on every route, not only `/api/*`: the signed web app reaches the
    // engine-compat surface (`/find`, `/file`, `/path`, `/session`) with the
    // same cookie, and in signed mode those routes verify a bearer too.
    const browserDescriptor = embeddedBrowserAuthDescriptor()
    if (browserDescriptor) {
      app.use("*", embeddedBrowserAuthSecurity(browserDescriptor))
      app.use("*", embeddedBrowserSessionBearer(browserDescriptor))
      app.get("/api/claxedo/auth/descriptor", (c) => c.json(embeddedBrowserAuthDescriptor()))
    }
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
            // Normalize first so query aliases and access-qualified ACP keys
            // …) resolve the same way the compat routes resolve them; an
            // absent or unrecognised name falls back to the configured default.
            await resolveHarnessId(harness ? normalizeHarnessIdentity(harness)?.id : undefined) === "opencode",
        }
      : {}),
  }))
  const remoteAccessRelayUrl = services.relay.relayUrl ?? Object.values(services.relay.relayUrls ?? {})[0]
  const remoteAccessSigner = services.relay.hostTunnelTokenSigner
  // One machine-share owner for the whole composition: the remote-access
  // routes drive enable/devices/revoke through it, and the workspace routes'
  // `/:id/host-assignment` verbs delegate their assign→beat→routable sequence
  // to the same served set and heartbeat loop.
  const remoteAccessService = services.authority ? createRemoteAccessService({
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
    // This host serves the workspaces it shares out of the embedded runtimes
    // configured above, so the composition it declares to the control plane is
    // read from those runtimes rather than restated here — signed deployments
    // inject `embeddedManagedPrivateSessionPolicy` and are `managed-private`,
    // unsigned ones stay on the unbound local policy.
    sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority,
    startMachineTunnel: startUserHostedMachineTunnel,
    stopMachineTunnel: stopUserHostedMachineTunnel,
    machineTunnelActive: hasUserHostedMachineTunnel,
    capture: (distinctId, event, properties) => services.telemetry.capture(distinctId, event, properties),
  }) : undefined
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
    service: remoteAccessService ?? unavailableRemoteAccessService(),
  }))

  mountWorkspaceRuntimePtyWebSocketProxy(app, upgradeWebSocket, runtimeProxyOptions)

  app.all("/workspaces/:workspaceId", localWorkspaceRelayProxy)
  app.all("/workspaces/:workspaceId/*", localWorkspaceRelayProxy)

  // Record local session metadata into the control-plane store as sessions are
  // created / updated / deleted, so the control plane is the source of truth
  // for the local session list. Registered before `workspaceRuntimeProxy`
  // because the proxy answers `/session` itself — a tap after it never sees the
  // call. Shared with the desktop-local composition rather than duplicated.
  app.use(sessionMetaProjectionTap(services.projectionStore))

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
    //
    // Claxedo events SSE lives on `OpenCodeCompatRoutes` above, not here: that
    // router answers `/global/event`, `/api/wr/events`, and `/api/claxedo/events`
    // itself (its own three spellings of the central bus stream, gated by the
    // same control-plane bearer via `controlPlaneRouteAuth`), so a second
    // `/api/claxedo/events` mounted after it here would never be reached —
    // Hono resolves the first-registered handler for an exact path.
    // `createSelfHostedApp` requires `services.localExecution.enabled`
    // (asserted above) before this point is ever reached, so this composition
    // never runs without that router mounted.
  }

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
    }),
  )
  app.route("/", SessionMetaRoutes({ services, ...authRouteOptions(services) }))
  app.route("/api/claxedo/workspace", LocalWorkspaceRoutes(authRouteOptions(services)))
  // Projects on this server's filesystem: a folder here, or a repository cloned
  // under the data directory. The same routes the desktop's server mounts.
  app.route("/api/claxedo/projects", LocalProjectRoutes(authRouteOptions(services)))
  app.route("/api/workspace", WorkspaceRoutes(
    services,
    {
      ...workspaceRouteOptions(services, connectionsHost, options.connectionRateLimiter),
      ...(remoteAccessService ? { hostAssignments: remoteAccessService } : {}),
    },
  ))
  app.route("/api/workspace", WorkspaceCheckpointRoutes(services, {
    loopbackRelayUrl: services.relay.relayUrl,
    defaultHomeRegion: services.defaultHomeRegion,
    allowUnsignedLocal: true,
  }))
  app.route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
    authority: selfHostedRuntimeAuthority(services.authority),
    turnAuthority: selfHostedTurnAuthority(services.authority),
  }))
  app.route("/api/control", ControlPlaneHttpRoutes(services, authRouteOptions(services)))
  app.route("/api/control", OrgTeamControlRoutes(services, authRouteOptions(services)))
  app.route("/api/control/session-registrations", PrivateSessionRegistrationRoutes({
    authority: selfHostedPrivateSessionAuthority(services.authority),
    ...authRouteOptions(services),
    services,
  }))
  app.route("/", centralControl.app)
  app.route(
    "/api/claxedo/credentials",
    CredentialRoutes(services.credentials, {
      // Public/deployed boxes MUST set CLAXEDO_CREDENTIALS_TOKEN (see
      // CredentialRoutesOptions.token). Local loopback dev may leave it unset.
      ...(process.env.CLAXEDO_CREDENTIALS_TOKEN?.trim() ? { token: process.env.CLAXEDO_CREDENTIALS_TOKEN.trim() } : {}),
      ...(embeddedAuthEnabled(process.env) ? {
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
  if (options.usageRevisionStore) {
    app.route("/api/claxedo/usage", LocalUsageRoutes({
      local: options.usageRevisionStore,
      ...(options.usageLedger ? { central: options.usageLedger } : {}),
      outbox: usageOutbox!,
      identity: async (request) => {
        const auth = await controlPlaneAuthContext(request, authRouteOptions(services))
        return auth.mode === "signed" && auth.user.orgId
          ? { org_id: auth.user.orgId, user_id: auth.user.subject }
          : undefined
      },
      quota: async (refresh) => await getLocalUsageLimits({ refresh }),
      history: async ({ since, until, refresh }) => {
        const facts = await options.usageRevisionStore!.current()
        const incompleteSources = new Set<string>()
        const entries = facts.flatMap((fact) => {
          const source = tokenTrackerSourceForHarness(fact.harness)
          const nativeSessionId = fact.nativeSessionId ?? (source === "opencode" || source === "pi" ? fact.sessionId : undefined)
          if (source && !nativeSessionId) incompleteSources.add(source)
          return source && nativeSessionId ? [{
            source,
            nativeSessionId,
            sessionRef: fact.sessionRef,
            harness: fact.harness,
            ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}),
            startedAt: 0,
          }] : []
        })
        const completeSources = ["claude", "codex", "cursor", "opencode", "pi"]
          .filter((source) => !incompleteSources.has(source))
        const classificationKey = createHash("sha256").update(JSON.stringify({
          entries: entries.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          completeSources,
        })).digest("hex")
        return await scanTokenTrackerLocalHistory({
          sourceHome: os.homedir(),
          stateDir: path.join(dataDir(), "usage-scanner"),
          since,
          until,
          // The embedded engine's sqlite (OPENCODE_DB, engine.ts) lives under
          // the data dir, not $HOME — without this, its turns never reach the
          // Total-local view on a machine with no standalone opencode CLI.
          opencodeRoots: [path.join(dataDir(), "opencode-engine")],
          classificationKey,
          refresh,
          classify: createUsageProvenanceClassifier(entries, { completeSources }),
        })
      },
      telemetry: services.telemetry,
    }))
  }
  mountControlPlaneChannels(app, {
    services,
    runtime: centralControl.runtime,
    includeFake: true,
    channels: controlPlaneChannels,
  })

  mountControlPlaneRouteContributions({
    contributions: options.routeContributions ?? [],
    mount: (contribution) => mountOwnedRoute(
      app,
      routeOwnership,
      `feature:${contribution.id}`,
      contribution.path,
      contribution.routes as never,
    ),
  })

  // Web UI parity: serve a built claxedo-app bundle from the box when
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
    /**
     * This composition's route ledger — every prefix it claimed, and under
     * which owner. Exposed for the same reason `createRouteOwnership` records
     * mounts at all: a contract test compares it against a declared table, and
     * a later composition that mounts onto `app` can claim through it instead
     * of shadowing a prefix silently.
     */
    routeOwnership,
    /** @claxedo/connections service — the one connections layer. Thread this
     * into consumers that need capability-handle token resolution. */
    connections: connectionsHost.service,
  }
}

export type ControlPlaneStackOptions = {
  services: ControlPlaneServices
  port?: number
  opencodeUrl?: string
  opencodePassword?: string | null
  opencodeEmbedPath?: string
  opencodeWorkerPath?: string
  processObserver?: ProcessObserver
  /** Explicit build/composition contributions (Agent Plugins); absent in the disabled product. */
  routeContributions?: readonly ControlPlaneRouteContribution[]
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
  const trust = deploymentMode(process.env)
  const embeddedAuth = embeddedAuthEnabled(process.env)
  if (trust === "hosted") {
    // Hosted mode moved to the Better Auth + D1 worker; the Node self-host
    // entrypoint no longer boots a hosted composition. Fail closed with a
    // human-actionable error instead of silently running local-only.
    throw new ControlPlaneCompositionError(
      "hosted_composition_removed",
      "CLAXEDO_DEPLOYMENT_MODE=hosted is not supported by the self-hosted Node entrypoint; deploy the Better Auth + D1 worker instead",
    )
  }
  const sandboxManager = createWorkspaceSupervisorSandboxManager()
  const centralStore = createSqliteCentralStore({ mode: getSessionWriteMode })
  // The health endpoint means the central projection is ready to serve. Open
  // SQLite here so the renderer's first session-list request does not pay for
  // migrations, repair checks, WAL checkpointing, and statement preparation.
  ClaxedoDB.raw()
  const authority = createSqliteWorkspaceAuthority()
  const services = createControlPlaneServices(
    {
      projectionStore: centralStore.projectionStore,
      durableSessionLog: centralStore.durableSessionLog,
    },
    {
      // Embedded Better Auth issuer (CLAXEDO_EMBEDDED_AUTH=1) => signed mode
      // backed by the in-process better-auth instance; otherwise local-only.
      ...(embeddedAuth
        ? { auth: betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: getEmbeddedAuth().verifier }) }
        : {}),
      // Self-host always uses SQLite.
      authority,
      relay: localRelayFromEnv(sandboxManager, authority),
      sandbox: {
        sandboxManager,
      },
      telemetry: { capture },
      defaultHomeRegion: defaultHomeRegion(process.env),
    },
  )
  let closed = false
  return Object.assign(services, {
    close() {
      if (closed) return
      closed = true
      if ("close" in authority && typeof authority.close === "function") authority.close()
      ClaxedoDB.close()
    },
  })
}

function localRelayFromEnv(
  sandboxManager = createWorkspaceSupervisorSandboxManager(),
  authority: WorkspaceAuthority = createSqliteWorkspaceAuthority(),
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
            recordRuntimeAccessToken: (input) => recordRelayRuntimeToken(authority, input),
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
  const port = options.port ?? DEFAULT_CLAXEDO_SERVER_PORT
  // No external opencodeUrl configured => use the embedded engine (in-process
  // for generic hosts, on-demand worker when desktop supplies one). An explicit
  // opencodeUrl is the external-URL opt-in. NOTHING listens on :4096.
  const opencodeCompat = process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT !== "1"
  const services = options.services
  const usageRevisionStore = createSqliteUsageLedger()
  const usageSourceCoverage = createSqliteUsageSourceCoverageStore()
  const usageCoverageReady = usageSourceCoverage.ensure(["claude", "codex", "cursor", "opencode", "pi"])
  const usageLedger: UsageLedger | undefined = undefined
  const usageOutbox = createUsageOutboxSync({
    local: usageRevisionStore,
    ...(usageLedger ? { central: usageLedger } : {}),
    telemetry: services.telemetry,
  })
  const localUsageHost = localHostIdentity()
  const localTurnMeter = createTurnMeter({
    writer: usageRevisionStore,
    reader: usageRevisionStore,
    currentFilter: (fact) => fact.location === "local" || fact.location === "user-hosted",
    reconcileProvisionalOnStart: true,
    resolveContext: async ({ sessionId }) => {
      const [meta, host] = await Promise.all([
        sessionMeta(sessionId),
        localUsageHost,
      ])
      if (!meta?.sessionRef || !meta.workspaceID) {
        throw new Error(`usage metering requires canonical workspace session metadata for ${sessionId}`)
      }
      const harness = await resolveHarnessForRequest({ sessionId, workspaceId: meta.workspaceID })
      return {
        sessionRef: meta.sessionRef,
        workspaceId: meta.workspaceID,
        hostId: host.hostId,
        location: "local",
        harness: meteringHarnessId(harness),
        ...(meta.model?.providerID ? { providerId: meta.model.providerID } : {}),
        ...(meta.model?.modelID ? { modelId: meta.model.modelID } : {}),
      }
    },
    onTerminal: async () => { await usageOutbox.notify() },
    onDegraded: (error) => reportError(error, { tags: { source: "local_usage_metering" } }),
  })
  void localTurnMeter.start()
  configureOpenCodeAuth(options.opencodePassword)
  configureOpenCodeEmbedPath(options.opencodeEmbedPath)
  configureOpenCodeWorkerPath(options.opencodeWorkerPath)
  if (options.opencodeUrl) {
    configureOpenCodeEngine({ url: options.opencodeUrl, headers: opencodeHeaders() })
  } else {
    configureOpenCodeEngine({ embedded: true })
    // Stored AI credentials live in Claxedo's registry; the engine resolves
    // auth from its own store. Arm the bridge's boot hook so every embedded
    // engine boot reconciles the registry into the engine — an already-stored
    // key powers the first embedded turn — WITHOUT booting the engine at
    // server start just to deliver auth (see opencode/engine-auth-bridge.ts).
    // Mutations after this keep the two in step through the same gate.
    void import("@claxedo/server-core/opencode/engine-auth-bridge")
      .then((bridge) => bridge.armEngineAuthSyncOnBoot())
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
    ...(services.auth.config.enabled && services.authority
      ? { sessionAccessPolicy: embeddedManagedPrivateSessionPolicy(services.authority) }
      : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    // See `projectLocalSessionMetaFromEvent` above: a harness session's
    // async auto-title (opencode's own LLM rename, or an ACP harness's
    // post-turn `maybeEmitTitle`) is published only over that workspace's
    // own `/global/event` SSE stream, never an HTTP `PATCH /session/:id` the
    // response-sniffing tap below would observe. Without this, titles revert
    // to "Untitled" after a restart.
    onSessionMetaEvent: (event) => {
      if (event.payload.type === "session.created" || event.payload.type === "session.updated") {
        void projectLocalSessionMetaFromEvent(services.projectionStore, event)
      }
      const compat = toCompatEvent({ type: event.payload.type, properties: event.payload.properties })
      if (compat) void localTurnMeter.consume({ directory: event.directory ?? "", payload: compat })
    },
    onTurnOutcome: ({ sessionId, assistantMessageId, outcome }) => {
      if (outcome.status !== "cancelled" || !assistantMessageId) return
      void localTurnMeter.settle({
        sessionId,
        messageId: assistantMessageId,
        status: outcome.reason === "steer" ? "interrupted_by_steer" : "stopped",
      })
    },
    onSessionMetaSnapshot: async (workspace, sessions) => {
      await services.projectionStore.sync_session_metas(workspace, sessions)
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
  // No options left to supply: agent-config's only option is the per-harness
  // launch projection, which this deployment does not contribute. Its former
  // `acpDir` and `workspaceAuthority` inputs went with the ACP binary lookup
  // and the retired agent-extensions hydration respectively.
  configureAgentConfig()
  configureWorkspaceSupervisor({
    server_url: `http://127.0.0.1:${port}`,
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
      void projectLocalSessionMetaFromEvent(services.projectionStore, event)
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
  const built = createSelfHostedApp(services, {
    usageRevisionStore,
    usageSourceCoverage,
    usageSourceCoverageReady: usageCoverageReady,
    usageOutbox,
    ...(usageLedger ? { usageLedger } : {}),
    resolveUsageHostIdentity: localHostIdentity,
    ...(options.routeContributions ? { routeContributions: options.routeContributions } : {}),
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
    services.close?.()
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
  port = DEFAULT_CLAXEDO_SERVER_PORT,
  opencodeUrl?: string,
  opencodePassword?: string | null,
  options: {
    processObserver?: ProcessObserver
    opencodeEmbedPath?: string
    opencodeWorkerPath?: string
    routeContributions?: readonly ControlPlaneRouteContribution[]
  } = {},
) {
  // `undefined` opencodeUrl => embedded engine (the default local composition).
  // An explicit URL is the external-URL opt-in.
  return startControlPlaneStack({
    services: createDefaultLocalControlPlaneServices(),
    port,
    ...(opencodeUrl ? { opencodeUrl } : {}),
    opencodePassword,
    ...(options.opencodeEmbedPath ? { opencodeEmbedPath: options.opencodeEmbedPath } : {}),
    ...(options.opencodeWorkerPath ? { opencodeWorkerPath: options.opencodeWorkerPath } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    ...(options.routeContributions ? { routeContributions: options.routeContributions } : {}),
  })
}
