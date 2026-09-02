import {
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider"
import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { AuthenticationError, type AuthAdapterDescriptor } from "@claxedo/server-core/platform/auth/authentication"
import type { HostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"

import { createBetterAuthD1AuthenticationEvidenceResolver } from "../../platform/auth/better-auth-d1-authentication-evidence"
import { BETTER_AUTH_NATIVE_SCOPES, betterAuthNativeRevocation, createBetterAuthD1Foundation } from "../../platform/auth/better-auth-d1-foundation"
import { createBetterAuthD1RequestAuthenticationAdapter } from "../../platform/auth/better-auth-d1-request-authentication"
import {
  resolveBetterAuthConfiguration,
  type AuthEmailMessage,
} from "../../platform/auth/better-auth-configuration"
import { betterAuthNativeResource } from "../../platform/auth/better-auth-native-clients"
import { createD1CoreAuthority } from "../../authority/adapters/d1/core-authority"
import { createD1UserHostedTargetResolver } from "../../authority/adapters/d1/user-hosted-relay-target"
import type { ControlPlaneServices } from "../../authority/services"
import { HostEnrollmentRoutes } from "../../routes/hosted/host-enrollment"
import { HostedWorkspaceRoutes } from "../../routes/hosted/workspace"

const API_ORIGIN = "https://api.claxedo.test"
const APP_ORIGIN = "https://app.claxedo.test"
const SECRET = "unit-1-better-auth-d1-spike-secret-that-is-long-enough"
const INTROSPECTION_SECRET = "test-introspection-secret-that-is-long-enough"
const DEPLOYMENT_ID = "workerd-auth-evidence-test"
const RELAY_URL = "https://relay.claxedo.test"

type Env = { AUTH_DB: D1Database; CONTROL_PLANE_DB: D1Database }

let auth: ReturnType<typeof createBetterAuthD1Foundation> | undefined
let requestAuthentication: ReturnType<typeof createBetterAuthD1RequestAuthenticationAdapter> | undefined
let coreAuthority: ReturnType<typeof createD1CoreAuthority> | undefined
let controlPlane: Hono | undefined
let lastEmail: AuthEmailMessage | undefined

const configuration = resolveBetterAuthConfiguration({
  env: {
    CLAXEDO_AUTH_METHODS: "email-password",
    BETTER_AUTH_URL: API_ORIGIN,
    CLAXEDO_APP_ORIGIN: APP_ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
  },
  emailSender: {
    async send(message) {
      lastEmail = message
    },
  },
})

function authentication(env: Env) {
  return (auth ??= createBetterAuthD1Foundation({
    database: env.AUTH_DB,
    configuration,
    resource: betterAuthNativeResource(API_ORIGIN),
    databaseHooks: {
      account: {
        create: {
          async before(account, context) {
            const field = context?.headers?.get("x-test-account-binding-mutation")
            if (!field || !["userId", "providerId", "issuer", "accountId"].includes(field)) return
            return { data: { ...account, [field]: `hook-mutated-${field}` } }
          },
        },
      },
    },
  }))
}

/**
 * The REAL D1 control-plane authority over CONTROL_PLANE_DB — the same
 * `createD1CoreAuthority` composition the deployed Worker uses, so the spike's
 * host-access flow exercises real principals, real signature verification, and
 * real routing state rather than a stub.
 */
function controlPlaneAuthority(env: Env) {
  return (coreAuthority ??= createD1CoreAuthority(env.CONTROL_PLANE_DB, {
    deploymentId: DEPLOYMENT_ID,
    product: { kind: "claxedo-hosted" },
  }))
}

function controlPlaneAuthentication(env: Env) {
  const instance = authentication(env)
  const descriptor = {
    adapter: "better-auth",
    deploymentId: DEPLOYMENT_ID,
    configurationVersion: "auth-evidence-v1",
    expiresAt: 4_102_444_800_000,
    issuer: `${API_ORIGIN}/api/auth`,
    methods: ["email-password"],
    browser: {
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      trustedOrigins: [APP_ORIGIN],
      clientId: "claxedo-browser",
      resource: `${API_ORIGIN}/control-plane`,
      scopes: ["workspace:read", "workspace:write"],
      cookie: {
        name: "__Secure-claxedo.session_token",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        sameSite: "lax",
      },
    },
    native: {
      cli: {
        flow: "device-authorization",
        clientId: "claxedo-cli",
        resource: `${API_ORIGIN}/control-plane`,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: API_ORIGIN,
        controlPlaneOrigin: API_ORIGIN,
        revocation: betterAuthNativeRevocation(API_ORIGIN),
      },
      desktop: {
        flow: "authorization-code-pkce",
        clientId: "claxedo-desktop",
        resource: `${API_ORIGIN}/control-plane`,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: API_ORIGIN,
        controlPlaneOrigin: API_ORIGIN,
        revocation: betterAuthNativeRevocation(API_ORIGIN),
      },
    },
  } as const satisfies AuthAdapterDescriptor
  return (requestAuthentication ??= createBetterAuthD1RequestAuthenticationAdapter({
    descriptor,
    auth: instance,
    nativeIntrospectionClient: {
      clientId: "claxedo-control-plane",
      clientSecret: INTROSPECTION_SECRET,
    },
    resolveAuthenticationEvidence: createBetterAuthD1AuthenticationEvidenceResolver(env.AUTH_DB),
    // The production wiring: an authenticated Better Auth identity resolves to
    // (and on first sight provisions) its D1 control-plane principal, so the
    // host-access routes below act on real users/actors rows.
    resolveIdentity: async (identity) => controlPlaneAuthority(env).ensureApplicationIdentity(identity),
  }))
}

/**
 * The machine-sharing control plane, mounted at its REAL paths: machine-wide
 * enrollment (`/api/claxedo/host/enrollments/*`) and owner assignment
 * (`/api/workspace/:id/host-assignment`), authenticated by the same Better
 * Auth adapter the rest of the Worker uses, over the same D1 authority.
 *
 * `/__test/relay-target` exposes the service-side routing read
 * (`createD1UserHostedTargetResolver`) so the spike can assert the fact the
 * relay would act on: a workspace routes to a host only while it is
 * owner-assigned AND inside the machine's heartbeat-acked served set AND the
 * enrollment lease is live. No `deploymentId` filter here: the hosted product
 * policy stamps personal orgs with a NULL deployment id.
 */
function controlPlaneApp(env: Env) {
  if (controlPlane) return controlPlane
  const services = {
    authority: controlPlaneAuthority(env),
    sandbox: {},
    telemetry: { capture() {} },
  } as unknown as ControlPlaneServices
  const hostTunnelTokenSigner: HostTunnelTokenSigner = async (input) => ({
    hostTunnelToken: `htt-${input.hostId}:${[...input.workspaceIds].sort().join("+")}`,
    tokenExpiresAt: 4_102_444_800_000,
    jti: `jti-${crypto.randomUUID()}`,
  })
  const options = {
    authentication: controlPlaneAuthentication(env),
    relayUrl: RELAY_URL,
    hostTunnelTokenSigner,
  }
  const resolveRelayTarget = createD1UserHostedTargetResolver(env.CONTROL_PLANE_DB)
  return (controlPlane = new Hono()
    .route("/api/claxedo/host/enrollments", HostEnrollmentRoutes(services, options))
    .route("/api/workspace", HostedWorkspaceRoutes(services, options))
    .get("/__test/relay-target", async (context) =>
      context.json(await resolveRelayTarget(context.req.query("workspaceId") ?? "")),
    ))
}

function withCors(request: Request, response: Response) {
  if (request.headers.get("origin") !== APP_ORIGIN) return response
  const headers = new Headers(response.headers)
  headers.set("access-control-allow-origin", APP_ORIGIN)
  headers.set("access-control-allow-credentials", "true")
  headers.append("vary", "Origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env) {
    const instance = authentication(env)
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === "/__test/last-email" && request.method === "GET") {
      const recipient = url.searchParams.get("recipient")
      return recipient && lastEmail?.recipient === recipient
        ? Response.json(lastEmail)
        : new Response("not found", { status: 404 })
    }

    if (
      pathname.startsWith("/api/claxedo/host/enrollments")
      || pathname.startsWith("/api/workspace")
      || pathname === "/__test/relay-target"
    ) {
      return controlPlaneApp(env).fetch(request)
    }

    if (pathname === "/__test/authenticate" && request.method === "GET") {
      try {
        return Response.json(await controlPlaneAuthentication(env).authenticate(request))
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return Response.json({ code: error.code }, { status: error.status })
        }
        return Response.json({ code: "unexpected_authentication_error" }, { status: 500 })
      }
    }

    if (request.method === "OPTIONS") {
      const response = new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      })
      return withCors(request, response)
    }

    const response = pathname === "/.well-known/oauth-authorization-server"
      ? await oauthProviderAuthServerMetadata(instance)(request)
      : await instance.handler(request)
    return withCors(request, response)
  },
}
