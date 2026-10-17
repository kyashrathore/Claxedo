import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { surfaceComponentSchema } from "@claxedo/plugin-api/surface"
import { createClaxedoMcpClient } from "../client/index"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, mcpAuditRecord } from "../server"
import { registerSurfaceTools } from "./surfaces"

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen() {
  const audits: Array<Record<string, unknown>> = []
  const routes = createClaxedoMcpRoutes({
    mount: "node",
    verifyRuntimeCredential: (token) =>
      token === "rt-token"
        ? { runtimeId: "rt_1", workspaceId: "ws_local", sessionId: "ses_caller", expiresAt: Number.MAX_SAFE_INTEGER }
        : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    createClient: () =>
      createClaxedoMcpClient({
        deployment: "node",
        local: { fetch: async () => new Response(null, { status: 404 }), workspace: { workspaceId: "ws_local", directory: "/w" } },
      }),
    registerTools: [{ id: "surfaces", reach: "runtime", register: registerSurfaceTools }],
    audit: (event) => void audits.push(mcpAuditRecord(event)),
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`, audits }
}

async function connect(url: string, token = "rt-token") {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function show(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "ui_show", arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

const metrics = {
  title: "Build health",
  components: [
    { id: "root", component: "Column", children: ["heading", "rows", "rerun"] },
    { id: "heading", component: "Text", text: "Last 7 days", variant: "h3" },
    { id: "rows", component: "List", children: { componentId: "row", path: "/jobs" } },
    { id: "row", component: "Text", text: { path: "name" } },
    { id: "rerun", component: "Button", child: "rerun-label", action: { event: { name: "rerun", context: { job: { path: "/jobs/0/name" } } } } },
    { id: "rerun-label", component: "Text", text: "Rerun the slowest" },
  ],
  data: { jobs: [{ name: "lint" }, { name: "unit" }] },
}

describe("ui_show", () => {
  test("is listed inside a session and never to a person's account", async () => {
    const { url } = await listen()
    const listed = async (token: string) => (await (await connect(url, token)).listTools()).tools.map((tool) => tool.name)
    expect(await listed("rt-token")).toEqual(["ui_show"])
    expect(await listed("cli-jwt")).toEqual([])
  })

  test("publishes every catalog component with its props in the input schema", async () => {
    const { url } = await listen()
    const tool = (await (await connect(url)).listTools()).tools.find((candidate) => candidate.name === "ui_show")
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(tool?.inputSchema.required).toEqual(["title", "components"])
    const components = tool?.inputSchema.properties?.components as { items: { oneOf: Array<{ properties: Record<string, { const?: string }>; required: string[] }> } }
    const variants = components.items.oneOf
    expect(variants.map((variant) => variant.properties.component?.const))
      .toEqual(surfaceComponentSchema.options.map((option) => option.shape.component.value))
    const button = variants.find((variant) => variant.properties.component?.const === "Button")
    expect(button?.required).toEqual(expect.arrayContaining(["id", "component", "child", "action"]))
    for (const name of surfaceComponentSchema.options.map((option) => option.shape.component.value)) expect(tool?.description).toContain(name)
  })

  test("answers a valid spec with what it showed, and writes no audit", async () => {
    const { url, audits } = await listen()
    expect(await show(await connect(url), metrics)).toEqual({ isError: false, text: 'Shown "Build health" with 6 components.' })
    expect(audits).toEqual([])
  })

  test("refuses a dangling child and a missing root with each problem's JSON Pointer", async () => {
    const { url } = await listen()
    const client = await connect(url)
    const dangling = await show(client, { ...metrics, components: metrics.components.filter((component) => component.id !== "rerun-label") })
    expect(dangling).toEqual({ isError: true, text: "/components/4/child: no component has the id rerun-label" })
    const rootless = await show(client, { title: "No root", components: [{ id: "top", component: "Card", child: "body" }, { id: "body", component: "Text", text: "hi" }] })
    expect(rootless).toEqual({ isError: true, text: "/components: no component has the id root" })
  })

  test("refuses a component outside the catalog before the handler runs", async () => {
    const { url } = await listen()
    const client = await connect(url)
    for (const component of ["Image", "Modal"]) {
      const refused = await show(client, { title: "Outside", components: [{ id: "root", component, url: "https://example.com/a.png" }] })
      expect(refused.isError).toBe(true)
      expect(refused.text).toMatch(/Input validation error/)
      expect(refused.text).toContain("components")
    }
  })
})
