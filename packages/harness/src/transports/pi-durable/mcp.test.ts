import { expect, test } from "bun:test"
import { MCP_APP_MAX_BYTES, MCP_APP_MIME } from "@claxedo/agent-runtime-contract"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonRpcMessage } from "@earendil-works/pi-mcp"
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing"
import type { ProjectedMcpServer } from "../../contract"
import { PiMcpTools } from "./mcp"
import type { McpToolLists } from "./mcp-cache"

const APP_HTML = "<!doctype html><title>Weather</title><p>Sunny — 21°</p>"

type ServedTool = { name: string; _meta?: Record<string, unknown>; result?: Record<string, unknown> }

function tool(name: string, _meta?: Record<string, unknown>): ServedTool {
  return { name, ...(_meta ? { _meta } : {}) }
}

function scriptedServer(tools: ServedTool[], resources: Record<string, unknown[]>) {
  const initializations: Record<string, unknown>[] = []
  const calls: string[] = []
  const reads: string[] = []
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    if (method === "initialize") {
      initializations.push(params)
      return { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "scripted", version: "1" } }
    }
    if (method === "tools/list") return { tools: tools.map(({ name, _meta }) => ({ name, inputSchema: { type: "object" }, ...(_meta ? { _meta } : {}) })) }
    if (method === "tools/call") {
      calls.push(String(params.name))
      return tools.find((served) => served.name === params.name)?.result ?? { content: [{ type: "text", text: `ran ${String(params.name)}` }] }
    }
    if (method === "resources/read") {
      reads.push(String(params.uri))
      return { contents: resources[String(params.uri)] ?? [] }
    }
    return undefined
  }
  const connect = async () => {
    const pair = createInMemoryTransportPair()
    pair.server.onMessage((message: JsonRpcMessage) => {
      if (!("method" in message) || !("id" in message)) return
      const result = answer(message.method, (message.params ?? {}) as Record<string, unknown>)
      void pair.server.send(result === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: message.id, result } as JsonRpcMessage)
    })
    await pair.server.start()
    return pair.client
  }
  return { initializations, calls, reads, connect }
}

const SERVER: ProjectedMcpServer = { kind: "http", name: "weather", url: "http://weather.test/mcp", origin: "configured" }

function piTools(server: ReturnType<typeof scriptedServer>) {
  const unavailable: string[] = []
  let cache: McpToolLists = {}
  const tools = new PiMcpTools({
    connect: server.connect,
    failed: (name, error) => { throw new Error(`${name} failed: ${String(error)}`) },
    appUnavailable: (_server, _tool, reason) => { unavailable.push(reason) },
    cached: async () => cache,
    record: async (_key, lists) => { cache = lists },
  })
  return { tools, unavailable }
}

const appResource = (text: string, mimeType = MCP_APP_MIME) => [{ uri: "ui://weather/app", mimeType, text,
  _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] }, prefersBorder: true } } }]

async function run(tools: PiMcpTools, name: string) {
  const registered = await tools.tools([SERVER], "k")
  const found = registered.find((candidate) => candidate.name === `mcp__weather__${name}`)
  if (!found) throw new Error(`${name} is not offered`)
  return await found.execute({}, {} as never, BACKGROUND_CONTEXT)
}

test("Pi advertises the MCP Apps extension and keeps a ui tool's result facts with the app's document as one snapshot", async () => {
  const server = scriptedServer([{ ...tool("forecast", { ui: { resourceUri: "ui://weather/app" } }),
    result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temperature: 21 }, _meta: { requestId: "r1" } } }],
  { "ui://weather/app": appResource(APP_HTML) })
  const { tools, unavailable } = piTools(server)

  const result = await run(tools, "forecast")

  expect(server.initializations[0]?.capabilities).toEqual({ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } })
  expect(result.content).toEqual([{ type: "text", text: "Sunny" }])
  expect(result.details).toEqual({
    mcp: {
      server: "weather", tool: "forecast", resultMeta: { requestId: "r1" }, structuredContent: { temperature: 21 },
      app: { resourceUri: "ui://weather/app", csp: { connectDomains: ["https://api.weather.test"] }, prefersBorder: true },
    },
    appDocument: `data:${MCP_APP_MIME};base64,${Buffer.from(APP_HTML).toString("base64")}`,
  })
  expect(server.reads).toEqual(["ui://weather/app"])
  expect(unavailable).toEqual([])
  await tools.close()
})

test("an oversized or wrong-type app document leaves the tool's ordinary result and says why", async () => {
  const server = scriptedServer([tool("big", { ui: { resourceUri: "ui://weather/big" } }), tool("plain", { ui: { resourceUri: "ui://weather/plain" } })], {
    "ui://weather/big": appResource("x".repeat(MCP_APP_MAX_BYTES + 1)),
    "ui://weather/plain": appResource(APP_HTML, "text/html"),
  })
  const { tools, unavailable } = piTools(server)

  const big = await run(tools, "big")
  const plain = await run(tools, "plain")

  expect(big.details).toEqual({ mcp: { server: "weather", tool: "big" } })
  expect(plain.details).toEqual({ mcp: { server: "weather", tool: "plain" } })
  expect(unavailable).toEqual(["ui://weather/big exceeds the size limit", `ui://weather/plain has no ${MCP_APP_MIME} content`])
  await tools.close()
})

test("a tool hidden from the model is not offered to the agent, and an app may call only tools visible to apps", async () => {
  const server = scriptedServer([
    tool("refresh", { ui: { visibility: ["app"] } }),
    tool("summarize", { ui: { visibility: ["model"] } }),
    tool("forecast"),
  ], {})
  const { tools } = piTools(server)

  expect((await tools.tools([SERVER], "k")).map((registered) => registered.name)).toEqual(["mcp__weather__summarize", "mcp__weather__forecast"])
  expect(await tools.listTools("weather")).toMatchObject({ ok: true, tools: [{ name: "refresh", _meta: { ui: { visibility: ["app"] } } }, { name: "summarize" }, { name: "forecast" }] })

  expect(await tools.callTool({ server: "weather", tool: "summarize", arguments: {} })).toMatchObject({ ok: false, status: "refused" })
  expect(await tools.callTool({ server: "weather", tool: "refresh", arguments: { city: "Oslo" } }))
    .toEqual({ ok: true, result: { content: [{ type: "text", text: "ran refresh" }] } })
  expect(await tools.callTool({ server: "weather", tool: "missing", arguments: {} })).toMatchObject({ ok: false, status: "not_found" })
  expect(await tools.callTool({ server: "elsewhere", tool: "refresh", arguments: {} })).toMatchObject({ ok: false, status: "not_found" })
  expect(server.calls).toEqual(["refresh"])
  await tools.close()
})

test("an app reads its server's resources over the session's connection", async () => {
  const server = scriptedServer([tool("forecast")], { "ui://weather/app": appResource(APP_HTML) })
  const { tools } = piTools(server)
  await tools.tools([SERVER], "k")

  expect(await tools.readResource({ server: "weather", uri: "ui://weather/app" })).toEqual({ ok: true, result: { contents: appResource(APP_HTML) } })
  expect(await tools.readResource({ server: "elsewhere", uri: "ui://weather/app" })).toMatchObject({ ok: false, status: "not_found" })
  await tools.close()
})
