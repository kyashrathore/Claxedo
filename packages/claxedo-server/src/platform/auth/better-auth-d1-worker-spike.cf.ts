import {
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider"
import type { D1Database } from "@cloudflare/workers-types"
import { AuthenticationError, type AuthAdapterDescriptor } from "@claxedo/server-core/platform/auth/authentication"

import { createBetterAuthD1AuthenticationEvidenceResolver } from "./better-auth-d1-authentication-evidence"
import { betterAuthNativeRevocation, createBetterAuthD1Foundation } from "./better-auth-d1-foundation"
import { createBetterAuthD1RequestAuthenticationAdapter } from "./better-auth-d1-request-authentication"
import {
  resolveBetterAuthConfiguration,
  type AuthEmailMessage,
} from "./better-auth-configuration"
import { betterAuthNativeResource } from "./better-auth-native-clients"

const API_ORIGIN = "https://api.claxedo.test"
const APP_ORIGIN = "https://app.claxedo.test"
const SECRET = "unit-1-better-auth-d1-spike-secret-that-is-long-enough"
const INTROSPECTION_SECRET = "test-introspection-secret-that-is-long-enough"

type Env = { AUTH_DB: D1Database }

let auth: ReturnType<typeof createBetterAuthD1Foundation> | undefined
let requestAuthentication: ReturnType<typeof createBetterAuthD1RequestAuthenticationAdapter> | undefined
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

function controlPlaneAuthentication(env: Env) {
  const instance = authentication(env)
  const descriptor = {
    adapter: "better-auth",
    deploymentId: "workerd-auth-evidence-test",
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
        scopes: ["offline_access", "workspace:read", "workspace:write"],
        tokenEndpointOrigin: API_ORIGIN,
        controlPlaneOrigin: API_ORIGIN,
        revocation: betterAuthNativeRevocation(API_ORIGIN),
      },
      desktop: {
        flow: "authorization-code-pkce",
        clientId: "claxedo-desktop",
        resource: `${API_ORIGIN}/control-plane`,
        scopes: ["offline_access", "workspace:read", "workspace:write"],
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
    resolveIdentity: async (identity) => ({
      state: "active",
      userId: `application:${identity.subject}`,
      actorId: `human:${identity.subject}`,
    }),
  }))
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
