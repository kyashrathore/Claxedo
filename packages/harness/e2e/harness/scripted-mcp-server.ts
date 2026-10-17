import { createServer } from "node:http"
import { listenOnLoopback, releasePort, reservePort } from "./ports"

export type ScriptedMcpCall = { name: string; arguments: Record<string, unknown> }

export type ScriptedMcpTool = {
  name: string; description: string; inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>; _meta?: Record<string, unknown>
  result(args: Record<string, unknown>): unknown
}

export type ScriptedMcpResource = { uri: string; mimeType: string; text: string }

const PROOF_TOOL: ScriptedMcpTool = {
  name: "proof", description: "Return a local proof marker",
  inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
  result: (args) => ({ content: [{ type: "text", text: `MCP_PROOF:${typeof args.marker === "string" ? args.marker : ""}` }] }),
}

function listedTool({ name, description, inputSchema, annotations, _meta }: ScriptedMcpTool) {
  return { name, description, inputSchema, ...(annotations ? { annotations } : {}), ...(_meta ? { _meta } : {}) }
}

export async function startScriptedMcpServer(served: ScriptedMcpTool | readonly ScriptedMcpTool[] = PROOF_TOOL, resources: readonly ScriptedMcpResource[] = []) {
  const tools: readonly ScriptedMcpTool[] = Array.isArray(served) ? served : [served as ScriptedMcpTool]
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
      jsonrpc: string; id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; uri?: string }
    }
    methods.push(message.method ?? "notification")
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const called = message.method === "tools/call" ? tools.find((tool) => tool.name === message.params?.name) : undefined
    if (called) calls.push({ name: called.name, arguments: message.params?.arguments ?? {} })
    const resource = message.method === "resources/read" ? resources.find((item) => item.uri === message.params?.uri) : undefined
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {}, ...(resources.length ? { resources: {} } : {}) }, serverInfo: { name: "scripted-mcp", version: "1.0.0" } }
      : message.method === "tools/list"
        ? { tools: tools.map(listedTool) }
        : called
          ? failToolCall
            ? { isError: true, content: [{ type: "text", text: `Scripted MCP refused the ${called.name} call` }] }
            : called.result(message.params?.arguments ?? {})
          : resource
            ? { contents: [resource] }
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
