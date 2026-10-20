import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"

/**
 * The redirect hosts of MCP hosts that run in a browser rather than on the
 * person's machine. A code sent to one of these lands in that host's own
 * callback, which redeems it only for the authorization it started.
 */
const HOSTED_MCP_CLIENT_REDIRECT_HOSTS: readonly string[] = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "vscode.dev",
  "insiders.vscode.dev",
]

const FIRST_PARTY_NAME = "claxedo"

function refuseRegistration(error: "invalid_redirect_uri" | "invalid_client_metadata", description: string): never {
  throw new APIError("BAD_REQUEST", { error, error_description: description })
}

function checkRedirectUri(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "https:") return
  if (HOSTED_MCP_CLIENT_REDIRECT_HOSTS.includes(url.hostname.toLowerCase())) return
  refuseRegistration(
    "invalid_redirect_uri",
    `unauthenticated clients may redirect only to a loopback address, a private-use scheme, or a hosted MCP client: ${value}`,
  )
}

function checkClientName(value: unknown) {
  if (typeof value !== "string") return
  if (!value.toLowerCase().replace(/[^a-z0-9]/g, "").includes(FIRST_PARTY_NAME)) return
  refuseRegistration("invalid_client_metadata", "client_name must not imitate this deployment's own applications")
}

/**
 * Anyone can register a client at `/oauth2/register` with no credential, and
 * the consent page names a client by the `client_name` it registered with.
 * An https redirect on an arbitrary host would let a stranger register
 * "Claxedo Desktop" pointing at their own server and collect the code of
 * whoever clicks Allow. Better Auth already restricts http to loopback and
 * custom schemes to well-formed private-use names, so https is the one scheme
 * that can deliver a code off the person's machine to an arbitrary host.
 */
export function oauthClientRegistrationPolicy(): BetterAuthPlugin {
  return {
    id: "claxedo-oauth-client-registration-policy",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/oauth2/register",
        handler: createAuthMiddleware(async (ctx) => {
          checkClientName(ctx.body?.client_name)
          const redirects: unknown = ctx.body?.redirect_uris
          if (Array.isArray(redirects)) for (const redirect of redirects) checkRedirectUri(redirect)
        }),
      }],
    },
  }
}
