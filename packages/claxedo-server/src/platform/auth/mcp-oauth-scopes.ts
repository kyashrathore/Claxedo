/**
 * The OAuth scopes an MCP client consents to, and the resource it holds them
 * on.
 *
 * Literals rather than reads of `@claxedo/mcp`: every auth composition —
 * including the Cloudflare Worker's — is in this module's closure, and that
 * package carries Hono and the MCP SDK. `src/mcp/oauth-credential.test.ts`
 * fails when either half drifts from the package's own `MCP_SCOPES` and
 * `CLAXEDO_MCP_PATH`.
 */

export const CLAXEDO_MCP_OAUTH_SCOPES = [
  "claxedo:read",
  "claxedo:act",
  "claxedo:approve",
  "claxedo:admin",
] as const

export type ClaxedoMcpOAuthScope = (typeof CLAXEDO_MCP_OAUTH_SCOPES)[number]

/**
 * What the consent page checks for the user, and the ceiling for a client the
 * deployment did not register itself.
 *
 * `claxedo:approve` answers a permission prompt on the human's behalf and
 * `claxedo:admin` destroys workspaces, so neither is ever pre-checked.
 */
export const CLAXEDO_MCP_DEFAULT_OAUTH_SCOPES = ["claxedo:read", "claxedo:act"] as const

/**
 * `offline_access` rides with them because Better Auth issues no refresh token
 * without it and MCP access tokens live 5 minutes: an MCP client that could
 * not refresh would send the user back through consent every five minutes.
 */
export const CLAXEDO_MCP_RESOURCE_SCOPES = [...CLAXEDO_MCP_OAUTH_SCOPES, "offline_access"] as const

const CLAXEDO_MCP_RESOURCE_PATH = "/api/claxedo/mcp"

/** The RFC 9728 resource identifier: the MCP endpoint's own absolute URL. */
export function claxedoMcpResource(apiOrigin: string) {
  const origin = new URL(apiOrigin)
  if (origin.origin !== apiOrigin || origin.username || origin.password) {
    throw new Error("Claxedo MCP resource requires an exact API origin")
  }
  return `${origin.origin}${CLAXEDO_MCP_RESOURCE_PATH}`
}

export function isClaxedoMcpOAuthScope(scope: string): scope is ClaxedoMcpOAuthScope {
  return (CLAXEDO_MCP_OAUTH_SCOPES as readonly string[]).includes(scope)
}
