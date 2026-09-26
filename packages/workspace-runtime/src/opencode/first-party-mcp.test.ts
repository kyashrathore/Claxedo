import { expect, test } from "bun:test"
import type { OpenCodeHost } from "./host"
import { OpenCodeFirstPartyMcp } from "./first-party-mcp"

test("OpenCode routes tools through each session's own MCP credential and filters the model's catalog", async () => {
  const calls: string[] = []
  const endpoint = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const message = await request.json() as { id?: number; method: string }
    if (!message.id) return new Response(null, { status: 202 })
    const identity = request.headers.get("authorization")!
    let result: unknown = { protocolVersion: "2025-03-26" }
    if (message.method === "tools/list") result = { tools: identity === "owner" ? [{ name: "app_plugin_guide", description: "Guide", inputSchema: { type: "object" } }] : [] }
    if (message.method === "tools/call") {
      calls.push(identity)
      result = { content: [{ type: "text", text: "guide" }] }
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  } })
  type Tool = { name: string; execute(args: unknown, ctx: { sessionID: string }): Promise<unknown> }
  const tools = new Map<string, Tool>()
  let transform: (draft: { add(tool: Tool): void }) => void
  let filter: (input: { sessionID: string; tools: Record<string, unknown> }) => void
  let plugin: { setup(context: unknown): Promise<void> }
  const reload = async () => { tools.clear(); transform({ add: (tool) => tools.set(tool.name, tool) }) }
  const host = { client: async () => ({
    plugin: async (value: typeof plugin) => { plugin = value },
    model: { list: async () => {
      await plugin.setup({ location: { directory: "/work" },
        tool: { transform: async (callback: typeof transform) => { transform = callback }, reload },
        session: { hook: async (_name: string, callback: typeof filter) => { filter = callback } },
      })
    } },
  }) } as unknown as OpenCodeHost
  const bridge = new OpenCodeFirstPartyMcp(host, "workspace", "/work")
  const provider = { server: (id: string) => ({ name: "claxedo", url: `http://127.0.0.1:${endpoint.port}`, headers: { authorization: id } }) }
  const closeOwner = await bridge.connect("owner", provider)
  const closeMember = await bridge.connect("member", provider)
  try {
    const tool = tools.get("mcp__claxedo__app_plugin_guide")!
    expect(await tool.execute({}, { sessionID: "owner" })).toEqual({ content: "guide" })
    await expect(tool.execute({}, { sessionID: "member" })).rejects.toThrow("unavailable")
    const catalog: { sessionID: string; tools: Record<string, unknown> } = { sessionID: "member", tools: { mcp__claxedo__app_plugin_guide: {}, read: {} } }
    filter!(catalog)
    expect(catalog.tools).toEqual({ read: {} })
    expect(calls).toEqual(["owner"])
  } finally {
    await closeMember()
    await closeOwner()
    endpoint.stop(true)
  }
})
