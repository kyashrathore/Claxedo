import type { JsonValue } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { HarnessServices, McpServerSpec, StartInput } from "../../contract"
import { CodexTransportError } from "./errors"

function mcpConfig(server: McpServerSpec): Record<string, JsonValue> {
  if (server.kind === "stdio") return { command: server.command, args: [...(server.args ?? [])], env: server.env ?? {}, ...(server.cwd ? { cwd: server.cwd } : {}) }
  if (server.kind === "sse") throw new CodexTransportError("configuration", `Codex cannot load SSE MCP server ${server.name}`)
  return { url: server.url, http_headers: server.headers ?? {} }
}

export function projectCodexThreadConfig(input: StartInput, services: HarnessServices): Record<string, JsonValue> {
  const servers = [...input.projection.mcpServers]
  const first = input.locality === "local" ? services.firstPartyMcp(input.sessionId, input.locality) : undefined
  if (first) servers.push({ ...first, origin: "first-party" })
  const mcp = Object.fromEntries(servers.map((server) => [server.name, mcpConfig(server)]))
  if (Object.keys(mcp).length !== servers.length) throw new CodexTransportError("configuration", "Duplicate Codex MCP server name")
  return { features: { default_mode_request_user_input: true }, tools: { update_plan: { enabled: true } }, mcp_servers: mcp }
}
