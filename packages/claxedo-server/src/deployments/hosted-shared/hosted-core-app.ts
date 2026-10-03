import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { allowedOriginPatterns } from "@claxedo/server-core/platform/http/cors-origins"
import { securityHeaders } from "@claxedo/server-core/platform/http/security-headers"
import { browserAuthHttpSecurity } from "@claxedo/server-core/platform/http/browser-auth-security"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"

import { JwksRoutes } from "../../authority/routes/jwks"
import { OAuthProtectedResourceRoutes } from "../../mcp/oauth-protected-resource"
import { HostedShellRoutes, hostedHarnessRuntimeStatus } from "../../routes/hosted/shell"
import { HostedAuthProfileRoutes } from "../../routes/hosted/auth-profile"
import { HostedDeviceAuthRoutes } from "../../routes/hosted/device-auth"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "../../routes/hosted/workspace"
import { HostEnrollmentRoutes, HostInvitationRoutes } from "../../routes/hosted/host-enrollment"
import { HostSessionRowsRoutes } from "../../routes/hosted/host-session-rows"
import { RemoteAccessOwnerRoutes } from "../../routes/remote-access"
import { hostedRemoteAccessService } from "./hosted-remote-access-service"
import { WorkspaceCheckpointRoutes } from "../../workspace/routes/checkpoints"
import { hostConnectEndpointOptions, routeAuth, signedOrError } from "../../workspace/route-support"
import { HostedControlRoutes } from "../../routes/hosted/control"
import { InternalRelayResolverRoutes, type RelayTargetLookup } from "../shared-routes/internal-relay"
import { HostedSandboxAdminRoutes } from "../../routes/hosted/sandbox-admin"
import { RuntimeSessionAuthorityRoutes } from "../../routes/runtime-session-authority"
import type { SandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import { createOwnerGrantProof } from "../../session/owner-grant"
import { PrivateSessionRegistrationRoutes } from "../../routes/private-session-registration"
import { OrgTeamControlRoutes } from "../../session/routes/org-team-routes"
import { SessionPeopleControlRoutes } from "../../session/routes/session-people-routes"
import { createRouteOwnership, mountOwnedRoute, withRouteOwnership } from "../route-ownership"
import { deploymentCompatibilityReport } from "../../platform/governance/deployment-compatibility"
import {
  createFixedWindowConnectionRateLimiter,
  createLayeredRateLimiter,
  type SharedRateLimitStore,
} from "../../platform/auth/rate-limit"
import {
  defaultRequestGuard,
  hostedRouteGuardExemptions,
  type RouteGuardExemption,
} from "../../platform/auth/request-guard"
import { parseSessionListQuery, sessionInventoryResponse, signedSessionList, sessionListErrorResponse } from "../../session/list"
import { createSessionReadRoutes, authoritySessionReads } from "../../session/routes/session-read"
import { createSessionReaderRoutes } from "../../session/routes/session-reader"
import { isComposedAuthorityPort } from "../../authority/composed-authority"
import type { SessionReaderAuthority } from "@claxedo/server-core/platform/auth/session-reader-authority"
import type { HostedControlPlane } from "../../authority/hosted-services"
import type { IdempotencyCoordinator } from "../../authority/http/idempotency"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { hostedPiCredentials } from "../../credentials/worker/pi"
import { hostedAgentConfigRoutes } from "../../agent-config/hosted-routes"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import {
  liveSyncRoomNameForPrincipal,
  nudgeLiveSyncRoom,
  type LiveSyncRoomNamespace,
} from "../../platform/http/live-sync-publish"
import type { StaticProductDescriptor } from "./deployment-profile"
import {
  mountControlPlaneRouteContributions,
  type ControlPlaneRouteContribution,
} from "@claxedo/server-core/platform/http/route-contribution"
import type { FirstPartyMcpOptions } from "@claxedo/mcp"
import { firstPartyMcpContribution } from "../../mcp/first-party-mcp"
import { readIntrospectedAccessToken, resolveOAuthMcpCredential } from "../../mcp/oauth-credential"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { privateRepoHosts } from "../private-repo-hosts"
import { hostedSandboxEgress } from "./hosted-sandbox-egress"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import type { UsageReportWriter } from "@claxedo/server-core/usage/usage-report"

export type HostedCoreProductWorkspaceOptions = Pick<
  HostedWorkspaceRouteOptions,
  | "connections"
  | "countActiveOrgSandboxLeases"
  | "sandboxUsage"
  | "prepareRuntime"
  | "provisionRuntime"
  | "runtimeProvisioned"
  | "releaseRuntime"
  | "createWorkspaceRateLimiter"
  | "sandboxLeaseCap"
>

export type HostedCoreAppOptions = {
  documents?: DocumentsBackend
  idempotency: IdempotencyCoordinator
  authentication: RequestAuthenticationAdapter
  relayTargetLookup?: RelayTargetLookup
  liveSyncRoom: LiveSyncRoomNamespace
  sharedRateLimitStore: SharedRateLimitStore
  cloudWorkspaceAdmission: NonNullable<HostedWorkspaceRouteOptions["requireCloudWorkspaceEntitlement"]>
  product: StaticProductDescriptor
  requestGuardExemptions: readonly RouteGuardExemption[]
  productWorkspace?: HostedCoreProductWorkspaceOptions
  agentConfigRepository?: UserAgentConfigRepository
  settingsChanged?: (userId: string) => Promise<void>
  credentialsChanged?: (orgId: string) => Promise<void>
  /**
   * Build-composed product route families (Agent Plugins today). An entry
   * passes an explicit array; the base core passes none and imports no
   * feature implementation. Mounted under their own owner so a contribution
   * cannot silently shadow a core family.
   */
  routeContributions?: readonly ControlPlaneRouteContribution[]
  /**
   * The hosted Connections family (`/api/claxedo/integrations`), supplied only
   * by an entry that composed a durable D1 Connections setup. The base core
   * serves no integration routes at all.
   */
  integrationRoutes?: Hono
  /**
   * The first-party MCP endpoint (`/api/claxedo/mcp`). Admits the CLI JWT as
   * the whole account; a runtime credential too when the entry supplies the
   * verifier. Absent means no endpoint, as with every other contribution.
   */
  firstPartyMcp?: FirstPartyMcpOptions
  /**
   * The register the entry mints sandbox passes into, so the session
   * authority refuses a revoked owner grant before its expiry. Absent on the
   * base core, which mints none.
   */
  sandboxPasses?: Pick<SandboxPassRegister, "revoked">
  /**
   * The store cloud workspace runtimes report usage into and the signed
   * account's usage view reads from. Absent, `/api/claxedo/usage` is not
   * served and a runtime's usage report answers 503.
   */
  usageLedger?: UsageReportWriter & UsageProjectionLedger
}

/**
 * Where to send a human who lands on the control plane's root.
 *
 * The first EXACT origin in the allow-list, ignoring `https://*.` wildcard
 * entries — a wildcard names a shape, not a destination, and redirecting to
 * one produces a URL with a literal asterisk in it.
 */
export function coreAppHomeOrigin(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("https://") && !item.startsWith("https://*."))
}

