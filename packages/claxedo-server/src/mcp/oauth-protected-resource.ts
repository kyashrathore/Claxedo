import { Hono } from "hono"
import { CLAXEDO_MCP_PATH, OAUTH_PROTECTED_RESOURCE_PATH } from "@claxedo/mcp"

import { CLAXEDO_MCP_OAUTH_SCOPES, claxedoMcpResource } from "../platform/auth/mcp-oauth-scopes"

/**
 * RFC 9728 metadata for `/api/claxedo/mcp`, the document the MCP endpoint's
 * 401 challenge names in `WWW-Authenticate: ... resource_metadata=`.
 *
 * Both values are the deployment's, not the request's: an authorization
 * server registers ONE resource identifier, so a request that arrived on a
 * second hostname must still be told the identifier the token will be issued
 * for, or the client asks for a `resource` the server refuses.
 */
export function OAuthProtectedResourceRoutes(input: {
  /** The origin the MCP endpoint is registered under, which names the resource. */
  controlPlaneOrigin: (requestOrigin: string) => string
  /** The authorization server's issuer identifier. */
  authorizationServer: (requestOrigin: string) => string
}) {
  const app = new Hono()

  const respond = (requestOrigin: string) => Response.json(
    {
      resource: claxedoMcpResource(input.controlPlaneOrigin(requestOrigin)),
      authorization_servers: [input.authorizationServer(requestOrigin)],
      scopes_supported: [...CLAXEDO_MCP_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  )

  app.get(OAUTH_PROTECTED_RESOURCE_PATH, (c) => respond(new URL(c.req.url).origin))
  // RFC 9728 §3.1 inserts the resource's own path after the well-known
  // segment, and a client that never read the challenge builds that URL
  // itself. Both name the one resource this deployment protects.
  app.get(`${OAUTH_PROTECTED_RESOURCE_PATH}${CLAXEDO_MCP_PATH}`, (c) => respond(new URL(c.req.url).origin))

  return app
}
