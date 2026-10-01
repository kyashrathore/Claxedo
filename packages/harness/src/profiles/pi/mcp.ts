import type { McpServerSpec } from "../../contract"
import { TransportError } from "../../contract/errors"

export type PiMcpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string; exposure: "direct" }
  | { type: "http"; url: string; headers: Record<string, string>; exposure: "direct" }

function literal(value: string): string {
  const escaped = value.replaceAll("$", () => "$$")
  return escaped.startsWith("!") ? `$${escaped}` : escaped
}

const literals = (values: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, literal(value)]))

export function piMcpServerConfig(server: McpServerSpec): PiMcpServerConfig {
  if (server.kind === "stdio") return { type: "stdio", command: server.command, args: [...server.args ?? []], env: literals(server.env),
    ...(server.cwd ? { cwd: server.cwd } : {}), exposure: "direct" }
  if (server.kind === "sse") throw new TransportError("pi", "configuration", `Pi cannot load SSE MCP server ${server.name}`)
  return { type: "http", url: server.url, headers: literals(server.headers), exposure: "direct" }
}
