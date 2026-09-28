import fs from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@claxedo/helpers/guards"
import { acpSessionMcpServers, type AcpRuntimeMcpServer } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import type { AgentPluginHarnessProjectionAdapter } from "./types"

/**
 * Custom ACP agents take a plugin's MCP servers in every session request and,
 * over claude-agent-acp, the plugin roots through `_meta`. The resolved server
 * map lives in the generation because a restart re-reads a projection from
 * its files, never from the artifacts.
 */
export function acpAgentPluginAdapter(): AgentPluginHarnessProjectionAdapter {
  return {
    harnessId: "acp",
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const root = path.join(generationRoot, "harnesses", "acp")
      await fs.mkdir(root, { recursive: true })
      const configFile = path.join(root, "mcp.json")
      const { servers, notApplied } = await acpSessionMcpServers(plugins, mcpServers)
      await fs.writeFile(configFile, `${JSON.stringify({ servers }, null, 2)}\n`)
      return {
        harnessId: "acp",
        configFile,
        pluginRoots: plugins.map((plugin) => ({
          pluginInstanceId: plugin.pluginInstanceId,
          root: plugin.root,
          dataRoot: plugin.dataRoot,
          skillNames: plugin.plugin.skills.map((skill) => skill.name),
        })),
        mcpServers: [], notApplied,
      }
    },
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

function acpServer(name: string, value: unknown): AcpRuntimeMcpServer | undefined {
  if (!isRecord(value) || value.name !== name || value.source !== "plugin") return undefined
  if (value.transport === "stdio") {
    const env = stringRecord(value.env)
    if (typeof value.command !== "string" || !Array.isArray(value.args) || !value.args.every((item) => typeof item === "string") || !env || (value.cwd !== undefined && typeof value.cwd !== "string")) return undefined
    return { name, source: "plugin", transport: "stdio", command: value.command, args: value.args.map(String), env, ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}) }
  }
  if (value.transport !== "remote" || typeof value.url !== "string") return undefined
  const headers = stringRecord(value.headers)
  return headers ? { name, source: "plugin", transport: "remote", url: value.url, headers } : undefined
}

export async function readAcpAgentPluginConfig(configFile: string): Promise<Record<string, AcpRuntimeMcpServer>> {
  const config: unknown = JSON.parse(await fs.readFile(configFile, "utf8"))
  if (!isRecord(config) || !isRecord(config.servers)) throw new Error("Materialized ACP plugin configuration is invalid")
  const servers: Record<string, AcpRuntimeMcpServer> = {}
  for (const [name, value] of Object.entries(config.servers)) {
    const server = acpServer(name, value)
    if (!server) throw new Error(`Materialized ACP plugin server ${name} is invalid`)
    servers[name] = server
  }
  return servers
}