export function configuredCoreAppOrigins(raw: string | undefined) {
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
      if (originPatterns.some((pattern) => pattern.test(origin))) return origin
      return appOriginAllowed(origin) ? origin : undefined
    },
    maxAge: 86400,
  })
}

export function assertHostedCoreBootConfig(plane: HostedControlPlane, options: Partial<HostedCoreAppOptions>) {
  const failures: string[] = []
  try {
    if (deploymentMode(plane.env) !== "hosted") {
      failures.push(`deployment mode is not hosted (set ${DEPLOYMENT_MODE_ENV}=hosted)`)
    }
  } catch (error) {
    if (!(error instanceof DeploymentModeError)) throw error
    failures.push(error.message)
  }
  if (!options.authentication) failures.push("request authentication adapter is not composed")
  if (!plane.services.authority) failures.push("workspace authority is not composed")
  if (!plane.privateSessionAuthority) failures.push("private-session authority is not composed")
  if (!plane.runtimeSessionAuthority) failures.push("runtime private-session authority is not composed")
  if (!options.liveSyncRoom) failures.push("LIVE_SYNC_ROOM is not bound")
  if (!options.sharedRateLimitStore) failures.push("CLAXEDO_REQUEST_LIMITER is not bound")
  if (!options.cloudWorkspaceAdmission) failures.push("cloud workspace admission policy is not composed")
  if (!options.product) failures.push("static product descriptor is not composed")
  if (!options.requestGuardExemptions) failures.push("product request-guard inventory is not composed")
  if (failures.length) {
    throw new HostedWorkerCompositionError(
      "hosted_core_composition_invalid",
      `Hosted core refuses to start: ${failures.join("; ")}`,
    )
  }
}

