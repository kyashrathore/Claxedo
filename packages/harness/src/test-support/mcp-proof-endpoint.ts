import type { McpServerSpec } from "../contract"

export const MCP_PROOF_TOOL = "mcp__claxedo__app_plugin_guide"

type ProofRequest = {
  id?: number
  method?: string
  tools?: { name?: string; function?: { name?: string } }[]
  messages?: { role?: string }[]
}

export type McpProofEndpoint = {
  baseURL: string
  offered: string[]
  called: (string | null)[]
  firstPartyMcp(sessionId: string): McpServerSpec
  stop(): void
}

function mcpAnswer(body: ProofRequest, request: Request, called: (string | null)[]): Response {
  if (!body.id) return new Response(null, { status: 202 })
  let result: unknown = { protocolVersion: "2025-03-26" }
  if (body.method === "tools/list") result = { tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] }
  if (body.method === "tools/call") {
    called.push(request.headers.get("authorization"))
    result = { content: [{ type: "text", text: "Use app_plugin_create to make a plugin." }] }
  }
  return Response.json({ jsonrpc: "2.0", id: body.id, result })
}

function modelAnswer(body: ProofRequest, offered: string[]): Response {
  offered.push(...(body.tools ?? []).flatMap((tool) => tool.function?.name ?? tool.name ?? []))
  const afterTool = (body.messages ?? []).some((message) => message.role === "tool")
  const delta = afterTool ? { role: "assistant", content: "MCP proof complete" } : {
    role: "assistant", tool_calls: [{ index: 0, id: "mcp_proof", type: "function", function: { name: MCP_PROOF_TOOL, arguments: "{}" } }],
  }
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ].map((chunk) => `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`).join("")
  return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

export function startMcpProofEndpoint(): McpProofEndpoint {
  const offered: string[] = []
  const called: (string | null)[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const body = await request.json() as ProofRequest
    return new URL(request.url).pathname === "/mcp" ? mcpAnswer(body, request, called) : modelAnswer(body, offered)
  } })
  const baseURL = `http://127.0.0.1:${server.port}`
  return {
    baseURL,
    offered,
    called,
    firstPartyMcp: (sessionId) => ({ kind: "http", name: "claxedo", url: `${baseURL}/mcp`, headers: { authorization: sessionId } }),
    stop: () => { void server.stop(true) },
  }
}
