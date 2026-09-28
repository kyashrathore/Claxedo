import fs from "node:fs/promises"
import path from "node:path"
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginMcpServer,
} from "@claxedo/server-core/agent-plugins/catalog/types"
import type { GenerationPluginRoot } from "./types"

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
export async function writeProjectedMcpFile(root: string, plugin: GenerationPluginRoot, servers: readonly AgentPluginMcpServer[]) {
  if (plugin.plugin.mcp.status === "absent") return
  await fs.writeFile(path.join(root, "mcp.json"), `${JSON.stringify({
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, standardServer(server)])),
  }, null, 2)}\n`)
}
