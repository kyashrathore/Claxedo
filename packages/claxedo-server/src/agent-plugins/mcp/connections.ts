import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { SignedAgentPluginActivationStore } from "@claxedo/server-core/agent-plugins/activation/store"
import {
  discoverMcpOAuth,
  type McpOAuthDiscoveryResult,
} from "@claxedo/server-core/agent-plugins/mcp/discovery"
import {
  createMcpOAuthIntegration,
  createMcpOAuthIntegrationFromAttempt,
  mcpOAuthDeclaration,
} from "@claxedo/server-core/agent-plugins/mcp/integration"
import type { AgentPluginHttpServer } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { HostedDynamicConnectionIntegrations } from "../../connections/hosted-d1/types"
import { hostedMcpCatalogAuthentication } from "./catalog-auth"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type HostedMcpOAuthConfiguration = Readonly<{
  callbackUrl: string
  fetch: Fetch
  preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
  clientIdMetadataDocumentUrl?: string
}>

type RetainedServer = {
  pluginInstanceId: string
  server: AgentPluginHttpServer
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function retainedServers(
  activations: SignedAgentPluginActivationStore,
  artifacts: AgentPluginArtifactStore,
  auth: NonNullable<Parameters<HostedDynamicConnectionIntegrations>[0]["auth"]>,
) {
  const result: RetainedServer[] = []
  for (const known of (await activations.listKnown(auth)).toSorted((left, right) => left.pluginInstanceId.localeCompare(right.pluginInstanceId))) {
    // Personal acquisition is the user's current definition; absent that, the
    // organization definition wins over the Claxedo definition. This chooses
    // bytes only. Project/harness activation remains a separate runtime check.
    const pin = known.pins.user ?? known.pins.organization ?? known.pins.claxedo
    if (!pin) continue
    const artifact = await artifacts.get(pin.digest)
    if (!artifact || artifact.plugin.mcp.status !== "valid") continue
    for (const server of artifact.plugin.mcp.servers) {
      if (server.type === "streamable-http") result.push({ pluginInstanceId: known.pluginInstanceId, server })
    }
  }
  return result.toSorted((left, right) =>
    left.pluginInstanceId.localeCompare(right.pluginInstanceId) || left.server.name.localeCompare(right.server.name))
}

async function requestedIssuer(request: Request | undefined): Promise<string | undefined> {
  if (!request || request.method !== "POST") return undefined
  const raw: unknown = await request.clone().json().catch(() => undefined)
  const value = record(raw) ? raw : undefined
  if (value?.issuer === undefined) return undefined
  if (typeof value.issuer !== "string" || value.issuer.length > 2_048) throw new Error("MCP authorization server selection is invalid")
  return value.issuer
}

function discovery(input: HostedMcpOAuthConfiguration, server: RetainedServer, selectedIssuer?: string): Promise<McpOAuthDiscoveryResult> {
  return discoverMcpOAuth({
    resourceUrl: server.server.url,
    fetch: input.fetch,
    ...(selectedIssuer ? { selectedIssuer } : {}),
    ...(input.preRegistered ? { preRegistered: input.preRegistered } : {}),
    ...(input.clientIdMetadataDocumentUrl ? { clientIdMetadataDocumentUrl: input.clientIdMetadataDocumentUrl } : {}),
  })
}

/**
 * Adapts retained standard MCP declarations into the existing Connections
 * registry. It owns no rows, attempts, tokens, or credential references.
 */
export function hostedAgentPluginConnectionIntegrations(input: Readonly<{
  activations: SignedAgentPluginActivationStore
  artifacts: AgentPluginArtifactStore
  oauth: HostedMcpOAuthConfiguration
}>): HostedDynamicConnectionIntegrations {
  const authentication = hostedMcpCatalogAuthentication(input.oauth)
  return async (context) => {
    if (context.attemptContext && context.integrationId) {
      return [await createMcpOAuthIntegrationFromAttempt({
        integrationId: context.integrationId,
        serverName: "MCP",
        attemptContext: context.attemptContext,
        fetch: input.oauth.fetch,
        ...(input.oauth.preRegistered ? { preRegistered: input.oauth.preRegistered } : {}),
      })]
    }
    if (context.connectionFields && context.integrationId) {
      return [await createMcpOAuthIntegrationFromAttempt({
        integrationId: context.integrationId,
        serverName: "MCP",
        attemptContext: context.connectionFields,
        fetch: input.oauth.fetch,
        ...(input.oauth.preRegistered ? { preRegistered: input.oauth.preRegistered } : {}),
      })]
    }
    if (!context.auth) return []
    const servers = await retainedServers(input.activations, input.artifacts, context.auth)
    const declarations = (await Promise.all(servers.map(async (server) => {
      const auth = await authentication(server)
      if (auth.state !== "oauth") return undefined
      return {
        server,
        decl: await mcpOAuthDeclaration({
          pluginInstanceId: server.pluginInstanceId,
          serverName: server.server.name,
        }),
      }
    }))).filter((value): value is NonNullable<typeof value> => value !== undefined)
    if (!context.integrationId) return declarations.map(({ decl }) => ({ decl, impl: {} }))
    const selected = declarations.find(({ decl }) => decl.id === context.integrationId)
    if (!selected) return []
    const discovered = await discovery(input.oauth, selected.server, await requestedIssuer(context.request))
    if (discovered.status === "public") return [{ decl: selected.decl, impl: {} }]
    return [await createMcpOAuthIntegration({
      pluginInstanceId: selected.server.pluginInstanceId,
      serverName: selected.server.server.name,
      discovery: discovered.discovery,
      callbackUrl: input.oauth.callbackUrl,
      fetch: input.oauth.fetch,
    })]
  }
}
