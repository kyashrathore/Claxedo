import type { McpServerSpec } from "../../contract"
import { TransportError } from "../../contract/errors"
import { installPiExtension, runPiExtensionCommand } from "./extension"
import { piDeadline } from "./launch"
import type { PiRpc } from "./rpc"
import type { Clock } from "../../contract"

export const PI_MCP_COMMAND = "claxedo-mcp"
const EXTENSION_FILE = "claxedo-first-party-mcp.ts"

export const PI_MCP_EXTENSION_SOURCE = `const COMMAND = ${JSON.stringify(PI_MCP_COMMAND)}

async function connect(server) {
  let session
  let version = "2025-03-26"
  let sequence = 0
  const headers = () => ({ ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": version, ...(session ? { "mcp-session-id": session } : {}) })
  const post = async (body, signal) => {
    const response = await fetch(server.url, { method: "POST", headers: headers(), body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error("Claxedo MCP " + (body.method ?? "request") + " failed (" + response.status + ")")
    session = response.headers.get("mcp-session-id") ?? session
    return response.text()
  }
  const request = async (method, params, signal) => {
    const id = ++sequence
    const text = await post({ jsonrpc: "2.0", id, method, params }, signal)
    const records = text.includes("data:") ? text.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [text]
    const reply = records.filter(Boolean).map((record) => JSON.parse(record)).find((message) => message.id === id)
    if (!reply) throw new Error("Claxedo MCP " + method + " returned no reply")
    if (reply.error) throw new Error("Claxedo MCP " + method + ": " + reply.error.message)
    return reply.result
  }
  version = String((await request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "claxedo-pi", version: "1" } })).protocolVersion)
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  return {
    async tools() {
      const tools = []
      let cursor
      do {
        const page = await request("tools/list", cursor ? { cursor } : {})
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      return tools
    },
    call: (name, args, signal) => request("tools/call", { name, arguments: args }, signal),
    async close() {
      if (!session) return
      const response = await fetch(server.url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(10_000) })
      if (!response.ok && response.status !== 404) throw new Error("Claxedo MCP close failed (" + response.status + ")")
    },
  }
}

function content(block) {
  return block.type === "text" || block.type === "image" ? block : { type: "text", text: JSON.stringify(block) }
}

export default function (pi) {
  let connection
  pi.registerCommand(COMMAND, {
    description: "Connect this session's Claxedo tools",
    handler: async (args) => {
      if (connection) throw new Error("Claxedo MCP is already connected")
      const server = JSON.parse(args)
      connection = await connect(server)
      const names = []
      for (const tool of await connection.tools()) {
        const name = "mcp__" + server.name + "__" + tool.name
        names.push(name)
        pi.registerTool({ name, label: tool.name, description: tool.description || tool.name, parameters: tool.inputSchema,
          execute: async (_id, params, signal) => {
            const result = await connection.call(tool.name, params, signal)
            const blocks = (result.content ?? []).map(content)
            if (result.isError) throw new Error(blocks.map((block) => block.text ?? "").join("\\n"))
            return { content: blocks, details: {} }
          } })
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])])
    },
  })
  pi.on("session_shutdown", async () => { if (connection) await connection.close() })
}
`

export function installPiMcpExtension(stateRoot: string): Promise<string> {
  return installPiExtension(stateRoot, EXTENSION_FILE, PI_MCP_EXTENSION_SOURCE)
}

export async function connectPiMcp(rpc: PiRpc, clock: Clock, server: McpServerSpec): Promise<void> {
  if (server.kind === "stdio") throw new TransportError("pi", "configuration", "Claxedo's MCP server must be an HTTP entry")
  await runPiExtensionCommand(rpc, "Pi Claxedo MCP connection", PI_MCP_COMMAND,
    JSON.stringify({ name: server.name, url: server.url, headers: server.headers ?? {} }), piDeadline(clock))
}
