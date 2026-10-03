import type { AgentPluginHarnessProjectionAdapter } from "./types"
import { pluginMcpProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"

/** Pi reads skills from the retained roots and connects each projected MCP server itself; nothing is written for it. */
export function piAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "pi",
    async project({ plugins, mcpServers = [] }) {
      const projected = await pluginMcpProjection(plugins, mcpServers, "pi")
      return {
        harnessId: "pi",
        pluginRoots: plugins.map((plugin) => ({
          pluginInstanceId: plugin.pluginInstanceId, root: plugin.root, dataRoot: plugin.dataRoot,
          skillNames: plugin.plugin.skills.map((skill) => skill.name),
        })),
        mcpServers: projected.servers,
        notApplied: projected.notApplied,
      }
    },
  }
}
