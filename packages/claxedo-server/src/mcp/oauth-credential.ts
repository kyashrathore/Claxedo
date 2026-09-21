import { asRecord } from "@claxedo/helpers/guards"
import { bearerToken } from "@claxedo/helpers/string"
import type { McpCredential, McpScope } from "@claxedo/mcp/context"

import { claxedoMcpResource, type ClaxedoMcpOAuthScope, isClaxedoMcpOAuthScope } from "../platform/auth/mcp-oauth-scopes"

/** What an authorization server says about a live access token (RFC 7662 §2.2, the fields this deployment reads). */
export type OAuthAccessTokenClaims = Readonly<{
  /** The user the token acts for. */
  subject: string
  clientId: string
  /** Every scope the token carries, including ones this endpoint does not read. */
  scopes: readonly string[]
  /** The resources the token is bound to, when the server audience-binds it. */
  audience?: readonly string[]
}>

export type OAuthMcpCredentialDeps = Readonly<{
  /** Returns undefined for anything that is not a live access token this deployment issued. */
  verifyAccessToken: (token: string) => Promise<OAuthAccessTokenClaims | undefined> | OAuthAccessTokenClaims | undefined
  /** The origin the MCP endpoint is registered under, for the audience check. */
  controlPlaneOrigin: (requestOrigin: string) => string
}>

/**
 * The client ids this deployment registers itself, in
 * `better-auth-native-clients.ts`.
 *
 * `claxedo:admin` destroys workspaces, and dynamic registration lets any MCP
 * host hold a client record here. The authorization server — not the
 * registrant — mints a dynamic client's id, so this set is one no MCP host
 * can enter. The consent page declines to offer admin to anyone else; this is
 * the boundary that holds when a client asks the token endpoint directly.
 */
const DEPLOYMENT_REGISTERED_CLIENT_IDS: ReadonlySet<string> = new Set(["claxedo-cli", "claxedo-desktop"])

/** Reads an RFC 7662 introspection body into the claims this endpoint needs, or undefined for an inactive token. */
export function readIntrospectedAccessToken(body: unknown): OAuthAccessTokenClaims | undefined {
  const record = asRecord(body)
  if (!record || record.active !== true) return undefined
  const subject = typeof record.sub === "string" ? record.sub : undefined
  const clientId = typeof record.client_id === "string" ? record.client_id : undefined
  if (!subject || !clientId) return undefined
  const audience = typeof record.aud === "string"
    ? [record.aud]
    : Array.isArray(record.aud) ? record.aud.filter((value): value is string => typeof value === "string") : undefined
  return {
    subject,
    clientId,
    scopes: typeof record.scope === "string" ? record.scope.split(/\s+/).filter(Boolean) : [],
    ...(audience ? { audience } : {}),
  }
}

/** The consent-page name of each scope, and the credential name the tools gate on. */
const MCP_SCOPE_BY_OAUTH_SCOPE = {
  "claxedo:read": "read",
  "claxedo:act": "act",
  "claxedo:approve": "approve",
  "claxedo:admin": "admin",
} as const satisfies Record<ClaxedoMcpOAuthScope, McpScope>

function grantedScopes(claims: OAuthAccessTokenClaims): Set<McpScope> {
  const granted = new Set<McpScope>()
  const registered = DEPLOYMENT_REGISTERED_CLIENT_IDS.has(claims.clientId)
  for (const scope of claims.scopes) {
    if (!isClaxedoMcpOAuthScope(scope)) continue
    if (scope === "claxedo:admin" && !registered) continue
    granted.add(MCP_SCOPE_BY_OAUTH_SCOPE[scope])
  }
  return granted
}

function claimedResource(request: Request, deps: OAuthMcpCredentialDeps) {
  return claxedoMcpResource(deps.controlPlaneOrigin(new URL(request.url).origin))
}

/**
 * The MCP credential behind an `Authorization: Bearer <provider access token>`.
 *
 * Undefined — never a throw — for a request the mount should answer 401 to:
 * no bearer, a token the server does not recognise, one issued for another
 * resource or for none, or one carrying no `claxedo:` scope at all.
 */
export async function resolveOAuthMcpCredential(
  request: Request,
  deps: OAuthMcpCredentialDeps,
): Promise<McpCredential | undefined> {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) return undefined
  const claims = await deps.verifyAccessToken(token)
  if (!claims) return undefined
  // This endpoint serves exactly one resource, so the token must be bound to
  // it. The authorization server mints no `aud` at all for a token request
  // that names no `resource`, and an unbound token is as little a token for
  // here as one minted for the account-wide control-plane resource.
  if (!claims.audience?.includes(claimedResource(request, deps))) return undefined
  const scopes = grantedScopes(claims)
  if (scopes.size === 0) return undefined
  return {
    kind: "user",
    actorId: claims.subject,
    scopes,
    clientId: claims.clientId,
    readOnly: [...scopes].every((scope) => scope === "read"),
  }
}
