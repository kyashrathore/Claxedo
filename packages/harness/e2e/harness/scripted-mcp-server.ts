import { createServer } from "node:http"
import { listenOnLoopback, releasePort, reservePort } from "./ports"

export type ScriptedMcpCall = { name: string; arguments: Record<string, unknown> }

export async function startScriptedMcpServer() {
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
    if (message.method === "tools/call" && message.params?.name === "proof") {
      calls.push({ name: "proof", arguments: message.params.arguments ?? {} })
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "scripted-mcp", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "proof", description: "Return a local proof marker", inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] } }] }
        : message.method === "tools/call" && message.params?.name === "proof"
          ? failToolCall
            ? { isError: true, content: [{ type: "text", text: "Scripted MCP refused the proof call" }] }
            : { content: [{ type: "text", text: `MCP_PROOF:${typeof message.params.arguments?.marker === "string" ? message.params.arguments.marker : ""}` }] }
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
