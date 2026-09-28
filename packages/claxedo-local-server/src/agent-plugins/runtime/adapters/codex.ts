import fs from "node:fs/promises"
import path from "node:path"
import { pluginInstanceStorageKey } from "../plugin-data"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { pluginMcpProjection, type RuntimeMcpServerProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import type { NotApplied } from "@claxedo/harness/contract"
import { writeDotMcpFile } from "./dot-mcp-file"

function pluginVersion(version: string | undefined) {
  const result = version?.trim() || "1.0.0"
  if (!/^[A-Za-z0-9.+_-]+$/.test(result) || result === "." || result === "..") {
    throw new Error(`Codex cannot materialize plugin version ${JSON.stringify(result)}`)
  }
  return result
}

async function projectPlugin(
  viewRoot: string,
  plugin: GenerationPluginRoot,
  mcpServers: readonly RuntimeMcpServerProjection[],
) {
  const destination = path.join(
    viewRoot,
    `${plugin.plugin.manifest.name}-${pluginInstanceStorageKey(plugin.pluginInstanceId).slice(0, 12)}`,
  )
  await fs.cp(plugin.root, destination, { recursive: true, dereference: true, force: false, errorOnExist: true })
  const projection = await pluginMcpProjection([{ ...plugin, root: destination }], mcpServers, "codex")
  const projected = projection.byPlugin.get(plugin.pluginInstanceId) ?? []
  const codexManifestDirectory = path.join(destination, ".codex-plugin")
  await fs.mkdir(codexManifestDirectory, { recursive: true })
  await fs.writeFile(path.join(codexManifestDirectory, "plugin.json"), `${JSON.stringify({
    name: plugin.plugin.manifest.name,
    version: pluginVersion(plugin.plugin.manifest.version),
    ...(plugin.plugin.manifest.description ? { description: plugin.plugin.manifest.description } : {}),
    ...(plugin.plugin.skills.length ? { skills: "./skills/" } : {}),
    ...(plugin.plugin.mcp.status === "valid" && projected.length ? { mcpServers: "./.mcp.json" } : {}),
  }, null, 2)}\n`)
  if (plugin.plugin.mcp.status === "valid" && projected.length) await writeDotMcpFile(destination, projected)
  return { root: destination, notApplied: projection.notApplied }
}

export function codexAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "codex",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const viewRoot = path.join(generationRoot, "harnesses", "codex", "plugins")
      await fs.mkdir(viewRoot, { recursive: true })
      const roots = []
      const notApplied: NotApplied[] = []
      for (const plugin of plugins) {
        const projected = await projectPlugin(viewRoot, plugin, mcpServers)
        notApplied.push(...projected.notApplied)
        roots.push({ pluginInstanceId: plugin.pluginInstanceId, root: projected.root,
          dataRoot: plugin.dataRoot, skillNames: plugin.plugin.skills.map((skill) => skill.name) })
      }
      return { harnessId: "codex", pluginRoots: roots, mcpServers: [], notApplied }
    },
  }
}
