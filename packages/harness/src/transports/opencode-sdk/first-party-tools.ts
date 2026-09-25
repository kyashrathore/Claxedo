import type { McpServerSpec } from "../../contract"
import { isRecord } from "@claxedo/helpers/guards"
import type { SessionTool, SessionToolCall } from "./tool-port.js"
import { OpenCodeTransportError } from "./errors.js"

function mcpRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new OpenCodeTransportError("configuration", "Invalid first-party MCP response")
  return value
}

function mcpReply(body: string, id: number): unknown {
  const records = body.startsWith("data:") || body.includes("\ndata:")
    ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [body]
  const message = records.map((record) => mcpRecord(JSON.parse(record) as unknown)).find((item) => item.id === id)
  if (!message) throw new OpenCodeTransportError("configuration", "First-party MCP omitted its reply")
  if (message.error) {
    const error = mcpRecord(message.error)
    throw new OpenCodeTransportError("configuration", `First-party MCP: ${typeof error.message === "string" ? error.message : "request failed"}`)
  }
  return message.result
}

function mcpTool(value: unknown): SessionTool {
  const row = mcpRecord(value)
  if (typeof row.name !== "string" || typeof row.description !== "string") {
    throw new OpenCodeTransportError("configuration", "Invalid first-party MCP tool")
  }
  return { name: row.name, description: row.description, inputSchema: mcpRecord(row.inputSchema),
    ...(row.outputSchema ? { outputSchema: mcpRecord(row.outputSchema) } : {}) }
}

export async function firstPartyTools(server: McpServerSpec, sessionId: string): Promise<{
  tools: readonly SessionTool[]
  execute(call: SessionToolCall): Promise<unknown>
}> {
  if (server.kind !== "http" || !server.headers?.Authorization || new URL(server.url).searchParams.get("session") !== sessionId) {
    throw new OpenCodeTransportError("configuration", "First-party MCP must carry this session's authenticated HTTP entry")
  }
  const { url, headers } = server
  let nextId = 0
  let mcpSession: string | undefined
  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++nextId
    const response = await fetch(url, { method: "POST", headers: {
      ...headers, "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
    if (!response.ok) throw new OpenCodeTransportError("configuration", `First-party MCP ${method} failed (${response.status})`)
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession
    return mcpReply(await response.text(), id)
  }
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "claxedo-opencode", version: "1" } })
  const tools: SessionTool[] = []
  let cursor: string | undefined
  do {
    const listed = mcpRecord(await request("tools/list", cursor ? { cursor } : {}))
    if (!Array.isArray(listed.tools)) throw new OpenCodeTransportError("configuration", "First-party MCP omitted its tools")
    tools.push(...listed.tools.map((item: unknown) => mcpTool(item)))
    if (listed.nextCursor !== undefined && typeof listed.nextCursor !== "string") {
      throw new OpenCodeTransportError("configuration", "First-party MCP returned an invalid cursor")
    }
    cursor = listed.nextCursor
  } while (cursor)
  return { tools, execute: (call) => request("tools/call", { name: call.name, arguments: call.input }) }
}
