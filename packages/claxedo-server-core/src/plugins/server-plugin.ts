import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import type { ClaxedoFetch, McpServiceGrant, McpToolGroup } from "@claxedo/mcp/tool-group"
import type { ControlPlaneAuthConfig, ControlPlaneTokenVerifier } from "../platform/auth/auth"
import type { ControlPlaneRouteContribution } from "../platform/http/route-contribution"

/**
 * What a first-party plugin hands a server host. A host mounts each plugin it
 * was composed with and nothing else: a product without the plugin never
 * imports its code.
 */
export type ServerPluginBase = Readonly<{
  /** Unique among the plugins one host is composed with. */
  id: string
  /** Reported in the bootstrap's `deployment.capabilities`, which app plugins name in `requires`. */
  capability?: string
  mcp?: McpPluginContribution
}>

export type McpPluginContribution = Readonly<{
  /** Served after the core groups, under the same consent: a group is registered only while its id is enabled. */
  groups: readonly McpToolGroup[]
  service?: McpServiceContribution
}>

export type McpServiceContribution = Readonly<{
  /** The key a tool's access names. */
  id: string
  grant(input: McpServiceGrantInput): Promise<McpServiceGrant | undefined>
}>

export type McpServiceGrantInput = Readonly<{
  /** The calling session's workspace; absent for an account credential, which belongs to none. */
  workspaceId?: string
  sessionId?: string
  /** The tool groups the calling session consented to. */
  enabledGroups: readonly string[]
  /** A fetch that enters this process's own routes, with these headers added. */
  inProcessFetch(headers: Readonly<Record<string, string>>): ClaxedoFetch
}>

/**
 * The local host's own authentication, which a plugin's routes verify a signed
 * caller with. The host creates it, so a plugin built by the composition root
 * receives it when its routes are mounted.
 */
export type LocalServerPluginHost = Readonly<{
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
}>

export type LocalServerPlugin = ServerPluginBase & Readonly<{
  routeContributions(host: LocalServerPluginHost): readonly ControlPlaneRouteContribution[]
}>

export type HostedServerPlugin = ServerPluginBase & Readonly<{
  routeContributions: readonly ControlPlaneRouteContribution[]
}>

export class ServerPluginCompositionError extends Error {
  constructor(readonly code: "duplicate-plugin-id", message: string) {
    super(message)
    this.name = "ServerPluginCompositionError"
  }
}

/** Refuses a composition that names one plugin id twice, before anything mounts. */
export function assertDistinctServerPlugins(plugins: readonly ServerPluginBase[]): void {
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new ServerPluginCompositionError("duplicate-plugin-id", `Server plugin ${plugin.id} was supplied more than once`)
    }
    seen.add(plugin.id)
  }
}

/** The bootstrap's `deployment.capabilities`: each mounted plugin's capability, sorted. */
export function serverPluginCapabilities(plugins: readonly ServerPluginBase[]): string[] {
  return [...new Set(plugins.flatMap((plugin) => (plugin.capability ? [plugin.capability] : [])))].sort()
}

/** Every group a host's MCP mount serves and its catalog lists: the core groups, then each plugin's, in composition order. */
export function mcpToolGroups(plugins: readonly ServerPluginBase[]): readonly McpToolGroup[] {
  return [...CLAXEDO_MCP_TOOL_GROUPS, ...plugins.flatMap((plugin) => plugin.mcp?.groups ?? [])]
}
