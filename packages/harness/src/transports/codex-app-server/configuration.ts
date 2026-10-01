import type { JsonValue } from "./translate"
import type { HarnessServices, McpServerSpec, StartInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { sessionMcpServers } from "../../contract"

function mcpConfig(server: McpServerSpec): Record<string, JsonValue> {
  if (server.kind === "stdio") return { command: server.command, args: [...(server.args ?? [])], env: server.env ?? {}, ...(server.cwd ? { cwd: server.cwd } : {}) }
  if (server.kind === "sse") throw new CodexTransportError("configuration", `Codex cannot load SSE MCP server ${server.name}`)
  return { url: server.url, http_headers: server.headers ?? {} }
}

function codexPluginConfig(plugins: readonly string[]): Record<string, JsonValue> {
  return { model_reasoning_summary: "auto", plugins: Object.fromEntries(plugins.map((plugin) => [plugin, { enabled: true }])) }
}

export function projectCodexThreadConfig(input: StartInput, services: HarnessServices, plugins: readonly string[]): Record<string, JsonValue> {
  const servers = sessionMcpServers(input, services, { includeFirstParty: input.locality === "local",
    duplicate: () => new CodexTransportError("configuration", "Duplicate Codex MCP server name") })
  const mcp = Object.fromEntries(servers.map((server) => [server.name, mcpConfig(server)]))
  return { features: { default_mode_request_user_input: true }, tools: { update_plan: { enabled: true } }, ...codexPluginConfig(plugins), mcp_servers: mcp }
}
