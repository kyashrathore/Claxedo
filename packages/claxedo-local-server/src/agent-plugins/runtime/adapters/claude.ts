import fs from "node:fs/promises"
import path from "node:path"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { pluginInstanceStorageKey } from "../plugin-data"
import { pluginMcpProjection, type RuntimeMcpServerProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import type { NotApplied } from "@claxedo/harness/contract"
import { writeDotMcpFile } from "./dot-mcp-file"

export async function writeClaudePluginRoot(viewRoot: string, input: GenerationPluginRoot): Promise<string> {
  const root = path.join(viewRoot, `${input.plugin.manifest.name}-${pluginInstanceStorageKey(input.pluginInstanceId).slice(0, 12)}`)
  await fs.cp(input.root, root, { recursive: true, dereference: true, force: false, errorOnExist: true })
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true })
  await fs.writeFile(path.join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: input.plugin.manifest.name,
    ...(input.plugin.manifest.version ? { version: input.plugin.manifest.version } : {}),
    ...(input.plugin.manifest.description ? { description: input.plugin.manifest.description } : {}),
  }, null, 2)}\n`)
  await fs.rm(path.join(root, ".mcp.json"), { force: true })
  return root
}

async function projectPlugin(viewRoot: string, input: GenerationPluginRoot, mcpServers: readonly RuntimeMcpServerProjection[]) {
  const root = await writeClaudePluginRoot(viewRoot, input)
  const projected = await pluginMcpProjection([{ ...input, root }], mcpServers, "claude")
  const carried = projected.byPlugin.get(input.pluginInstanceId) ?? []
  if (input.plugin.mcp.status === "valid" && carried.length) await writeDotMcpFile(root, carried)
  return { root, notApplied: projected.notApplied }
}

/** Claude accepts directory plugins but not the Agent Plugins v1 manifest/MCP filenames. */
export function claudeAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "claude",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const viewRoot = path.join(generationRoot, "harnesses", "claude")
      await fs.mkdir(viewRoot, { recursive: true })
      const roots = []
      const notApplied: NotApplied[] = []
      for (const plugin of plugins) {
        const projected = await projectPlugin(viewRoot, plugin, mcpServers)
        notApplied.push(...projected.notApplied)
        roots.push({
          pluginInstanceId: plugin.pluginInstanceId,
          root: projected.root,
          dataRoot: plugin.dataRoot,
          skillNames: plugin.plugin.skills.map((skill) => skill.name),
        })
      }
      return { harnessId: "claude", pluginRoots: roots, mcpServers: [], notApplied }
    },
  }
}
