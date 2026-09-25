import type { Mcp } from "@opencode-ai/plugin"
import { asArray, asRecordOrEmpty, isNonEmptyString } from "@claxedo/helpers/guards"

function stringRecord(input: unknown): Record<string, string> | undefined {
  const row = asRecordOrEmpty(input)
  const entries = Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length === Object.keys(row).length && entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function snapshotMcpServers(input: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  const servers: Record<string, Mcp.ServerConfig> = {}
  for (const [name, value] of Object.entries(input)) {
    const row = asRecordOrEmpty(value)
    const disabled = row.disabled === true ? { disabled: true } : {}
    const environment = stringRecord(row.env)
    const headers = stringRecord(row.headers)
    if (row.type === "stdio" && typeof row.command === "string" && row.command.length > 0) {
      servers[name] = { type: "local", command: [row.command, ...asArray(row.args).filter(isNonEmptyString)], ...(environment ? { environment } : {}), ...disabled }
      continue
    }
    if (row.type === "remote" && typeof row.url === "string" && row.url.length > 0) {
      servers[name] = { type: "remote", url: row.url, ...(headers ? { headers } : {}), ...disabled }
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
