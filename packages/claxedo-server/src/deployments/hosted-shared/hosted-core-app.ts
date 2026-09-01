import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { cors } from "hono/cors"
import { allowedOriginPatterns } from "@claxedo/server-core/platform/http/cors-origins"
import { securityHeaders } from "@claxedo/server-core/platform/http/security-headers"
import { browserAuthHttpSecurity } from "@claxedo/server-core/platform/http/browser-auth-security"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"
import type { FirstPartyServiceCatalog } from "@claxedo/service-contract"

import { JwksRoutes } from "../../authority/routes/jwks"
import { HostedShellRoutes } from "../../routes/hosted/shell"
import { HostedAuthProfileRoutes } from "../../routes/hosted/auth-profile"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "../../routes/hosted/workspace"
import { HostEnrollmentRoutes } from "../../routes/hosted/host-enrollment"
import { WorkspaceCheckpointRoutes } from "../../workspace/routes/checkpoints"
import { signedOrError } from "../../workspace/route-support"
import { HostedControlRoutes } from "../../routes/hosted/control"
import { InternalRelayResolverRoutes, type RelayTargetLookup } from "../shared-routes/internal-relay"
import { HostedSandboxAdminRoutes } from "../../routes/hosted/sandbox-admin"
import { RuntimeSessionAuthorityRoutes } from "../../routes/runtime-session-authority"
import { PrivateSessionRegistrationRoutes } from "../../routes/private-session-registration"
import {
  UserDeployedIdentityAdmissionRoutes,
  type UserDeployedIdentityAdmission,
} from "../../routes/user-deployed-identity-admission"
import { OrgTeamControlRoutes } from "../../session/routes/org-team-routes"
import { SessionPeopleControlRoutes } from "../../session/routes/session-people-routes"
import { createRouteOwnership, withRouteOwnership } from "../route-ownership"
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
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { messagePageCursor, parseMessagePageInput } from "../../session/message-page"
import type { HostedControlPlane } from "../../authority/hosted-services"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import {
  liveSyncRoomNameForPrincipal,
  nudgeLiveSyncRoom,
  type LiveSyncRoomNamespace,
} from "../../platform/http/live-sync-publish"
import type { StaticProductDescriptor } from "./deployment-profile"

export type HostedCoreProductWorkspaceOptions = Pick<
  HostedWorkspaceRouteOptions,
  "connections" | "countActiveOrgSandboxLeases" | "sandboxUsage"
>

