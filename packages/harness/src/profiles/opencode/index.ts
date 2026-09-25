import type { Mcp } from "@opencode-ai/plugin"
import path from "node:path"
import type { McpServerSpec, PluginProjection } from "../../contract"

function mcp(server: McpServerSpec): Mcp.ServerConfig {
  if (server.kind === "stdio") return {
    type: "local", command: [server.command, ...server.args ?? []],
    ...(server.env ? { environment: { ...server.env } } : {}),
  }
  return { type: "remote", url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) }
}

export function openCodeLaunchDocument(projection: PluginProjection, firstParty?: McpServerSpec): {
  skills: readonly string[]
  mcp: Readonly<Record<string, Mcp.ServerConfig>>
} {
  const servers = [...projection.mcpServers, ...(firstParty ? [firstParty] : [])]
  const names = new Set<string>()
  const entries = servers.map((server): [string, Mcp.ServerConfig] => {
    if (names.has(server.name)) throw new Error(`OpenCode MCP server ${server.name} has conflicting owners`)
    names.add(server.name)
    return [server.name, mcp(server)]
  })
  return { skills: projection.pluginRoots.map((plugin) => path.join(plugin.root, "skills")), mcp: Object.fromEntries(entries) }
}
