import type { McpServerConfig } from "@cursor/sdk"
import type { McpServerSpec, PluginProjection } from "../../contract"

function cursorMcp(server: McpServerSpec): McpServerConfig {
  if (server.kind === "stdio") return { type: "stdio", command: server.command, args: [...server.args ?? []], env: { ...server.env }, ...(server.cwd ? { cwd: server.cwd } : {}) }
  return { type: server.kind, url: server.url, headers: { ...server.headers } }
}

export function projectCursorMcpServers(projection: PluginProjection, firstParty?: McpServerSpec): Record<string, McpServerConfig> {
  const servers = [...projection.mcpServers, ...firstParty ? [firstParty] : []]
  const result: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    if (Object.hasOwn(result, server.name)) throw new Error(`Duplicate Cursor MCP server ${server.name}`)
    result[server.name] = cursorMcp(server)
  }
  return result
}

export function cursorPluginSettings(projection: PluginProjection): { settingSources?: ["plugins"] } {
  return projection.pluginRoots.length ? { settingSources: ["plugins"] } : {}
}
