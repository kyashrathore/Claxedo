import fs from "node:fs/promises"
import path from "node:path"
import type { AgentPluginMcpServer } from "@claxedo/server-core/agent-plugins/catalog/types"

function dotMcpServer(server: AgentPluginMcpServer) {
  const { name: _name, type, ...config } = server
  return type === "stdio" ? config : { ...config, type: type === "streamable-http" ? "http" : "sse" }
}

export async function writeDotMcpFile(root: string, servers: readonly AgentPluginMcpServer[]) {
  await fs.writeFile(path.join(root, ".mcp.json"), `${JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, dotMcpServer(server)])),
  }, null, 2)}\n`)
}
