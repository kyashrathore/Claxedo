import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { PluginToolsListing } from "@claxedo/plugin-api/tools"
import type { ClaxedoMcpClient, McpServiceGrant } from "./client/contract"
import { APP_PLUGIN_TOOLS_SERVICE, appPluginToolGroups, pluginToolResult } from "./plugin-proxy"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, type ClaxedoMcpMountOptions, type McpToolGroup } from "./server"

const NOTE_LIST = {
  name: "note_list",
  title: "List notes",
  description: "Lists the notes",
  inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: ["limit"] },
  access: "read" as const,
}
const NOTE_ADD = { ...NOTE_LIST, name: "note_add", description: "Adds a note", inputSchema: { type: "object", properties: { text: { type: "string" } } }, access: "write" as const }

const CORE: McpToolGroup = {
  id: "core",
  reach: "runtime",
  register: (registry) => registry.tool("core_ping", { description: "core", inputSchema: {}, access: { audiences: ["runtime", "user"], write: false, scope: "read" } }, async () => ({ content: [{ type: "text", text: "core" }] })),
}

type Call = { path: string; agent: unknown; body: unknown }

function grantOver(listings: readonly PluginToolsListing[], answer: (call: Call) => Response = () => Response.json({ content: [{ type: "text", text: "ok" }] })) {
  const calls: Call[] = []
  const grant: McpServiceGrant = {
    operations: ["call"],
    fetch: async (path, init) => {
      if (path === "/api/claxedo/app-plugins/tools") return Response.json(listings)
      const call = { path, agent: JSON.parse(new Headers(init?.headers).get("x-claxedo-agent") ?? "null"), body: JSON.parse(typeof init?.body === "string" ? init.body : "null") }
      calls.push(call)
      return answer(call)
    },
  }
  return { grant, calls }
}

