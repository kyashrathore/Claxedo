import type { McpServerConfig } from "@cursor/sdk"
import type { McpServerSpec, PluginProjection } from "../../contract"
import { TransportError } from "../../contract/errors"

function cursorMcp(server: McpServerSpec): McpServerConfig {
  if (server.kind === "stdio") return { type: "stdio", command: server.command, args: [...server.args ?? []], env: { ...server.env }, ...(server.cwd ? { cwd: server.cwd } : {}) }
  return { type: server.kind, url: server.url, headers: { ...server.headers } }
}

export function projectCursorMcpServers(servers: readonly McpServerSpec[]): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    result[server.name] = cursorMcp(server)
  }
  return result
}

export function assertCursorProjection(projection: PluginProjection): void {
  if (projection.pluginRoots.length) {
    throw new TransportError("cursor", "configuration", "Cursor cannot project per-session plugin roots; its plugin folder is machine scoped")
  }
}
