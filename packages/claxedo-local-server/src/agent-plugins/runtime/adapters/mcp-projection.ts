import fs from "node:fs/promises"
import path from "node:path"
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginMcpServer,
} from "@claxedo/server-core/agent-plugins/catalog/types"
import type { GenerationPluginRoot, RuntimeMcpServerProjection } from "./types"

function projectionFor(
  plugin: GenerationPluginRoot,
  serverName: string,
  projections: readonly RuntimeMcpServerProjection[],
) {
  return projections.find((entry) =>
    entry.pluginInstanceId === plugin.pluginInstanceId
    && entry.artifactDigest === plugin.artifactDigest
    && entry.serverName === serverName)
}

/** Apply only runtime transport decisions; retained standard bytes stay immutable. */
export function projectedMcpServers(
  plugin: GenerationPluginRoot,
  projections: readonly RuntimeMcpServerProjection[],
): AgentPluginMcpServer[] {
  if (plugin.plugin.mcp.status !== "valid") return []
  const result: AgentPluginMcpServer[] = []
  for (const server of plugin.plugin.mcp.servers) {
    if (server.type === "stdio") {
      result.push(server)
      continue
    }
    const projection = projectionFor(plugin, server.name, projections)
    if (!projection) {
      result.push(server)
      continue
    }
    if (projection.state === "unavailable") continue
    result.push({
      ...server,
      url: projection.url,
      ...(projection.headers ? { headers: projection.headers } : { headers: undefined }),
    })
  }
  return result
}

function standardServer(server: AgentPluginMcpServer) {
  if (server.type === "stdio") {
    return {
      type: server.type,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    }
  }
  return {
    type: server.type,
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  }
}

/** Rewrite a harness-owned copy, never the retained digest-addressed root. */
export async function writeProjectedMcpFile(
  root: string,
  plugin: GenerationPluginRoot,
  projections: readonly RuntimeMcpServerProjection[],
) {
  if (plugin.plugin.mcp.status === "absent") return
  const servers = projectedMcpServers(plugin, projections)
  await fs.writeFile(path.join(root, "mcp.json"), `${JSON.stringify({
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, standardServer(server)])),
  }, null, 2)}\n`)
}
