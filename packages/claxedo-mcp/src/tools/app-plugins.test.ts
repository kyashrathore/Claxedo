import { PI_MCP_COMMAND, PI_MCP_EXTENSION_SOURCE } from "../../../harness/src/transports/pi-rpc/mcp"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createClaxedoMcpClient } from "../client/index"
import type { AppPluginsGrant } from "../client/contract"
import { assertToolAccess, McpAccessDenied, type McpCredential } from "../context"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, mcpAuditRecord } from "../server"
import { registerAppPluginTools } from "./app-plugins"
import { APP_PLUGIN_GUIDE } from "./app-plugins-guide"
import { declaredToolAccess } from "./inventory"

const APP_PLUGIN_TOOLS = ["app_plugin_add", "app_plugin_check", "app_plugin_create", "app_plugin_guide"]

type Call = { method: keyof AppPluginsGrant; input: unknown }

function fakeGrant(overrides: Partial<AppPluginsGrant> = {}) {
  const calls: Call[] = []
  const grant: AppPluginsGrant = {
    allowed: () => true,
    create: async (input) => {
      calls.push({ method: "create", input })
      return { id: "standup-notes", name: "Standup notes", directory: "/w/.claxedo/plugins/standup-notes", files: ["package.json", "src/app.tsx"] }
    },
    check: async (directory) => {
      calls.push({ method: "check", input: directory })
      return { directory, ok: false, pluginId: "standup-notes", diagnostics: [{ stage: "typecheck", file: "src/app.tsx", line: 3, column: 5, code: "TS2322", message: "Type 'number' is not assignable to type 'string'." }] }
    },
    add: async (directory) => {
      calls.push({ method: "add", input: directory })
      return { id: "standup-notes", name: "Standup notes", directory, status: "ready", lastError: null }
    },
    ...overrides,
  }
  return { calls, grant }
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(appPlugins?: AppPluginsGrant) {
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
        ...(appPlugins ? { appPlugins } : {}),
      }),
    registerTools: [{ id: "app-plugins", reach: { service: "app-plugins" }, register: registerAppPluginTools }],
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

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

async function listed(client: Client) {
  return (await client.listTools()).tools.map((tool) => tool.name).toSorted()
}

describe("which sessions see the app plugin tools", () => {
  test("a session the composition granted authoring sees all four", async () => {
    const { url } = await listen(fakeGrant().grant)
    expect(await listed(await connect(url))).toEqual(APP_PLUGIN_TOOLS)
  })

  test("a session without the grant sees none, and a call by name is refused", async () => {
    const { url, audits } = await listen()
    const client = await connect(url)
    expect(await listed(client)).toEqual([])
    await expect(call(client, "app_plugin_add", { directory: "/w/.claxedo/plugins/x" })).rejects.toThrow("Method not found")
    expect(audits).toEqual([])
  })

  test("a person's account credential sees none even where the machine could grant them", async () => {
    const { url } = await listen(fakeGrant().grant)
    expect(await listed(await connect(url, "cli-jwt"))).toEqual([])
  })
})

describe("the handler-side authoring check", () => {
  const credential: McpCredential = { kind: "runtime", runtimeId: "rt_1", workspaceId: "ws_local", sessionId: "ses_caller", crossMachineWrites: false, readOnly: false }
  const access = declaredToolAccess({ audiences: ["runtime"], write: true, scope: "act", appPlugins: true })

  test("refuses a session the composition did not grant authoring, whatever tools/list showed", () => {
    expect(() => assertToolAccess(credential, "app_plugin_add", access)).toThrow(McpAccessDenied)
    expect(() => assertToolAccess(credential, "app_plugin_add", access, { appPlugins: false }))
      .toThrow("app_plugin_add makes app plugins on this machine, which only its owner's sessions may do")
  })

  test("refuses a read-only credential the write tools", () => {
    expect(() => assertToolAccess({ ...credential, readOnly: true }, "app_plugin_create", access, { appPlugins: true })).toThrow("is a write")
  })

  test("lets a granted session through", () => {
    expect(() => assertToolAccess(credential, "app_plugin_add", access, { appPlugins: true })).not.toThrow()
  })
})

describe("app_plugin_create", () => {
  test("scaffolds through the grant, returns the folder with the guide, and audits the write", async () => {
    const { calls, grant } = fakeGrant()
    const { url, audits } = await listen(grant)
    const result = await call(await connect(url), "app_plugin_create", { name: "Standup notes" })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ method: "create", input: { name: "Standup notes" } }])
    expect(result.text).toContain("Created the app plugin Standup notes (standup-notes) at /w/.claxedo/plugins/standup-notes: package.json, src/app.tsx.")
    expect(result.text).toContain(APP_PLUGIN_GUIDE)
    expect(audits).toEqual([{ tool: "app_plugin_create", actor: "runtime:rt_1", client: "runtime:rt_1", workspaceId: "ws_local", callerSessionId: "ses_caller" }])
  })

  test("passes a chosen folder through, and answers the grant's refusal as a tool error", async () => {
    const { calls, grant } = fakeGrant({
      create: async (input) => {
        calls.push({ method: "create", input })
        throw new Error("/etc/plugins is outside this session's workspace")
      },
    })
    const { url } = await listen(grant)
    const result = await call(await connect(url), "app_plugin_create", { name: "Notes", directory: "/etc/plugins" })
    expect(calls).toEqual([{ method: "create", input: { name: "Notes", directory: "/etc/plugins" } }])
    expect(result).toEqual({ isError: true, text: expect.stringContaining("/etc/plugins is outside this session's workspace") })
  })

  test("refuses a missing name before the grant is asked", async () => {
    const { calls, grant } = fakeGrant()
    const { url } = await listen(grant)
    const result = await call(await connect(url), "app_plugin_create", { name: "  " })
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })
})