export function createHostedCoreApp(plane: HostedControlPlane, options: HostedCoreAppOptions) {
  assertHostedCoreBootConfig(plane, options)
  const { services } = plane
  const authConfig = {
    enabled: true,
    adapter: options.authentication.descriptor.adapter,
    issuer: options.authentication.descriptor.issuer,
    jwksUrl: `request-adapter:${encodeURIComponent(options.authentication.descriptor.configurationVersion)}`,
  } as const
  const ownership = createRouteOwnership()
  const app = withRouteOwnership(new Hono(), ownership, "hosted-core")

  app.use(securityHeaders())
  if (options.authentication.descriptor.browser.transport === "cookie") {
    app.use(browserAuthHttpSecurity(options.authentication.descriptor.browser))
  } else {
    app.use(
      corsMiddleware(
        configuredCoreAppOrigins(plane.env.CLAXEDO_APP_ORIGINS),
        allowedOriginPatterns(plane.env.CLAXEDO_ALLOWED_ORIGIN_SUFFIXES),
      ),
    )
  }
  // Resource timing for the app: whichever CORS path admitted the origin,
  // the browser may also read this response's timing breakdown.
  app.use(async (c, next) => {
    await next()
    const origin = c.res.headers.get("access-control-allow-origin")
    if (origin && origin !== "*" && !c.res.headers.has("timing-allow-origin")) {
      c.res.headers.set("timing-allow-origin", origin)
    }
  })
  app.use(
    unsignedLocalRequestGuard({
      mode: "hosted",
      authConfig,
    }),
  )
  app.use(
    defaultRequestGuard({
      exemptions: hostedRouteGuardExemptions(options.requestGuardExemptions),
      rateLimiter: createLayeredRateLimiter({
        local: createFixedWindowConnectionRateLimiter({
          limit: plane.safetyLimits.defaultRequestRateLimit,
          windowMs: plane.safetyLimits.defaultRequestRateLimitWindowMs,
        }),
        sharedStore: options.sharedRateLimitStore,
      }),
    }),
  )

  const approvedPrivateRepoHosts = privateRepoHosts(plane.env)
  const workspaceOptions: HostedWorkspaceRouteOptions = {
    privateRepoHosts: approvedPrivateRepoHosts,
    authentication: options.authentication,
    requireCloudWorkspaceEntitlement: options.cloudWorkspaceAdmission,
    ...options.productWorkspace,
    authConfig,
    ...hostedSandboxEgress(plane),
    ...(services.relay.runtimeAccessTokenSigner
      ? { runtimeAccessTokenSigner: services.relay.runtimeAccessTokenSigner }
      : {}),
    ...(services.relay.hostTunnelTokenSigner ? { hostTunnelTokenSigner: services.relay.hostTunnelTokenSigner } : {}),
    ...hostConnectEndpointOptions(plane.env),
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

  app.get("/api/claxedo/health", (context) =>
    context.json({ ok: true, mode: "hosted-core", localExecution: services.localExecution.enabled }),
  )
  app.get("/api/claxedo/mode", (context) =>
    context.json({
      mode: "hosted-core",
      signedAuth: true,
      authority: !!services.authority,
      relay: !!services.relay.relayUrl,
      relayResolver: !!services.relay.resolverToken,
      runtimeAccessTokenSigner: !!services.relay.runtimeAccessTokenSigner,
      hostTunnelTokenSigner: !!services.relay.hostTunnelTokenSigner,
      deviceLogin: options.authentication.descriptor.native.cli.flow === "device-authorization",
      product: options.product,
    }),
  )
  app.get("/api/claxedo/compatibility", (context) => context.json(deploymentCompatibilityReport(plane.env)))

  app.route(
    "/",
    HostedShellRoutes({
      authentication: options.authentication,
      authConfig,
      connections: options.integrationRoutes !== undefined,
      ...(plane.env.npm_package_version ? { version: plane.env.npm_package_version } : {}),
      liveSyncRoom: options.liveSyncRoom,
      ...(services.authority ? { resolveOrgId: (auth) => services.authority!.resolveOrgId(auth) } : {}),
      harnessStatus: hostedHarnessRuntimeStatus(services),
      ...hostedPiCredentials({
        resolveOrgId: (auth) => requireAuthority(services).resolveOrgId(auth),
        credentials: plane.orgCredentials,
        ...(options.credentialsChanged ? { changed: options.credentialsChanged } : {}),
      }),
    }),
  )
  app.route(
    "/",
    HostedAuthProfileRoutes({
      authentication: options.authentication,
      listOrgs: (auth) => services.authority!.listOrgs(auth),
      ...(options.product.productPosture === "user-deployed" ? { ownerBootstrap: "one-use-claim" as const } : {}),
    }),
  )
  app.route("/", JwksRoutes(plane.env))
  // The ADAPTER-NATIVE device-login seam. `/api/auth/device/*` (plus the CLI
  // token exchange and revoke that ride with them) exist only for an adapter
  // that owns its own token sets: either a `deviceAuthProvider` binding, whose
  // issuer this Worker brokers the device-code exchange against, or an
  // `AdapterNativeSessionAuthPort` on `services.auth.native`, which mints them
  // directly. `public-docs/writing-an-auth-or-storage-port.md` documents both.
  //
  // ABSENT for Better Auth, which composes neither: its own OAuth server serves
  // device authorization and RFC 7009 revocation, and the auth descriptor points
  // the CLI straight at it. Mounting these unconditionally would shadow that
  // with fail-closed 501 stubs on the certified deployment.
  if (plane.deviceAuthProvider || services.auth.native) {
    app.route(
      "/",
      HostedDeviceAuthRoutes({
        ...(plane.deviceAuthProvider ? { provider: plane.deviceAuthProvider } : {}),
        authConfig: services.auth.config,
        ...(services.auth.verifier ? { verifier: services.auth.verifier } : {}),
        ...(services.auth.native ? { native: services.auth.native } : {}),
        ...(services.authority ? { ensureCliUser: (auth) => services.authority!.usersMe(auth) } : {}),
      }),
    )
  }
  app.route("/api/workspace", HostedWorkspaceRoutes(services, workspaceOptions))
  if (options.agentConfigRepository) {
    app.route("/api/claxedo/agent-config", hostedAgentConfigRoutes({
      services,
      authentication: options.authentication,
      repository: options.agentConfigRepository,
      changed: options.settingsChanged ?? (async () => {}),
    }))
  }
  app.route("/api/claxedo/host/enrollments", HostEnrollmentRoutes(services, workspaceOptions))
  app.route("/api/claxedo/host/session-rows", HostSessionRowsRoutes(services, {
    notify: (orgId, notices) => nudgeLiveSyncRoom(options.liveSyncRoom, liveSyncRoomNameForPrincipal({ orgId }), notices),
  }))
  app.route("/api/claxedo/host/invitations", HostInvitationRoutes(services, workspaceOptions))
  app.route("/api/claxedo/remote-access", RemoteAccessOwnerRoutes({
    deviceLoginConfigured: true,
    relayConfigured: !!services.relay.provider,
    authenticate: async (request) => {
      const result = await signedOrError(request, { authentication: options.authentication, requireSigned: true }, services)
      if ("error" in result) return Response.json(result.error, { status: result.status })
      if (!result.auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, { status: 401 })
      return result.auth
    },
    service: hostedRemoteAccessService(requireAuthority(services)),
  }))
  app.route(
    "/api/workspace",
    WorkspaceCheckpointRoutes(services, {
      authentication: options.authentication,
      defaultHomeRegion: services.defaultHomeRegion,
    }),
  )

  if (options.documents) {
    app.route(
      "/documents",
      DocumentsRoutes({
        backend: options.documents,
        authority: requireAuthority(services),
        authentication: options.authentication,
        env: plane.env,
      }),
    )
    app.route(
      "/p",
      PublicDocumentRoutes({
        backend: options.documents,
        rateLimit: async (key) => (await options.sharedRateLimitStore.check(key)).allowed,
      }),
    )
  }
  mountSessionReadRoutes(app, plane, options.authentication)

  app.route(
    "/api/control",
    HostedControlRoutes(services, {
      idempotency: options.idempotency,
      authentication: options.authentication,
      authConfig,
      cliTokenEnv: plane.env,
    }),
  )
  app.route(
    "/api/control/session-registrations",
    PrivateSessionRegistrationRoutes({
      authority: plane.privateSessionAuthority!,
      authentication: options.authentication,
      services,
    }),
  )
  app.route(
    "/api/control",
    OrgTeamControlRoutes(services, {
      authentication: options.authentication,
      authConfig,
      cliTokenEnv: plane.env,
    }),
  )
  app.route(
    "/api/control",
    SessionPeopleControlRoutes(services, {
      authentication: options.authentication,
      authConfig,
      cliTokenEnv: plane.env,
      sessionShareChangedSink: (event) =>
        nudgeLiveSyncRoom(
          options.liveSyncRoom,
          liveSyncRoomNameForPrincipal(
            event.orgId
              ? { orgId: event.orgId }
              : { ownerUserId: event.ownerUserId },
          ),
          event,
        ),
    }),
  )
  app.route("/api/control", createSessionReaderRoutes({
    authenticate: async (request) => {
      const result = await signedOrError(request, { authentication: options.authentication, requireSigned: true }, services)
      if ("error" in result) return Response.json(result.error, { status: result.status })
      if (!result.auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, { status: 401 })
      return result.auth
    },
    authority: () => {
      const authority = services.authority ?? undefined
      if (!isComposedAuthorityPort<SessionReaderAuthority>(authority, ["recordSessionReader"])) {
        throw new ControlPlaneAuthError(503, "authority_unavailable", "Workspace authority is unavailable")
      }
      return authority
    },
    publish: async (auth, event) => {
      const orgId = await requireAuthority(services).resolveOrgId(auth)
      return await nudgeLiveSyncRoom(options.liveSyncRoom, liveSyncRoomNameForPrincipal({ ownerUserId: event.ownerUserId, orgId }), event)
    },
  }))
  if (options.usageLedger) {
    app.route("/api/claxedo/usage", UsageRoutes({
      ledger: options.usageLedger,
      identity: async (request) => {
        const auth = await routeAuth(request, { authentication: options.authentication, requireSigned: true })
        if (!auth?.principal) return undefined
        return { org_id: await requireAuthority(services).resolveOrgId(auth), user_id: auth.principal.userId }
      },
      // The hosted plane runs in a Worker, which has no home directory for a
      // refreshed catalog's cache.
      pricing: tokenTrackerPricing("bundled"),
      telemetry: services.telemetry,
    }))
  }
  if (plane.runtimeSessionAuthority) {
    app.route(
      "/api/runtime-authority",
      RuntimeSessionAuthorityRoutes({
        authority: plane.runtimeSessionAuthority,
        ...(options.agentConfigRepository && plane.orgCredentials ? { connectionSecrets: {
          resolveWorkspaceOwner: (workspaceId: string) => services.authority?.resolveWorkspaceOwner?.(workspaceId) ?? Promise.resolve(undefined),
          readConnections: async (userId: string) => (await options.agentConfigRepository!.read(userId)).connections,
          credentials: plane.orgCredentials,
        } } : {}),
        ...(plane.turnAuthority ? { turnAuthority: plane.turnAuthority } : {}),
        ...(options.usageLedger ? { usageWriter: options.usageLedger } : {}),
        ...(services.authority?.resolveWorkspaceOwner
          ? {
              ownerGrants: createOwnerGrantProof({
                env: plane.env,
                ...(options.sandboxPasses ? { passes: options.sandboxPasses } : {}),
                resolveWorkspaceOwner: services.authority.resolveWorkspaceOwner.bind(services.authority),
              }),
            }
          : {}),
        env: plane.env,
      }),
    )
  }
  app.route(
    "/",
    InternalRelayResolverRoutes({
      resolverToken: plane.resolverToken,
      ...(services.authority ? { authority: services.authority } : {}),
      targetLookup: options.relayTargetLookup ?? plane.relayTargetLookup,
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
  if (options.integrationRoutes) app.route("/api/claxedo/integrations", options.integrationRoutes)
  const introspectAccessToken = options.authentication.introspectAccessToken?.bind(options.authentication)
  const firstPartyMcp = options.firstPartyMcp
    ? firstPartyMcpContribution({
        app,
        authority: services.authority,
        options: options.firstPartyMcp,
        signedAuth: async (request) => {
          const result = await signedOrError(request, { authentication: options.authentication, requireSigned: true }, services)
          return "error" in result ? undefined : result.auth
        },
        ...(introspectAccessToken
          ? {
              oauthCredential: (request) =>
                resolveOAuthMcpCredential(request, {
                  verifyAccessToken: async (token) => readIntrospectedAccessToken(await introspectAccessToken(token)),
                  controlPlaneOrigin: () => options.authentication.descriptor.native.cli.controlPlaneOrigin,
                }),
            }
          : {}),
        auditFallback: (record) => console.warn("[claxedo-server] mcp.audit unattributed", record),
      })
    : undefined
  if (firstPartyMcp) {
    app.route("/", OAuthProtectedResourceRoutes({
      controlPlaneOrigin: () => options.authentication.descriptor.native.cli.controlPlaneOrigin,
      authorizationServer: () => options.authentication.descriptor.issuer,
    }))
  }
  mountControlPlaneRouteContributions({
    contributions: [...(options.routeContributions ?? []), ...(firstPartyMcp ? [firstPartyMcp] : [])],
    mount: (contribution) => mountOwnedRoute(app, ownership, `contribution:${contribution.id}`, contribution.path, contribution.routes),
  })
  // An API worker's unrouted paths must not render as a PAGE.
  //
  // Hono answers anything unmatched with the bare text "404 Not Found", and a
  // browser renders that as the whole document. Someone who opened this host
  // on their phone saw exactly that and reported "the app 404s" — while the
  // app, on its own origin, was fine. The control plane has no page to show,
  // so it should say so in the same error shape as every other failure here.
  // (The plain-text body has bitten before: a client JSON.parse could not
  // handle it — see the note in `live-claxedo-mcp-tools.spec.ts`.)
  //
  // The root gets a redirect rather than an error, because a person typing
  // this hostname wants the product, not a diagnostic.
  // Both spellings: the hosted roots' CORS reads the plural list, while the
  // user-deployed deploy binds only the SINGULAR `CLAXEDO_APP_ORIGIN`.
  const appHome = coreAppHomeOrigin(plane.env.CLAXEDO_APP_ORIGINS ?? plane.env.CLAXEDO_APP_ORIGIN)
  if (appHome) app.get("/", (context) => context.redirect(appHome, 302))
  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "route_not_found",
          message: "This is the Claxedo control-plane API; it serves no pages.",
        },
      },
      404,
    ),
  )
  return app
}

