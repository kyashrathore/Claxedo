/**
 * A model endpoint and a Claxedo MCP server on one port, for proving that a
 * real native harness lists and calls a first-party MCP tool. The model asks
 * for `mcp__claxedo__app_plugin_guide` once, then answers "MCP proof complete".
 */
export function startMcpProofEndpoint() {
  const offered = []
  const called = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const body = await request.json()
    if (new URL(request.url).pathname === "/mcp") {
      if (!body.id) return new Response(null, { status: 202 })
      let result = { protocolVersion: "2025-03-26" }
      if (body.method === "tools/list") result = { tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] }
      if (body.method === "tools/call") {
        called.push(request.headers.get("authorization"))
        result = { content: [{ type: "text", text: "Use app_plugin_create to make a plugin." }] }
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result })
    }
    offered.push(...(body.tools ?? []).map((tool) => tool.function?.name ?? tool.name))
    const afterTool = (body.messages ?? []).some((message) => message.role === "tool")
    const delta = afterTool ? { role: "assistant", content: "MCP proof complete" } : {
      role: "assistant", tool_calls: [{ index: 0, id: "mcp_proof", type: "function", function: { name: MCP_PROOF_TOOL, arguments: "{}" } }],
    }
    const chunks = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ].map((chunk) => `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`).join("")
    return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const baseURL = `http://127.0.0.1:${server.port}`
  return {
    baseURL,
    offered,
    called,
    firstPartyMcp: { server: (sessionId) => ({ name: "claxedo", url: `${baseURL}/mcp`, headers: { authorization: sessionId } }) },
    stop: () => server.stop(true),
  }
}

export const MCP_PROOF_TOOL = "mcp__claxedo__app_plugin_guide"
