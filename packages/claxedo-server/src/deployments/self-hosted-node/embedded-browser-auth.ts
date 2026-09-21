import type { MiddlewareHandler } from "hono"
import type { AuthAdapterDescriptor } from "@claxedo/server-core/platform/auth/authentication"
import { browserAuthHttpSecurity } from "@claxedo/server-core/platform/http/browser-auth-security"
import { BETTER_AUTH_NATIVE_SCOPES, betterAuthIssuer, betterAuthNativeRevocation } from "../../platform/auth/better-auth-d1-foundation"
import { BETTER_AUTH_CLI_CLIENT_ID, BETTER_AUTH_DESKTOP_CLIENT_ID } from "../../platform/auth/better-auth-native-clients"
import { EMBEDDED_AUTH_ISSUER, embeddedAuthPublicOrigin, embeddedAuthSessionCookieName, embeddedControlPlaneResource } from "./embedded-auth"

/**
 * The browser half of the embedded issuer: what lets the signed web app run
 * against a self-hosted server.
 *
 * The web client's first request is the auth descriptor, which it validates
 * against a fixed contract (exact HTTPS origins, cookie transport, the
 * `__Secure-` session cookie). The hosted worker serves that descriptor from
 * its Better Auth configuration; this module derives the same document from
 * the embedded issuer, so one client contract covers both deployments.
 *
 * A browser session is a cookie, and every signed self-hosted route verifies a
 * bearer token. The embedded issuer's bearer plugin accepts the very token the
 * cookie carries, so the bridge below presents the session cookie as the
 * bearer credential — after the same origin and content-type guard the hosted
 * worker applies to cookie-authenticated mutations.
 */

export const EMBEDDED_BROWSER_AUTH_CLIENT_ID = "claxedo-browser"
export const EMBEDDED_BROWSER_AUTH_SCOPES = ["workspace:read", "workspace:write"] as const
/** The descriptor is regenerated per request; this is how far ahead its expiry sits. */
const DESCRIPTOR_LIFETIME_MS = 365 * 24 * 60 * 60_000

export type EmbeddedBrowserAuthDescriptor = AuthAdapterDescriptor & {
  adapter: "better-auth"
  browser: Extract<AuthAdapterDescriptor["browser"], { transport: "cookie" }>
}

/**
 * The embedded issuer's descriptor, or `undefined` when the public origin is
 * not HTTPS: the browser contract cannot be met over plain HTTP (the session
 * cookie would not be `Secure`), and serving a document the client must
 * refuse helps nobody. Bearer clients are unaffected either way.
 */
export function embeddedBrowserAuthDescriptor(input: {
  env?: NodeJS.ProcessEnv
  now?: () => number
} = {}): EmbeddedBrowserAuthDescriptor | undefined {
  const env = input.env ?? process.env
  const origin = embeddedAuthPublicOrigin(env)
  if (!origin.startsWith("https:")) return undefined
  const now = input.now ?? Date.now
  const resource = embeddedControlPlaneResource(env)
  return {
    adapter: "better-auth",
    deploymentId: env.CLAXEDO_DEPLOYMENT_ID?.trim() || EMBEDDED_AUTH_ISSUER,
    configurationVersion: `${EMBEDDED_AUTH_ISSUER}:${origin}`,
    expiresAt: now() + DESCRIPTOR_LIFETIME_MS,
    issuer: betterAuthIssuer(origin),
    methods: ["email-password"],
    browser: {
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      trustedOrigins: [origin],
      clientId: EMBEDDED_BROWSER_AUTH_CLIENT_ID,
      resource,
      scopes: [...EMBEDDED_BROWSER_AUTH_SCOPES],
      cookie: {
        name: embeddedAuthSessionCookieName(env),
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
        clientId: BETTER_AUTH_CLI_CLIENT_ID,
        resource,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: origin,
        controlPlaneOrigin: origin,
        revocation: betterAuthNativeRevocation(origin),
      },
      desktop: {
        flow: "authorization-code-pkce",
        clientId: BETTER_AUTH_DESKTOP_CLIENT_ID,
        resource,
        scopes: BETTER_AUTH_NATIVE_SCOPES,
        tokenEndpointOrigin: origin,
        controlPlaneOrigin: origin,
        revocation: betterAuthNativeRevocation(origin),
      },
    },
  }
}

function exactCookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const value = part.trim()
    const separator = value.indexOf("=")
    if (separator > 0 && value.slice(0, separator) === name) return decodeURIComponent(value.slice(separator + 1))
  }
  return undefined
}

/**
 * Presents the exact session cookie as the bearer credential on requests that
 * carry no `Authorization` header. A request carrying both is refused here:
 * the descriptor's credential policy is `reject-cookie-and-authorization`,
 * and this deployment verifies bare bearer tokens — nothing downstream sees
 * the cookie, so the bridge is the only place the policy can be enforced.
 * The refusal mirrors `ambiguous_credentials` in the canonical adapter
 * (`assertUnambiguousCredential`, platform/auth/authentication.ts).
 */
export function embeddedBrowserSessionBearer(descriptor: EmbeddedBrowserAuthDescriptor): MiddlewareHandler {
  const cookieName = descriptor.browser.cookie.name
  return async (context, next) => {
    const session = exactCookieValue(context.req.raw, cookieName)
    const hasAuthorization = context.req.raw.headers.has("authorization")
    if (hasAuthorization && session !== undefined) {
      return context.json(
        { error: { code: "ambiguous_credentials", message: "Multiple authentication credentials are not accepted" } },
        401,
      )
    }
    if (!hasAuthorization && session) context.req.raw.headers.set("authorization", `Bearer ${session}`)
    return next()
  }
}

/** The origin and content-type guard for cookie-authenticated mutations, shared with the hosted worker. */
export function embeddedBrowserAuthSecurity(descriptor: EmbeddedBrowserAuthDescriptor): MiddlewareHandler {
  return browserAuthHttpSecurity(descriptor.browser)
}
