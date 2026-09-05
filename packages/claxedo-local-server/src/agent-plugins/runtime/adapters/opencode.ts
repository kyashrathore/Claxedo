import fs from "node:fs/promises"
import path from "node:path"
import type { AgentPluginMcpServer } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { pluginInstanceStorageKey } from "../plugin-data"
import { projectedMcpServers } from "./mcp-projection"

function expand(value: string, plugin: GenerationPluginRoot) {
  return value
    .replaceAll("${PLUGIN_ROOT}", plugin.root)
    .replaceAll("${PLUGIN_DATA}", plugin.dataRoot)
}

function serverName(plugin: GenerationPluginRoot, name: string) {
  return `${plugin.plugin.manifest.name}-${pluginInstanceStorageKey(plugin.pluginInstanceId).slice(0, 8)}-${name}`
}

function openCodeMcpServer(plugin: GenerationPluginRoot, server: AgentPluginMcpServer) {
  if (server.type === "stdio") {
    return {
      type: "local",
      command: [expand(server.command, plugin), ...(server.args ?? []).map((value) => expand(value, plugin))],
      ...(server.env ? {
          environment: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expand(value, plugin)])),
        } : {}),
      cwd: server.cwd ? expand(server.cwd, plugin) : plugin.root,
    }
  }
  return {
    type: "remote",
    url: server.url,
    ...(server.headers ? {
        headers: Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, expand(value, plugin)])),
      } : {}),
  }
}

/**
 * OpenCode has native Agent Skills and MCP configuration, but not an Agent
 * Plugins root loader. Generate one module-owned config instead of writing to
 * the project or the user's global OpenCode configuration.
 */
export function openCodeAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "opencode",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const root = path.join(generationRoot, "harnesses", "opencode")
      await fs.mkdir(root, { recursive: true })
      const skills = plugins
        .filter((plugin) => plugin.plugin.skills.length > 0)
        .map((plugin) => path.join(plugin.root, "skills"))
      const mcp = Object.fromEntries(plugins.flatMap((plugin) =>
        plugin.plugin.mcp.status === "valid"
          ? projectedMcpServers(plugin, mcpServers).map((server) => [serverName(plugin, server.name), openCodeMcpServer(plugin, server)] as const)
          : [],
      ))
      const configFile = path.join(root, "opencode.json")
      await fs.writeFile(configFile, `${JSON.stringify({
        ...(skills.length ? { skills: { paths: skills } } : {}),
        ...(Object.keys(mcp).length ? { mcp } : {}),
      }, null, 2)}\n`)
      return {
        harnessId: "opencode",
        configFile,
        pluginRoots: plugins.map((plugin) => ({
          pluginInstanceId: plugin.pluginInstanceId,
          root: plugin.root,
          dataRoot: plugin.dataRoot,
        })),
        diagnostics: [],
      }
    },
  }
}
