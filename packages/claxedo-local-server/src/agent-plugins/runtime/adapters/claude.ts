import fs from "node:fs/promises"
import path from "node:path"
import type { AgentPluginMcpServer } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { pluginInstanceStorageKey } from "../plugin-data"
import { projectedMcpServers } from "./mcp-projection"

function expandClaudePlaceholders(value: string) {
  return value
    .replaceAll("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
    .replaceAll("${PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}")
}

function claudeMcpServer(server: AgentPluginMcpServer) {
  if (server.type === "stdio") {
    return {
      command: server.command,
      ...(server.args ? { args: server.args.map(expandClaudePlaceholders) } : {}),
      ...(server.env ? {
          env: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expandClaudePlaceholders(value)])),
        } : {}),
      ...(server.cwd ? { cwd: expandClaudePlaceholders(server.cwd) } : {}),
    }
  }
  return {
    type: server.type === "streamable-http" ? "http" : "sse",
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  }
}

async function projectPlugin(viewRoot: string, input: GenerationPluginRoot, mcpServers: Parameters<typeof projectedMcpServers>[1]) {
  const root = path.join(viewRoot, `${input.plugin.manifest.name}-${pluginInstanceStorageKey(input.pluginInstanceId).slice(0, 12)}`)
  await fs.cp(input.root, root, { recursive: true, dereference: true, force: false, errorOnExist: true })
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
  await fs.writeFile(path.join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: input.plugin.manifest.name,
    ...(input.plugin.manifest.version ? { version: input.plugin.manifest.version } : {}),
    ...(input.plugin.manifest.description ? { description: input.plugin.manifest.description } : {}),
  }, null, 2)}\n`)
  const projected = projectedMcpServers(input, mcpServers)
  if (input.plugin.mcp.status === "valid" && projected.length) {
    await fs.writeFile(path.join(root, ".mcp.json"), `${JSON.stringify({
      mcpServers: Object.fromEntries(projected.map((server) => [server.name, claudeMcpServer(server)])),
    }, null, 2)}\n`)
  }
  return root
}

/** Claude accepts directory plugins but not the Agent Plugins v1 manifest/MCP filenames. */
export function claudeAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "claude",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const viewRoot = path.join(generationRoot, "harnesses", "claude")
      await fs.mkdir(viewRoot, { recursive: true })
      const roots = []
      for (const plugin of plugins) {
        roots.push({
          pluginInstanceId: plugin.pluginInstanceId,
          root: await projectPlugin(viewRoot, plugin, mcpServers),
          dataRoot: plugin.dataRoot,
        })
      }
      return { harnessId: "claude", pluginRoots: roots, diagnostics: [] }
    },
  }
}
