import { createServer } from "node:http"
import { listenOnLoopback, releasePort, reservePort } from "./ports"

export type ScriptedMcpCall = { name: string; arguments: Record<string, unknown> }

export type ScriptedMcpTool = { name: string; description: string; inputSchema: Record<string, unknown>; result(args: Record<string, unknown>): unknown }

const PROOF_TOOL: ScriptedMcpTool = {
  name: "proof", description: "Return a local proof marker",
  inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
  result: (args) => ({ content: [{ type: "text", text: `MCP_PROOF:${typeof args.marker === "string" ? args.marker : ""}` }] }),
}

export async function startScriptedMcpServer(tool: ScriptedMcpTool = PROOF_TOOL) {
  const port = await reservePort()
  const calls: ScriptedMcpCall[] = []
  const methods: string[] = []
  let failToolCall = false
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      jsonrpc: string; id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> }
    }
    methods.push(message.method ?? "notification")
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const called = message.method === "tools/call" && message.params?.name === tool.name
    if (called) calls.push({ name: tool.name, arguments: message.params?.arguments ?? {} })
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "scripted-mcp", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }] }
        : called
          ? failToolCall
            ? { isError: true, content: [{ type: "text", text: `Scripted MCP refused the ${tool.name} call` }] }
            : tool.result(message.params?.arguments ?? {})
          : undefined
    const body = result === undefined
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: message.id, result }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
  })
  try {
    await listenOnLoopback(server, port)
  } catch (error) {
    releasePort(port)
    throw error
  }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    methods,
    refuseToolCalls: () => { failToolCall = true },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { releasePort(port); resolve() })
    }),
  }
}