function clientWith(grant: McpServiceGrant | undefined): ClaxedoMcpClient {
  return {
    deployment: "loopback",
    runtime: async () => async () => new Response(null, { status: 204 }),
    services: grant ? { [APP_PLUGIN_TOOLS_SERVICE.id]: grant } : {},
    ownerDriven: () => true,
    resolveTarget: async () => ({ kind: "loopback", baseUrl: "", headers: {} }),
    server: () => Promise.reject(new Error("no typed client in this fixture")),
    workspaces: async () => [],
  }
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function connect(options: Pick<ClaxedoMcpMountOptions, "mount" | "createClient"> & Partial<ClaxedoMcpMountOptions>, token: string) {
  const routes = createClaxedoMcpRoutes({
    registerTools: [CORE],
    audit: () => undefined,
    pluginToolGroups: appPluginToolGroups,
    ...options,
  })
  const server = serve({ fetch: new Hono().route(CLAXEDO_MCP_PATH, routes.routes).fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

const sandbox = (grant: McpServiceGrant | undefined, enabled: readonly string[]) =>
  connect({
    mount: "loopback",
    verifyRuntimeCredential: (token) => (token === "rt" ? { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1", userId: "usr_1", expiresAt: Number.MAX_SAFE_INTEGER } : undefined),
    enabledToolGroups: () => enabled,
    createClient: () => clientWith(grant),
  }, "rt")

const account = (grant: McpServiceGrant | undefined) =>
  connect({
    mount: "hosted",
    resolveUserCredential: async () => fullUserCredential({ actorId: "actor_1", clientId: "cli" }),
    createClient: () => clientWith(grant),
  }, "cli")

const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).toSorted()

describe("an app plugin's proxy tools", () => {
  test("are listed for a plugin the grant lists while its group is enabled, with the declared input schema", async () => {
    const { grant } = grantOver([{ pluginId: "notes", label: "Notes", tools: [NOTE_LIST, NOTE_ADD] }])
    const client = await sandbox(grant, ["core", "app-plugin:notes"])
    const listed = (await client.listTools()).tools
    expect(listed.map((tool) => tool.name).toSorted()).toEqual(["core_ping", "note_add", "note_list"])
    expect(listed.find((tool) => tool.name === "note_list")?.inputSchema).toMatchObject({ type: "object", properties: { limit: { type: "number" } }, required: ["limit"] })
    expect(listed.find((tool) => tool.name === "note_add")?.annotations).toMatchObject({ readOnlyHint: false })
  })

  test("are absent when the plugin's group is not enabled, when the grant lists no such plugin, and when the client carries no grant", async () => {
    expect(await names(await sandbox(grantOver([{ pluginId: "notes", label: "Notes", tools: [NOTE_LIST] }]).grant, ["core"]))).toEqual(["core_ping"])
    expect(await names(await sandbox(grantOver([]).grant, ["core", "app-plugin:notes"]))).toEqual(["core_ping"])
    expect(await names(await sandbox(undefined, ["core", "app-plugin:notes"]))).toEqual(["core_ping"])
    expect(await names(await account(grantOver([{ pluginId: "notes", label: "Notes", tools: [NOTE_LIST] }]).grant))).toEqual(["core_ping", "note_list"])
    expect(await names(await account(undefined))).toEqual(["core_ping"])
  })

  test("never replace a tool another group registered first", async () => {
    const shadow = { ...NOTE_LIST, name: "core_ping", description: "a plugin's core_ping" }
    const { grant, calls } = grantOver([{ pluginId: "notes", label: "Notes", tools: [shadow] }, { pluginId: "other", label: "Other", tools: [NOTE_LIST, { ...NOTE_LIST, description: "a second note_list" }] }])
    const client = await sandbox(grant, ["core", "app-plugin:notes", "app-plugin:other"])
    const listed = (await client.listTools()).tools
    expect(listed.map((tool) => [tool.name, tool.description])).toEqual([["core_ping", "core"], ["note_list", "Lists the notes"]])
    expect(await client.callTool({ name: "core_ping", arguments: {} })).toEqual({ content: [{ type: "text", text: "core" }] })
    expect(calls).toEqual([])
  })

  test("a call posts its arguments to the plugin's tool path with the session it came from, and answers the backend's tool result", async () => {
    const { grant, calls } = grantOver([{ pluginId: "notes", label: "Notes", tools: [NOTE_LIST] }], (call) =>
      Response.json({ content: [{ type: "text", text: JSON.stringify(call.body) }] }))
    const client = await sandbox(grant, ["core", "app-plugin:notes"])
    expect(await client.callTool({ name: "note_list", arguments: { limit: 3 } })).toEqual({ content: [{ type: "text", text: JSON.stringify({ arguments: { limit: 3 } }) }] })
    expect(calls).toEqual([{ path: "/api/plugins/notes/_tools/note_list", agent: { sessionId: "ses_1", ownerDriven: true }, body: { arguments: { limit: 3 } } }])
  })
})

describe("a backend's answer to a tool call", () => {
  test("is refused when it holds more than 256 KiB, whatever its shape", async () => {
    const big = JSON.stringify({ content: [{ type: "text", text: "x".repeat(256 * 1024) }] })
    expect(await pluginToolResult("note_list", new Response(big))).toEqual({ isError: true, content: [{ type: "text", text: "note_list answered more than 256 KiB" }] })
    const fits = JSON.stringify({ content: [{ type: "text", text: "x".repeat(256 * 1024 - 64) }] })
    expect((await pluginToolResult("note_list", new Response(fits))).isError).toBeUndefined()
  })

  test("is refused when it is not an MCP tool result, and a refusal from the host reads its message", async () => {
    for (const body of ["not json", JSON.stringify({ text: "x" }), JSON.stringify({ content: [{ type: "audio", data: "" }] })]) {
      expect(await pluginToolResult("note_list", new Response(body)), body).toEqual({ isError: true, content: [{ type: "text", text: "note_list answered something that is not a tool result" }] })
    }
    const refused = Response.json({ error: { code: "plugin_not_enabled", message: "Plugin notes is not enabled for you" } }, { status: 404 })
    expect(await pluginToolResult("note_list", refused)).toEqual({ isError: true, content: [{ type: "text", text: "Plugin notes is not enabled for you" }] })
    expect(await pluginToolResult("note_list", new Response("", { status: 502 }))).toEqual({ isError: true, content: [{ type: "text", text: "note_list failed" }] })
  })
})
