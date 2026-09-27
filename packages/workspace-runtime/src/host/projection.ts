import type { ProviderProjection, SessionHarness } from "@claxedo/agent-runtime-contract"
import { resolvedMcpServers } from "../mcp/resolver"
import type { PluginProjection, ProjectedMcpServer, ResolvedCredentials, SkillRoot } from "@claxedo/harness/contract"
import { isRecord } from "@claxedo/helpers/guards"

export type ProjectionSource = {
  generation: string
  mcp: Record<string, unknown>
  harnessLaunch: Record<string, Record<string, unknown>>
}

function skillRoot(harnessId: string, value: unknown): SkillRoot {
  if (!isRecord(value) || typeof value.pluginInstanceId !== "string" || typeof value.root !== "string" || typeof value.dataRoot !== "string") {
    throw new Error(`The ${harnessId} plugin launch names a plugin root without pluginInstanceId, root and dataRoot`)
  }
  return { pluginInstanceId: value.pluginInstanceId, root: value.root, dataRoot: value.dataRoot }
}

function pluginLaunchFor(harness: SessionHarness, harnessLaunch: ProjectionSource["harnessLaunch"]): { generation?: string; pluginRoots: SkillRoot[] } {
  const launch = harness.access === "native" ? harnessLaunch[harness.id] : undefined
  if (launch === undefined) return { pluginRoots: [] }
  if (typeof launch.generation !== "string" || !Array.isArray(launch.pluginRoots)) {
    throw new Error(`The ${harness.id} plugin launch must name its generation and list its plugin roots`)
  }
  return { generation: launch.generation, pluginRoots: launch.pluginRoots.map((value) => skillRoot(harness.id, value)) }
}

export function configuredMcpServers(mcp: Record<string, unknown>): ProjectedMcpServer[] {
  return Object.values(resolvedMcpServers(mcp) ?? {}).map((server) => server.transport === "stdio"
    ? { kind: "stdio", name: server.name, command: server.command, args: server.args, env: server.env, origin: "configured" }
    : { kind: "http", name: server.name, url: server.url, headers: server.headers, origin: "configured" })
}

/** The projection a harness launches with, from the accepted runtime snapshot. */
export function pluginProjectionFor(harness: SessionHarness, source: ProjectionSource): PluginProjection {
  const plugins = pluginLaunchFor(harness, source.harnessLaunch)
  return {
    generation: plugins.generation === undefined ? source.generation : `${source.generation}/plugins:${plugins.generation}`,
    mcpServers: configuredMcpServers(source.mcp),
    pluginRoots: plugins.pluginRoots,
    notApplied: [],
  }
}

/** The snapshot's provider projections are the credentials every session of this runtime spends. */
export function snapshotCredentials(auth: Record<string, ProviderProjection>, leaseGeneration: string): ResolvedCredentials {
  return { providers: auth, secrets: {}, leaseGeneration }
}
