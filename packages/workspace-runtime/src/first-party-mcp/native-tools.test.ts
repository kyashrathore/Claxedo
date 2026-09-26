import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { OpenCodeSdkHarnessAdapter } from "../opencode/harness-adapter"
import { createOpenCodeRuntime } from "../opencode/runtime"

for (const harness of ["pi", "opencode"] as const) {
  test.skipIf(harness === "pi" && process.env.CLAXEDO_TEST_NATIVE_PI !== "1")(`${harness} lists and executes a Claxedo MCP tool through its real native harness`, async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-${harness}-mcp-`)))
    const toolName = "mcp__claxedo__app_plugin_guide"
    const offered: string[] = []
    const called: string[] = []
    const endpoint = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      const body = await request.json() as Record<string, any>
      if (new URL(request.url).pathname === "/mcp") {
        if (!body.id) return new Response(null, { status: 202 })
        let result: unknown = { protocolVersion: "2025-03-26" }
        if (body.method === "tools/list") result = { tools: [{ name: "app_plugin_guide", description: "Read the app plugin guide", inputSchema: { type: "object", properties: {} } }] }
        if (body.method === "tools/call") {
          called.push(request.headers.get("authorization")!)
          result = { content: [{ type: "text", text: "Use app_plugin_create to make a plugin." }] }
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result })
      }
      offered.push(...(body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name))
      const afterTool = (body.messages ?? []).some((message: any) => message.role === "tool")
      const delta = afterTool ? { role: "assistant", content: "MCP proof complete" } : {
        role: "assistant", tool_calls: [{ index: 0, id: "mcp_proof", type: "function", function: { name: toolName, arguments: "{}" } }],
      }
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ].map((chunk) => `data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`).join("")
      return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    } })
    const baseURL = `http://127.0.0.1:${endpoint.port}`
    const store = createMemoryRuntimeStore()
    const engine = harness === "opencode" ? createOpenCodeRuntime({ databasePath: path.join(directory, "opencode.db"), configContent: JSON.stringify({
      model: "proof/proof", small_model: "proof/proof", enabled_providers: ["proof"],
      provider: { proof: { npm: "@ai-sdk/openai-compatible", models: { proof: { name: "Proof", limit: { context: 32000, output: 1024 } } }, options: { baseURL: `${baseURL}/v1`, apiKey: "proof" } } },
    }) }) : undefined
    const adapter = engine
      ? new OpenCodeSdkHarnessAdapter({ runtime: engine, workspaceID: "proof", directory, reportOwnerFailure: () => {} })
      : new PiHarnessAdapter({ store, agentDir: path.join(directory, "pi") })
    const model = harness === "pi" ? { providerID: "pi", modelID: "groq/llama-3.1-8b-instant" } : { providerID: "proof", modelID: "proof" }
    try {
      await adapter.applyConfig({
        mcp: {}, auth: harness === "pi" ? { groq: { baseUrl: baseURL, apiPath: "/v1", placeholder: "proof", authMode: "bearer", expiresAt: Date.now() + 60_000 } } : {},
        firstPartyMcp: { server: (sessionId: string) => ({ name: "claxedo", url: `${baseURL}/mcp`, headers: { authorization: sessionId } }) },
      })
      if (adapter instanceof PiHarnessAdapter) adapter.setModel(model.modelID)
      const session = await adapter.createSession(directory, "MCP proof")
      const events = []
      for await (const event of adapter.executeTurn({ workspaceId: "proof", directory, sessionId: session.id, upstreamSessionId: store.getAgentSessionId(session.id) ?? session.id, connectionId: `native:${harness}` }, {
        parts: [{ type: "text", text: "Read the Claxedo app plugin guide" }], agent: "build", model, assistantMessageId: "proof-turn",
      })) events.push(event)
      expect(offered).toContain(toolName)
      expect(called).toEqual([session.id])
      expect(JSON.stringify(events)).toContain("MCP proof complete")
    } finally {
      await adapter.dispose()
      await engine?.close()
      endpoint.stop(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
}
