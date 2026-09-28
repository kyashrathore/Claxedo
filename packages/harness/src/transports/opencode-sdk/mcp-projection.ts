import type { Mcp } from "@opencode-ai/plugin"
import { asArray, asRecordOrEmpty, isNonEmptyString } from "@claxedo/helpers/guards"
import { stringRecord } from "@claxedo/helpers"

function snapshotMcpServers(input: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  const servers: Record<string, Mcp.ServerConfig> = {}
  for (const [name, value] of Object.entries(input)) {
    const row = asRecordOrEmpty(value)
    const disabled = row.disabled === true ? { disabled: true } : {}
    const environment = stringRecord(row.env, { requireAllStrings: true })
    const headers = stringRecord(row.headers, { requireAllStrings: true })
    if (row.type === "stdio" && typeof row.command === "string" && row.command.length > 0) {
      servers[name] = { type: "local", command: [row.command, ...asArray(row.args).filter(isNonEmptyString)], ...(Object.keys(environment).length ? { environment } : {}), ...disabled }
      continue
    }
    if (row.type === "remote" && typeof row.url === "string" && row.url.length > 0) {
      servers[name] = { type: "remote", url: row.url, ...(Object.keys(headers).length ? { headers } : {}), ...disabled }
      continue
    }
    throw new Error(`OpenCode MCP server ${name} must be a stdio server with a command or a remote server with a url`)
  }
  return servers
}

function isPluginServerConfig(row: Record<string, unknown>): row is Record<string, unknown> & Mcp.ServerConfig {
  if (row.type === "local") return asArray(row.command).filter(isNonEmptyString).length > 0
  return row.type === "remote" && typeof row.url === "string" && row.url.length > 0
}

function pluginMcpServers(input: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  const servers: Record<string, Mcp.ServerConfig> = {}
  for (const [name, value] of Object.entries(input)) {
    const row = asRecordOrEmpty(value)
    if (!isPluginServerConfig(row)) {
      throw new Error(`Agent Plugins OpenCode MCP server ${name} must be a local or remote server`)
    }
    servers[name] = row
  }
  return servers
}

export function projectMcpServers(snapshot: Record<string, unknown>, plugins: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  return { ...snapshotMcpServers(snapshot), ...pluginMcpServers(plugins) }
}
