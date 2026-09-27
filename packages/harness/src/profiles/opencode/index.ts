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

export function openCodeLaunchDocument(projection: PluginProjection, servers: readonly McpServerSpec[]): {
  skills: readonly string[]
  mcp: Readonly<Record<string, Mcp.ServerConfig>>
} {
  const entries = servers.map((server): [string, Mcp.ServerConfig] => {
    return [server.name, mcp(server)]
  })
  return {
    skills: projection.pluginRoots.flatMap((plugin) => plugin.skillNames.map((name) => path.join(plugin.root, "skills", name))),
    mcp: Object.fromEntries(entries),
  }
}
