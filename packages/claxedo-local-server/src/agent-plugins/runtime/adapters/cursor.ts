import fs from "node:fs/promises"
import path from "node:path"
import type { AgentPluginHarnessProjectionAdapter } from "./types"
import { writeProjectedMcpFile } from "./standard-mcp-file"
import { pluginInstanceStorageKey } from "../plugin-data"
import { pluginMcpProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import type { NotApplied } from "@claxedo/harness/contract"

export function cursorAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "cursor",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const roots = []
      const notApplied: NotApplied[] = []
      for (const plugin of plugins) {
        const root = path.join(generationRoot, "harnesses", "cursor", `${plugin.plugin.manifest.name}-${pluginInstanceStorageKey(plugin.pluginInstanceId).slice(0, 12)}`)
        await fs.cp(plugin.root, root, { recursive: true, dereference: true, force: false, errorOnExist: true })
        const projected = await pluginMcpProjection([{ ...plugin, root }], mcpServers, "cursor")
        notApplied.push(...projected.notApplied)
        await writeProjectedMcpFile(root, { ...plugin, root }, projected.byPlugin.get(plugin.pluginInstanceId) ?? [])
        roots.push({ pluginInstanceId: plugin.pluginInstanceId, root, dataRoot: plugin.dataRoot,
          skillNames: plugin.plugin.skills.map((skill) => skill.name) })
      }
      return { harnessId: "cursor", pluginRoots: roots, mcpServers: [], notApplied }
    },
  }
}
