import { sha256Hex } from "@claxedo/helpers/crypto"
import type { ArtifactDigest } from "../activation/types"
import type { AgentPluginMcpServer, ValidatedAgentPlugin } from "../catalog/types"
import type { AgentPluginRuntimeApplyRequest } from "./apply-contract"
import type { AgentPluginHarnessId } from "./harness-registry"
import { harnessSupportsMcpServer, type NotApplied, type ProjectedMcpServer } from "@claxedo/harness/contract"
import type { NativeHarnessId } from "@claxedo/agent-runtime-contract"

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
  root?: string
  dataRoot?: string
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
    if (projection?.state === "unavailable") continue
    result.push(projection && server.type !== "stdio"
      ? { ...server, url: projection.url, ...(projection.headers ? { headers: projection.headers } : { headers: undefined }) }
      : server)
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
  | { name: string; source: "plugin"; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { name: string; source: "plugin"; transport: "remote"; url: string; headers: Record<string, string> }

function serverStrings(server: AgentPluginMcpServer): string[] {
  if (server.type !== "stdio") return [server.url, ...Object.values(server.headers ?? {})]
  return [server.command, ...(server.cwd ? [server.cwd] : []), ...server.args ?? [], ...Object.values(server.env ?? {})]
}

function resolvable(server: AgentPluginMcpServer, plugin: ProjectedPlugin): boolean {
  const relative = server.type === "stdio" && (server.command.startsWith("./") || server.cwd?.startsWith("./"))
  const strings = serverStrings(server)
  return !((relative || strings.some((value) => value.includes("${PLUGIN_ROOT}"))) && !plugin.root)
    && !(strings.some((value) => value.includes("${PLUGIN_DATA}")) && !plugin.dataRoot)
}

function expandRoots(value: string, roots: { root?: string; dataRoot?: string }) {
  return value.replaceAll("${PLUGIN_ROOT}", roots.root ?? "").replaceAll("${PLUGIN_DATA}", roots.dataRoot ?? "")
}

function pluginPath(value: string, plugin: ProjectedPlugin) {
  return value.startsWith("./") ? `${plugin.root}/${value.slice(2)}` : expandRoots(value, plugin)
}

function resolveServer(server: AgentPluginMcpServer, plugin: ProjectedPlugin): AgentPluginMcpServer {
  if (server.type !== "stdio") return { ...server,
    ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandRoots(value, plugin)])) } : {}) }
  return { ...server, command: pluginPath(server.command, plugin),
    ...(server.args ? { args: server.args.map((value) => expandRoots(value, plugin)) } : {}),
    ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandRoots(value, plugin)])) } : {}),
    ...(server.cwd ? { cwd: pluginPath(server.cwd, plugin) } : {}) }
}

function projectedServer(server: AgentPluginMcpServer, name: string): ProjectedMcpServer {
  return server.type === "stdio"
    ? { kind: "stdio", name, origin: "plugin", command: server.command,
      ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}), ...(server.cwd ? { cwd: server.cwd } : {}) }
    : { kind: server.type === "streamable-http" ? "http" : "sse", name, origin: "plugin", url: server.url,
      ...(server.headers ? { headers: server.headers } : {}) }
}

export type PluginMcpProjection = {
  byPlugin: Map<string, AgentPluginMcpServer[]>
  servers: ProjectedMcpServer[]
  notApplied: NotApplied[]
}

/**
 * The one projection of plugin MCP servers. A server that needs the plugin's
 * files where none are materialized is skipped as not installed. With a
 * `harness`, a server that harness cannot represent is skipped as
 * unsupported; without one the host applies that rule to the projected
 * servers. Every skip names the server by its flat name.
 */
export async function pluginMcpProjection(plugins: readonly ProjectedPlugin[], projections: readonly RuntimeMcpServerProjection[],
  harness?: NativeHarnessId): Promise<PluginMcpProjection> {
  const result: PluginMcpProjection = { byPlugin: new Map(), servers: [], notApplied: [] }
  for (const plugin of plugins) {
    const storageKey = await sha256Hex(plugin.pluginInstanceId)
    const carried: AgentPluginMcpServer[] = []
    for (const server of projectedMcpServers(plugin, projections)) {
      const name = flatMcpServerName(plugin.plugin.manifest.name, storageKey, server.name)
      if (!resolvable(server, plugin)) {
        result.notApplied.push({ item: name, reason: "not-installed" })
        continue
      }
      const resolved = resolveServer(server, plugin)
      const projected = projectedServer(resolved, name)
      if (harness && !harnessSupportsMcpServer(harness, projected)) {
        result.notApplied.push({ item: name, reason: "unsupported-by-harness" })
        continue
      }
      carried.push(resolved)
      result.servers.push(projected)
    }
    result.byPlugin.set(plugin.pluginInstanceId, carried)
  }
  return result
}

/**
 * What active plugins deliver to custom ACP agents: the MCP servers alone,
 * keyed by their flat name, in the shape the runtime hands to every ACP
 * connection's `session/new`, `load`, `resume` and `fork`. Resolved from
 * activation whenever a snapshot is built, so a connection added after the
 * install receives the same list as one that existed before it.
 */
export async function acpSessionMcpServers(
  plugins: readonly ProjectedPlugin[],
  projections: readonly RuntimeMcpServerProjection[],
): Promise<{ servers: Record<string, AcpRuntimeMcpServer>; notApplied: NotApplied[] }> {
  const result: Record<string, AcpRuntimeMcpServer> = {}
  const projected = await pluginMcpProjection(plugins, projections.filter((entry) => entry.harnessId === "acp"))
  for (const server of projected.servers) {
    const name = server.name
    result[name] = server.kind === "stdio"
        ? {
            name,
            source: "plugin",
            transport: "stdio",
            command: server.command,
            args: [...server.args ?? []],
            env: { ...server.env },
            ...(server.cwd ? { cwd: server.cwd } : {}),
          }
        : { name, source: "plugin", transport: "remote", url: server.url, headers: { ...server.headers } }
  }
  return { servers: result, notApplied: projected.notApplied }
}