export type HostedCoreAppOptions = {
  authentication: RequestAuthenticationAdapter
  relayTargetLookup?: RelayTargetLookup
  centralSessionRuntime?: boolean
  liveSyncRoom: LiveSyncRoomNamespace
  sharedRateLimitStore: SharedRateLimitStore
  serviceCatalog(auth: SignedControlPlaneAuth): Promise<FirstPartyServiceCatalog>
  cloudWorkspaceAdmission: NonNullable<HostedWorkspaceRouteOptions["requireCloudWorkspaceEntitlement"]>
  product: StaticProductDescriptor
  requestGuardExemptions: readonly RouteGuardExemption[]
  productWorkspace?: HostedCoreProductWorkspaceOptions
  userDeployedIdentityAdmission?: UserDeployedIdentityAdmission
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
  if (!options.serviceCatalog) failures.push("service catalog is not composed")
  if (!options.cloudWorkspaceAdmission) failures.push("cloud workspace admission policy is not composed")
  if (!options.product) failures.push("static product descriptor is not composed")
  if (!options.requestGuardExemptions) failures.push("product request-guard inventory is not composed")
  if (options.product?.productPosture === "user-deployed" && !options.userDeployedIdentityAdmission) {
    failures.push("user-deployed identity admission is not composed")
  }
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
  const app = withRouteOwnership(new Hono(), createRouteOwnership(), "hosted-core")

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

  const workspaceOptions: HostedWorkspaceRouteOptions = {
    authentication: options.authentication,
    requireCloudWorkspaceEntitlement: options.cloudWorkspaceAdmission,
    ...(options.productWorkspace ?? {}),
    authConfig,
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
      optionalServices: "authenticated-catalog",
      product: options.product,
    }),
  )
  app.get("/api/claxedo/compatibility", (context) => context.json(deploymentCompatibilityReport(plane.env)))

  app.route(
    "/",
    HostedShellRoutes({
      authentication: options.authentication,
      authConfig,
      ...(plane.env.npm_package_version ? { version: plane.env.npm_package_version } : {}),
      ...(services.authority ? { listWorkspaces: (auth) => services.authority!.listWorkspaces(auth) } : {}),
      liveSyncRoom: options.liveSyncRoom,
      ...(services.authority ? { resolveOrgId: (auth) => services.authority!.resolveOrgId(auth) } : {}),
      serviceCatalog: options.serviceCatalog,
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
  app.route("/api/workspace", HostedWorkspaceRoutes(services, workspaceOptions))
  app.route("/api/claxedo/host/enrollments", HostEnrollmentRoutes(services, workspaceOptions))
  app.route(
    "/api/workspace",
    WorkspaceCheckpointRoutes(services, {
      authentication: options.authentication,
      defaultHomeRegion: services.defaultHomeRegion,
    }),
  )

  if (!options.centralSessionRuntime) mountSessionReadRoutes(app, plane, options.authentication)

  app.route(
    "/api/control",
    HostedControlRoutes(services, {
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
  // The user-deployed product keeps provider verification and application
  // membership separate. Only this explicit owner/admin lifecycle route may
  // turn a provider-verified subject into a canonical app principal.
  if (options.userDeployedIdentityAdmission) {
    app.route(
      "/api/control",
      UserDeployedIdentityAdmissionRoutes({
        authentication: options.authentication,
        admission: options.userDeployedIdentityAdmission,
      }),
    )
  }
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
  if (plane.runtimeSessionAuthority) {
    app.route(
      "/api/runtime-authority",
      RuntimeSessionAuthorityRoutes({
        authority: plane.runtimeSessionAuthority,
        ...(plane.turnAuthority ? { turnAuthority: plane.turnAuthority } : {}),
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
  // locked better-auth worker binds the SINGULAR `CLAXEDO_APP_ORIGIN`
  // (`better-auth-d1-locked-worker.cf.ts`). Reading only the plural made the
  // redirect silently never fire on the deployment it was written for —
  // caught live: the root answered a JSON 404 with no `location`.
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
    if ("error" in authResult) return context.json(authResult.error, authResult.status as 401 | 403 | 503)
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
    if ("error" in authResult) return context.json(authResult.error, authResult.status as 401 | 403 | 503)
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
    if ("error" in authResult) return context.json(authResult.error, authResult.status as 401 | 403 | 503)
    if (!authResult.auth || !services.authority?.resolveSession) {
      return context.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
    }
    const resolved = (await services.authority.resolveSession(authResult.auth, {
      sessionId: context.req.param("sessionId"),
    })) as { workspace_id?: string } | null
    if (!resolved?.workspace_id) {
      return context.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
    }
    return context.json({
      gatewayUrl: null,
      workspaceId: resolved.workspace_id,
      directory: null,
      harnessHost: "central",
    })
  })
  app.get("/api/control/sessions/:sessionId/messages", async (context) => {
    const workspaceId = context.req.query("workspaceId")
    if (!workspaceId || !services.authority?.readSessionMessages) {
      return context.json({ error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId is required" } }, 400)
    }
    const authResult = await signedOrError(
      context.req.raw,
      {
        authentication,
        requireSigned: true,
      },
      services,
    )
    if ("error" in authResult) return context.json(authResult.error, authResult.status as 401 | 403 | 503)
    if (!authResult.auth) {
      return context.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, 401)
    }
    let page
    try {
      page = parseMessagePageInput(context.req.query("limit"), context.req.query("before"), context.req.query("view"))
    } catch (error) {
      if (error instanceof AgentMessagePageError) {
        return context.json({ error: { code: "message_page_error", message: error.message } }, 400)
      }
      throw error
    }
    let body
    try {
      body = await services.authority.readSessionMessages(authResult.auth, {
        sessionId: context.req.param("sessionId"),
        workspaceId,
        ...(page ?? {}),
      })
    } catch (error) {
      if (error instanceof AgentMessagePageError) {
        const status = error.status >= 400 && error.status <= 599 ? error.status : 500
        return context.json(
          { error: { code: "message_page_error", message: error.message } },
          status as ContentfulStatusCode,
        )
      }
      throw error
    }
    const cursor = messagePageCursor(body)
    if (cursor) {
      context.header("Access-Control-Expose-Headers", "X-Next-Cursor")
      context.header("X-Next-Cursor", cursor)
    }
    const messages =
      body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).messages : undefined
    return context.json({
      ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
      messages: Array.isArray(messages) ? messages : [],
      maxEventOrdinal: 0,
    })
  })
}
