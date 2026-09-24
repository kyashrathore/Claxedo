import type { PluginCandidate } from "@/server"

export type OAuthServer = {
  readonly name: string
  readonly integrationId: string
  readonly issuers?: readonly string[]
}

export function oauthServers(plugin: PluginCandidate): OAuthServer[] {
  return plugin.mcpServers.flatMap((server) =>
    server.authentication.state === "oauth"
      ? [
          {
            name: server.name,
            integrationId: server.authentication.integrationId,
            ...(server.authentication.issuers ? { issuers: server.authentication.issuers } : {}),
          },
        ]
      : [],
  )
}