function mountSessionReadRoutes(app: Hono, plane: HostedControlPlane, authentication: RequestAuthenticationAdapter) {
  const { services } = plane
  app.get("/api/control/sessions", async (context) => {
    const workspaceId = context.req.query("workspaceId")
    if (!workspaceId || !services.authority?.listSessions) return context.json(sessionInventoryResponse([]))
    const authResult = await signedOrError(
      context.req.raw,
      {
        authentication,
        requireSigned: true,
      },
      services,
    )
    if ("error" in authResult) return context.json(authResult.error, authResult.status)
    if (!authResult.auth) return context.json(sessionInventoryResponse([]))
    return context.json(
      sessionInventoryResponse(await services.authority.listSessions(authResult.auth, { workspaceId })),
    )
  })
  // The rail's paginated read. Was missing from every hosted root — see
  // `signedSessionList` for how that happened and why the read is shared.
  app.get("/api/control/session-list", async (context) => {
    const authResult = await signedOrError(
      context.req.raw,
      {
        authentication,
        requireSigned: true,
      },
      services,
    )
    if ("error" in authResult) return context.json(authResult.error, authResult.status)
    if (!authResult.auth) {
      return context.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, 401)
    }
    try {
      return context.json(await signedSessionList(services, authResult.auth, parseSessionListQuery(new URL(context.req.url))))
    } catch (err) {
      const mapped = sessionListErrorResponse(err)
      if (mapped) return mapped
      throw err
    }
  })
  app.get("/api/control/sessions/:sessionId/gateway", async (context) => {
    const authResult = await signedOrError(
      context.req.raw,
      {
        authentication,
        requireSigned: true,
      },
      services,
    )
    if ("error" in authResult) return context.json(authResult.error, authResult.status)
    if (!authResult.auth || !services.authority?.resolveSession) {
      return context.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
    }
    const resolved = asRecord(await services.authority.resolveSession(authResult.auth, {
      sessionId: context.req.param("sessionId"),
    }))
    const resolvedWorkspaceId = stringField(resolved, "workspace_id")
    if (!resolvedWorkspaceId) {
      return context.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
    }
    return context.json({
      gatewayUrl: null,
      workspaceId: resolvedWorkspaceId,
      directory: null,
      harnessHost: "workspace",
    })
  })
  app.route("/api/control", createSessionReadRoutes({
    reads: authoritySessionReads(requireAuthority(services)),
    authenticate: async (request, workspaceId) => {
      if (!workspaceId) return Response.json({ error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId is required" } }, { status: 400 })
      const result = await signedOrError(request, { authentication, requireSigned: true }, services)
      if ("error" in result) return Response.json(result.error, { status: result.status })
      if (!result.auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, { status: 401 })
      return result.auth
    },
  }))
}
