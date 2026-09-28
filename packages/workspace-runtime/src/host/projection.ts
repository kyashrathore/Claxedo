import type { ProviderProjection, SessionHarness } from "@claxedo/agent-runtime-contract"
import { harnessDefinition } from "@claxedo/agent-runtime-contract"
import { parseNotApplied, parsePluginSelection, parseProjectedMcpServers, projectMcpForHarness } from "@claxedo/harness/contract"
import type { NotApplied, PluginProjection, ProjectedMcpServer, ResolvedCredentials, SkillRoot } from "@claxedo/harness/contract"
import { isRecord } from "@claxedo/helpers/guards"

export type ProjectionSource = {
  generation: string
  mcp: Record<string, unknown>
  harnessLaunch: Record<string, Record<string, unknown>>
}

function skillRoot(harnessId: string, value: unknown): SkillRoot {
  if (!isRecord(value) || typeof value.pluginInstanceId !== "string" || typeof value.root !== "string" || typeof value.dataRoot !== "string"
    || !Array.isArray(value.skillNames) || !value.skillNames.every((name): name is string => typeof name === "string")) {
    throw new Error(`The ${harnessId} plugin launch names a plugin root without pluginInstanceId, root, dataRoot and skillNames`)
  }
  return { pluginInstanceId: value.pluginInstanceId, root: value.root, dataRoot: value.dataRoot, skillNames: value.skillNames }
}

function pluginLaunchFor(harness: SessionHarness, harnessLaunch: ProjectionSource["harnessLaunch"]): { generation?: string; pluginSelection?: PluginProjection["pluginSelection"]; pluginRoots: SkillRoot[]; mcpServers: ProjectedMcpServer[]; notApplied: NotApplied[] } {
  const launch = harness.access === "native" ? harnessLaunch[harness.id] : undefined
  if (launch === undefined) return { pluginRoots: [], mcpServers: [], notApplied: [] }
  if (typeof launch.generation !== "string" || !Array.isArray(launch.pluginRoots)) {
    throw new Error(`The ${harness.id} plugin launch must name its generation and list its plugin roots`)
  }
  const mcpServers = parseProjectedMcpServers(launch.mcpServers)
  if (mcpServers.some((server) => server.origin !== "plugin")) throw new Error("Plugin launch contains a non-plugin MCP origin")
  return { generation: launch.generation, pluginSelection: parsePluginSelection(launch.execution),
    pluginRoots: launch.pluginRoots.map((value) => skillRoot(harness.id, value)), mcpServers, notApplied: parseNotApplied(launch.notApplied) }
}

function projectResolvedMcpServers(mcp: Record<string, unknown>): ProjectedMcpServer[] {
  return parseProjectedMcpServers(Object.values(mcp).map((server) => {
    if (!isRecord(server) || (server.source !== "plugin" && server.source !== "managed" && server.source !== "user")) throw new Error("Invalid snapshot MCP source")
    const origin = server.source === "plugin" ? "plugin" : server.source === "managed" ? "first-party" : "configured"
    if (server.transport === "stdio") return { kind: "stdio", name: server.name, origin,
      command: server.command, args: server.args, env: server.env, cwd: server.cwd }
    if (server.transport === "remote") return { kind: "http", name: server.name, origin, url: server.url, headers: server.headers }
    throw new Error("Invalid snapshot MCP transport")
  }))
}

/** The projection a harness launches with, from the accepted runtime snapshot. */
export function pluginProjectionFor(harness: SessionHarness, source: ProjectionSource): PluginProjection {
  const plugins = pluginLaunchFor(harness, source.harnessLaunch)
  const mcpServers = [...projectResolvedMcpServers(source.mcp).filter((server) => harness.access === "connection" || server.origin !== "plugin"), ...plugins.mcpServers]
  const target = harness.access === "connection" ? "acp" : harnessDefinition(harness)?.id
  if (target === undefined) throw new Error(`Unknown native harness ${harness.id}`)
  const applied = projectMcpForHarness(target, mcpServers)
  return {
    generation: plugins.generation === undefined ? source.generation : `${source.generation}/plugins:${plugins.generation}`,
    ...(plugins.pluginSelection ? { pluginSelection: plugins.pluginSelection } : {}),
    mcpServers: applied.servers,
    pluginRoots: plugins.pluginRoots,
    notApplied: [...plugins.notApplied, ...applied.notApplied],
  }
}

/** The snapshot's provider projections are the credentials every session of this runtime spends. */
export function snapshotCredentials(auth: Record<string, ProviderProjection>, leaseGeneration: string): ResolvedCredentials {
  return { providers: auth, secrets: {}, leaseGeneration }
}
