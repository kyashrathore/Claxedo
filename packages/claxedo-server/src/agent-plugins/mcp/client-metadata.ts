import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"

export const MCP_CLIENT_METADATA_ROUTE = "/oauth/client-metadata.json" as const

export type HostedMcpClientMetadata = ReturnType<typeof hostedMcpClientMetadata>

function publicHttpsUrl(value: string, name: string) {
  const url = new URL(value)
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be a public HTTPS origin without credentials, path, query, or fragment`)
  }
  return url
}

/**
 * Builds the one public OAuth client identity used by hosted MCP connections.
 *
 * The client ID is the document URL itself. Keeping both values in this one
 * value prevents a deployment variable from drifting away from the document
 * body, which authorization servers are required to reject.
 */
export function hostedMcpClientMetadata(publicUrl: string) {
  const base = publicHttpsUrl(publicUrl, "CLAXEDO_PUBLIC_URL")
  const clientId = new URL(
    `${AGENT_PLUGINS_ROUTE_PATH}${MCP_CLIENT_METADATA_ROUTE}`,
    base,
  ).toString()
  const redirectUri = new URL("/api/claxedo/integrations/callback", base).toString()
  return {
    route: MCP_CLIENT_METADATA_ROUTE,
    clientId,
    redirectUri,
    document: {
      client_id: clientId,
      client_name: "Claxedo",
      client_uri: new URL("/", base).toString(),
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  } as const
}
