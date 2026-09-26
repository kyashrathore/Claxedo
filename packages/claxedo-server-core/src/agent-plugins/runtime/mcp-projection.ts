import { sha256Hex } from "@claxedo/helpers/crypto"
import type { ArtifactDigest } from "../activation/types"
import type { AgentPluginMcpServer, ValidatedAgentPlugin } from "../catalog/types"
import type { AgentPluginRuntimeApplyRequest } from "./apply-contract"
import type { AgentPluginHarnessId } from "./harness-registry"

type RuntimeMcpServerProjectionIdentity = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  harnessId: AgentPluginHarnessId
  serverName: string
}

export type RuntimeMcpServerProjection = RuntimeMcpServerProjectionIdentity & (
  | { state: "gateway"; url: string; headers?: Record<string, string> }
  | { state: "unavailable"; reason: string }
)

/**
 * Resolve gateway placeholders into harness-facing MCP projections.
 *
 * `env` is wherever the brokered secret VALUES live for this runtime: the
 * sandbox's process environment on a VM, the desktop daemon's in-memory map
 * of the credentials the signed pull carried, or the placeholder names a
 * control plane knows its driver installs. Either way the name in the apply
 * request is the key and the value is the complete Authorization header.
 * Daytona substitutes that entire value for its opaque reference.
 */
export function runtimeMcpServers(
  rows: AgentPluginRuntimeApplyRequest["mcpServers"],
  env: Record<string, string | undefined>,
): RuntimeMcpServerProjection[] {
  return rows.map((row): RuntimeMcpServerProjection => {
    const identity = {
      pluginInstanceId: row.pluginInstanceId,
      artifactDigest: row.artifactDigest,
      harnessId: row.harnessId,
      serverName: row.serverName,
    }
    if (row.state === "unavailable") return { ...identity, state: "unavailable", reason: row.reason! }
    const target = row.url!
    const placeholder = env[row.brokeredSecretName!]?.trim()
    return {
      ...identity,
      state: "gateway",
      url: target,
      ...(placeholder ? { headers: { Authorization: placeholder } } : {}),
    }
  })
}

export type ProjectedPlugin = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  plugin: Pick<ValidatedAgentPlugin, "manifest" | "mcp">
}

function projectionFor(
  plugin: ProjectedPlugin,
  serverName: string,
  projections: readonly RuntimeMcpServerProjection[],
) {
  return projections.find((entry) =>
    entry.pluginInstanceId === plugin.pluginInstanceId
    && entry.artifactDigest === plugin.artifactDigest
    && entry.serverName === serverName)
}

/**
 * Apply only runtime transport decisions; retained standard bytes stay
 * immutable. A server the runtime marked unavailable is left out, whatever
 * its transport: for a local command that is the sandbox image lacking it.
 */
export function projectedMcpServers(
  plugin: ProjectedPlugin,
  projections: readonly RuntimeMcpServerProjection[],
): AgentPluginMcpServer[] {
  if (plugin.plugin.mcp.status !== "valid") return []
  const result: AgentPluginMcpServer[] = []
  for (const server of plugin.plugin.mcp.servers) {
    const projection = projectionFor(plugin, server.name, projections)
    if (!projection) {
      result.push(server)
      continue
    }
    if (projection.state === "unavailable") continue
    if (server.type === "stdio") {
      result.push(server)
      continue
    }
    result.push({
      ...server,
      url: projection.url,
      ...(projection.headers ? { headers: projection.headers } : { headers: undefined }),
    })
  }
  return result
}

/**
 * The name a plugin's server takes in a harness whose MCP map is one flat
 * namespace: two plugins may each declare `docs`, so the plugin and the
 * instance it was installed as both go into the name.
 */
export function flatMcpServerName(pluginName: string, storageKey: string, serverName: string) {
  return `${pluginName}-${storageKey.slice(0, 8)}-${serverName}`
}

/** The runtime snapshot's shape for one server every ACP connection receives at `session/new`. */
export type AcpRuntimeMcpServer =
  | { name: string; source: "plugin"; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { name: string; source: "plugin"; transport: "remote"; url: string; headers: Record<string, string> }

function expandRoots(value: string, roots: { root?: string; dataRoot?: string }) {
  return value
    .replaceAll("${PLUGIN_ROOT}", roots.root ?? "${PLUGIN_ROOT}")
    .replaceAll("${PLUGIN_DATA}", roots.dataRoot ?? "${PLUGIN_DATA}")
}

/**
 * What active plugins deliver to custom ACP agents: the MCP servers alone,
 * keyed by their flat name, in the shape the runtime hands to every ACP
 * connection's `session/new`, `load`, `resume` and `fork`. Resolved from
 * activation whenever a snapshot is built, so a connection added after the
 * install receives the same list as one that existed before it.
 */
export async function acpSessionMcpServers(
  plugins: readonly (ProjectedPlugin & { root?: string; dataRoot?: string })[],
  projections: readonly RuntimeMcpServerProjection[],
): Promise<Record<string, AcpRuntimeMcpServer>> {
  const result: Record<string, AcpRuntimeMcpServer> = {}
  for (const plugin of plugins) {
    const storageKey = await sha256Hex(plugin.pluginInstanceId)
    for (const server of projectedMcpServers(plugin, projections.filter((entry) => entry.harnessId === "acp"))) {
      const name = flatMcpServerName(plugin.plugin.manifest.name, storageKey, server.name)
      result[name] = server.type === "stdio"
        ? {
            name,
            source: "plugin",
            transport: "stdio",
            command: expandRoots(server.command, plugin),
            args: (server.args ?? []).map((value) => expandRoots(value, plugin)),
            env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expandRoots(value, plugin)])),
          }
        : { name, source: "plugin", transport: "remote", url: server.url, headers: { ...server.headers } }
    }
  }
  return result
}