describe("app_plugin_check", () => {
  test("returns the grant's diagnostics as structured JSON and writes nothing to the audit", async () => {
    const { calls, grant } = fakeGrant()
    const { url, audits } = await listen(grant)
    const result = await call(await connect(url), "app_plugin_check", { directory: "/w/.claxedo/plugins/standup-notes" })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toEqual({
      directory: "/w/.claxedo/plugins/standup-notes",
      ok: false,
      pluginId: "standup-notes",
      diagnostics: [{ stage: "typecheck", file: "src/app.tsx", line: 3, column: 5, code: "TS2322", message: "Type 'number' is not assignable to type 'string'." }],
    })
    expect(calls).toEqual([{ method: "check", input: "/w/.claxedo/plugins/standup-notes" }])
    expect(audits).toEqual([])
  })
})

describe("app_plugin_add", () => {
  test("registers through the grant and says the app asks the person before it runs", async () => {
    const { calls, grant } = fakeGrant()
    const { url, audits } = await listen(grant)
    const result = await call(await connect(url), "app_plugin_add", { directory: "/w/.claxedo/plugins/standup-notes" })
    expect(JSON.parse(result.text)).toEqual({
      id: "standup-notes",
      name: "Standup notes",
      directory: "/w/.claxedo/plugins/standup-notes",
      status: "ready",
      next: "The Claxedo app now asks the person to turn it on. It runs only after they confirm; every later save goes live.",
    })
    expect(calls).toEqual([{ method: "add", input: "/w/.claxedo/plugins/standup-notes" }])
    expect(audits.map((audit) => audit.tool)).toEqual(["app_plugin_add"])
  })

  test("a registration whose first build failed carries the error and says how it recovers", async () => {
    const { grant } = fakeGrant({
      add: async (directory) => ({ id: "standup-notes", name: "Standup notes", directory, status: "failed", lastError: "src/app.tsx:1:1: Unexpected end of file" }),
    })
    const { url } = await listen(grant)
    const result = JSON.parse((await call(await connect(url), "app_plugin_add", { directory: "/w/p" })).text) as Record<string, unknown>
    expect(result).toMatchObject({ status: "failed", lastError: "src/app.tsx:1:1: Unexpected end of file" })
    expect(result.next).toContain("fix the error below and save")
  })

  test("the daemon's refusal reaches the model as a tool error", async () => {
    const { grant } = fakeGrant({ add: async () => { throw new Error("A plugin with id standup-notes is already registered") } })
    const { url } = await listen(grant)
    expect(await call(await connect(url), "app_plugin_add", { directory: "/w/p" }))
      .toEqual({ isError: true, text: expect.stringContaining("already registered") })
  })
})

describe("app_plugin_guide", () => {
  test("answers the guide, which names the tools and the confirmation gate", async () => {
    const { url } = await listen(fakeGrant().grant)
    const result = await call(await connect(url), "app_plugin_guide")
    expect(result.text).toBe(APP_PLUGIN_GUIDE)
    for (const tool of ["app_plugin_create", "app_plugin_check", "app_plugin_add"]) expect(result.text).toContain(tool)
    expect(result.text).toContain("Only when the person asked")
  })
})

test("a connection opened before admission gains tools when admitted and loses all four when ownership changes", async () => {
  let allowed = false
  const fixture = fakeGrant({ allowed: () => allowed })
  const live = await listen(fixture.grant)
  const client = await connect(live.url)
  expect((await client.listTools()).tools).toEqual([])
  allowed = true
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(APP_PLUGIN_TOOLS)
  allowed = false
  expect((await client.listTools()).tools).toEqual([])
  const result = await client.callTool({ name: "app_plugin_guide", arguments: {} })
  expect(result.isError).toBe(true)
  expect(fixture.calls).toEqual([])
})


test("the emitted Pi extension calls the real MCP server", async () => {
  const fixture = fakeGrant()
  const { url } = await listen(fixture.grant)
  const entry = { name: "claxedo", url, headers: { Authorization: "Bearer rt-token" } }
  const extension = await import(`data:text/javascript;base64,${Buffer.from(PI_MCP_EXTENSION_SOURCE).toString("base64")}`)
  const commands = new Map<string, { handler(args: string): Promise<void> }>()
  const tools = new Map<string, { execute(id: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> }>()
  const events = new Map<string, () => Promise<void>>()
  let active = ["read"]
  extension.default({
    registerCommand: (name: string, value: { handler(args: string): Promise<void> }) => commands.set(name, value),
    registerTool: (tool: { name: string; execute(id: string, args: Record<string, unknown>): Promise<{ content: unknown[] }> }) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names },
    on: (name: string, callback: () => Promise<void>) => events.set(name, callback),
  })
  try {
    const handoff = path.join(await mkdtemp(path.join(tmpdir(), "pi-mcp-handoff-")), "server.json")
    await writeFile(handoff, JSON.stringify(entry), { mode: 0o600 })
    await commands.get(PI_MCP_COMMAND)!.handler(handoff)
    await expect(stat(handoff)).rejects.toThrow("ENOENT")
    await rm(path.dirname(handoff), { recursive: true })
    expect(active.toSorted()).toEqual(["read", ...APP_PLUGIN_TOOLS.map((name) => `mcp__claxedo__${name}`)].toSorted())
    expect((await tools.get("mcp__claxedo__app_plugin_guide")!.execute("guide", {})).content[0]).toMatchObject({ type: "text", text: APP_PLUGIN_GUIDE })
    await tools.get("mcp__claxedo__app_plugin_create")!.execute("call", { name: "Notes" })
    expect(fixture.calls).toEqual([{ method: "create", input: { name: "Notes" } }])
  } finally { await events.get("session_shutdown")!() }
})
