import type { AgentPluginHarnessProjectionAdapter } from "./types"
import { pluginMcpProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"

export function openCodeAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "opencode",
    async project({ plugins, mcpServers = [] }) {
      const projected = await pluginMcpProjection(plugins, mcpServers)
      return {
        harnessId: "opencode",
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
