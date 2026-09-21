import { afterEach, describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { ClaxedoMcpClient } from "./client/contract"
import type { McpAuditEvent } from "./context"
import {
  CLAXEDO_MCP_PATH,
  CLAXEDO_MCP_SERVER_INFO,
  CLAXEDO_MCP_TOOL_GROUP_IDS,
  CLAXEDO_MCP_TOOL_GROUPS,
  claxedoMcpToolGroupInventory,
  createClaxedoMcpRoutes,
  fullUserCredential,
  type ClaxedoMcpMountOptions,
  type McpToolGroup,
} from "./server"

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version

const stubClient: ClaxedoMcpClient = {
  deployment: "loopback",
  runtime: async () => async () => new Response(null, { status: 204 }),
  resolveTarget: async () => ({ kind: "loopback", baseUrl: "", headers: {} }),
  server: () => Promise.reject(new Error("no typed client in this fixture")),
  workspaces: async () => [],
}

const runtimeClaims = { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_parent", userId: "user_1", expiresAt: Number.MAX_SAFE_INTEGER }

/** Two audiences, one write with a session, one destructive, one that waits. */
function fixtureTools(gate: { release?: () => void }): McpToolGroup {
  return { id: "fixture", reach: "runtime", register: (registry) => {
    registry.tool("runtime_ping", {
      description: "runtime only",
      inputSchema: {},
      access: { audiences: ["runtime"], write: false, scope: "read" },
    }, async (_args, ctx) => ({ content: [{ type: "text", text: `runtime:${ctx.credential.kind}` }] }))
    registry.tool("user_ping", {
      description: "user only",
      inputSchema: {},
      access: { audiences: ["user"], write: false, scope: "read" },
    }, async (_args, ctx) => ({ content: [{ type: "text", text: `user:${ctx.credential.kind}` }] }))
    registry.tool("session_send", {
      description: "a write addressed to a session",
      inputSchema: { session: z.string(), text: z.string() },
      access: { audiences: ["runtime", "user"], write: true, scope: "act" },
      sessionIdOf: (args) => args.session,
    }, async (args) => ({ content: [{ type: "text", text: `sent:${args.session}` }] }))
    registry.tool("workspace_destroy", {
      description: "destructive",
      inputSchema: { workspace: z.string() },
      access: { audiences: ["user"], write: true, scope: "admin", destructive: true },
    }, async (args) => ({ content: [{ type: "text", text: `destroyed:${args.workspace}` }] }))
    registry.tool("wait", {
      description: "holds the request open",
      inputSchema: {},
      access: { audiences: ["runtime", "user"], write: false, scope: "read" },
    }, async () => {
      await new Promise<void>((resolve) => { gate.release = resolve })
      return { content: [{ type: "text", text: "released" }] }
    })
  } }
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(options: Partial<ClaxedoMcpMountOptions> & Pick<ClaxedoMcpMountOptions, "mount">) {
  const gate: { release?: () => void } = {}
  const audits: McpAuditEvent[] = []
  const routes = createClaxedoMcpRoutes({
    createClient: () => stubClient,
    registerTools: [fixtureTools(gate)],
    audit: (event) => { audits.push(event) },
    ...options,
  })
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  mounts.push(routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const url = `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`
  return { url, app, gate, audits }
}

const loopback = (options: Partial<ClaxedoMcpMountOptions> = {}) =>
  listen({
    mount: "loopback",
    verifyRuntimeCredential: (token) => token === "rt-token" ? runtimeClaims : undefined,
    enabledToolGroups: () => ["fixture"],
    ...options,
  })

const hosted = (options: Partial<ClaxedoMcpMountOptions> = {}) =>
  listen({
    mount: "hosted",
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    ...options,
  })

async function connect(url: string, headers: Record<string, string>, elicit?: (message: string) => "accept" | "decline" | "cancel") {
  const client = new Client({ name: "fixture-host", version: "0.0.0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {})
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => ({ action: elicit(request.params.message), content: {} }))
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
  await client.connect(transport)
  clients.push(client)
  return { client, transport }
}

/** A tool outside the credential's audience is never registered, so the SDK itself answers the call. */
const unknownTool = (name: string) => ({ isError: true, content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }] })

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).toSorted()

const initialize = (url: string, init: RequestInit = {}) => {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" })
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  return fetch(url, {
    method: "POST",
    ...init,
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  })
}

describe("the loopback mount", () => {
  test("answers 401 with a bearer challenge when no runtime credential is presented", async () => {
    const { url } = await loopback()
    const response = await initialize(url)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="claxedo-mcp"')
    expect(await response.json()).toEqual({ error: { code: "mcp_unauthorized", message: expect.any(String) } })
  })

  test("never reads the credential from the URL", async () => {
    const { url } = await loopback()
    expect((await initialize(`${url}?access_token=rt-token&token=rt-token`)).status).toBe(401)
  })

  test("refuses an unknown or expired runtime credential", async () => {
    const { url } = await loopback({
      verifyRuntimeCredential: (token) => token === "stale" ? { ...runtimeClaims, expiresAt: 1 } : undefined,
    })
    expect((await initialize(url, { headers: { authorization: "Bearer other" } })).status).toBe(401)
    expect((await initialize(url, { headers: { authorization: "Bearer stale" } })).status).toBe(401)
  })

  test("refuses a non-loopback Origin with 403 and sends no CORS header", async () => {
    const { url } = await loopback()
    const response = await initialize(url, { headers: { authorization: "Bearer rt-token", origin: "https://evil.example" } })
    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(await response.json()).toEqual({ error: { code: "mcp_loopback_only", message: expect.any(String) } })
  })

  test("refuses a non-loopback Host before looking at the credential", async () => {
    const { app } = await loopback()
    const response = await app.request(`http://claxedo.example${CLAXEDO_MCP_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer rt-token", "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(403)
  })

  test("lists only the runtime audience and carries the verified session into the audit line", async () => {
    const { url, audits } = await loopback()
    const { client } = await connect(`${url}?session=ses_parent`, { authorization: "Bearer rt-token" })
    expect(client.getServerVersion()).toEqual({ name: "claxedo", version: packageVersion })
    expect(await toolNames(client)).toEqual(["runtime_ping", "session_send", "wait"])
    expect(await client.callTool({ name: "runtime_ping", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "runtime:runtime" }],
    })
    await client.callTool({ name: "session_send", arguments: { session: "ses_child", text: "hi" } })
    expect(audits).toEqual([{
      tool: "session_send",
      credential: expect.objectContaining({ kind: "runtime", runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_parent" }),
      args: { session: "ses_child", text: "hi" },
      sessionId: "ses_child",
    }])
  })

  test("rejects a call to a tool the credential was not shown", async () => {
    const { url } = await loopback()
    const { client } = await connect(url, { authorization: "Bearer rt-token" })
    expect(await client.callTool({ name: "user_ping", arguments: {} })).toEqual(unknownTool("user_ping"))
    expect(await client.callTool({ name: "workspace_destroy", arguments: { workspace: "ws_1" } })).toEqual(unknownTool("workspace_destroy"))
  })

  test("refuses another session in the URL and never upgrades an unbound token", async () => {
    const { url } = await loopback()
    expect((await initialize(`${url}?session=ses_other`, { headers: { authorization: "Bearer rt-token" } })).status).toBe(401)
    const unbound = await loopback({ verifyRuntimeCredential: () => ({ ...runtimeClaims, sessionId: undefined }) })
    expect((await initialize(`${unbound.url}?session=ses_parent`, { headers: { authorization: "Bearer rt-token" } })).status).toBe(401)
  })

  test("a read-only credential is shown no write and refuses one called anyway", async () => {
    const { url, audits } = await hosted({
      resolveUserCredential: async () => ({ ...fullUserCredential({ actorId: "actor_1", clientId: "mcp-host" }), readOnly: true }),
    })
    const { client } = await connect(url, { authorization: "Bearer anything" })
    expect(await toolNames(client)).toEqual(["user_ping", "wait"])
    expect(await client.callTool({ name: "session_send", arguments: { session: "s", text: "t" } })).toEqual(unknownTool("session_send"))
    expect(audits).toEqual([])
  })

  test("caps the requests one credential may hold open", async () => {
    const { url, gate } = await loopback({ maxInFlightPerCredential: 1 })
    const { client, transport } = await connect(url, { authorization: "Bearer rt-token" })
    const waiting = client.callTool({ name: "wait", arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer rt-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    })
    expect(second.status).toBe(429)
    expect(second.headers.get("retry-after")).toBe("1")
    gate.release?.()
    expect(await waiting).toMatchObject({ content: [{ type: "text", text: "released" }] })
    expect(await toolNames(client)).toContain("wait")
  })

  test("binds a session to the credential that initialized it", async () => {
    const { url } = await loopback({
      verifyRuntimeCredential: (token) => token === "rt-token" ? runtimeClaims : token === "rt-other" ? { ...runtimeClaims, runtimeId: "rt_2" } : undefined,
    })
    const { transport } = await connect(url, { authorization: "Bearer rt-token" })
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer rt-other",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    })
    expect(response.status).toBe(404)
  })

  test("forgets an idle session so the client initializes again", async () => {
    let clock = 1_000
    const { url } = await loopback({ sessionIdleMs: 100, now: () => clock })
    const { transport } = await connect(url, { authorization: "Bearer rt-token" })
    clock += 101
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer rt-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    })
    expect(response.status).toBe(404)
  })
})

describe("the hosted mount", () => {
  test("a refreshed bearer initializes a client instead of retaining the expired downstream bearer", async () => {
    const { url } = await hosted({ resolveUserCredential: async () => fullUserCredential({ actorId: "actor_1", clientId: "cli" }) })
    const { transport } = await connect(url, { authorization: "Bearer original" })
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer refreshed",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    })
    expect(response.status).toBe(404)
    const refreshed = await connect(url, { authorization: "Bearer refreshed" })
    expect(await toolNames(refreshed.client)).toContain("session_send")
  })

  test("does not reuse an admin session after the same client's scopes are narrowed", async () => {
    let admin = true
    const { url, audits } = await hosted({
      resolveUserCredential: async () => ({
        kind: "user", actorId: "actor_1", clientId: "same-client", readOnly: false,
        scopes: new Set(admin ? ["read", "act", "admin"] as const : ["read", "act"] as const),
      }),
    })
    const { client, transport } = await connect(url, { authorization: "Bearer token" })
    expect(await toolNames(client)).toContain("workspace_destroy")
    admin = false
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace_destroy", arguments: { workspace: "ws_1" } } }),
    })
    expect(response.status).toBe(404)
    expect(audits).toEqual([])
    const narrowed = await connect(url, { authorization: "Bearer token" })
    expect(await toolNames(narrowed.client)).not.toContain("workspace_destroy")
    expect(await toolNames(narrowed.client)).toContain("session_send")
  })

  test("points an unauthenticated client at the protected-resource metadata", async () => {
    const { url } = await hosted()
    const response = await initialize(url)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="claxedo-mcp", resource_metadata="${new URL(url).origin}/.well-known/oauth-protected-resource"`,
    )
  })

  test("lists only the user audience for a CLI credential and audits its writes as that actor", async () => {
    const { url, audits } = await hosted()
    const { client } = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(client)).toEqual(["session_send", "user_ping", "wait", "workspace_destroy"])
    expect(await client.callTool({ name: "user_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "user:user" }] })
    await client.callTool({ name: "session_send", arguments: { session: "ses_1", text: "go" } })
    expect(audits).toEqual([{
      tool: "session_send",
      credential: expect.objectContaining({ kind: "user", actorId: "actor_1", clientId: "cli" }),
      args: { session: "ses_1", text: "go" },
      sessionId: "ses_1",
    }])
    expect(await client.callTool({ name: "runtime_ping", arguments: {} })).toEqual(unknownTool("runtime_ping"))
  })

  test("admits a runtime credential only when it was given a verifier", async () => {
    const without = await hosted()
    expect((await initialize(without.url, { headers: { authorization: "Bearer rt-token" } })).status).toBe(401)
    const withVerifier = await hosted({ verifyRuntimeCredential: (token) => token === "rt-token" ? runtimeClaims : undefined })
    const { client } = await connect(withVerifier.url, { authorization: "Bearer rt-token" })
    expect(await toolNames(client)).toEqual(["runtime_ping", "session_send", "wait"])
  })

  test("confirms a destructive tool through the host's elicitation and honours a decline", async () => {
    const { url, audits } = await hosted()
    const prompts: string[] = []
    const declining = await connect(url, { authorization: "Bearer cli-jwt" }, (message) => { prompts.push(message); return "decline" })
    expect(await declining.client.callTool({ name: "workspace_destroy", arguments: { workspace: "ws_9" } })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "workspace_destroy was not confirmed" }],
    })
    expect(prompts).toEqual(["Confirm workspace_destroy?"])
    expect(audits).toEqual([])

    const accepting = await connect(url, { authorization: "Bearer cli-jwt" }, () => "accept")
    expect(await accepting.client.callTool({ name: "workspace_destroy", arguments: { workspace: "ws_9" } })).toMatchObject({
      content: [{ type: "text", text: "destroyed:ws_9" }],
    })
    expect(audits.map((event) => event.tool)).toEqual(["workspace_destroy"])
  })

  test("refuses a destructive tool before execution for a host that declared no elicitation", async () => {
    const { url, audits } = await hosted()
    const { client } = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await client.callTool({ name: "workspace_destroy", arguments: { workspace: "ws_2" } })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "workspace_destroy requires confirmation, but this client does not support elicitation" }],
    })
    expect(audits).toEqual([])
  })

  test("cancelled and failed elicitation never executes a destructive tool", async () => {
    const { url, audits } = await hosted()
    for (const answer of [() => "cancel" as const, () => { throw new Error("host confirmation unavailable") }]) {
      const { client } = await connect(url, { authorization: "Bearer cli-jwt" }, answer)
      expect(await client.callTool({ name: "workspace_destroy", arguments: { workspace: "ws_2" } })).toMatchObject({ isError: true })
    }
    expect(audits).toEqual([])
  })
})

describe("composition", () => {
  test("a loopback mount without a verifier cannot be built", () => {
    expect(() => createClaxedoMcpRoutes({
      mount: "loopback",
      createClient: () => stubClient,
      registerTools: [],
      audit: () => undefined,
    })).toThrow(/no verifier/)
  })

  test("the version every mount reports is this package's own", () => {
    expect(CLAXEDO_MCP_SERVER_INFO).toEqual({ name: "claxedo", version: packageVersion })
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("a mount with no tool groups still answers tools/list", async () => {
    const { url } = await hosted({ registerTools: [] })
    const { client } = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(client)).toEqual([])
  })

  test("read-only is the credential's own state, so one connection is restricted and another is not", async () => {
    const { url } = await hosted({
      resolveUserCredential: async (request) => {
        const full = fullUserCredential({ actorId: "actor_1", clientId: "mcp-host" })
        if (request.headers.get("authorization") === "Bearer reader") return { ...full, readOnly: true }
        return request.headers.get("authorization") === "Bearer cli-jwt" ? full : undefined
      },
    })
    const writer = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(writer.client)).toContain("session_send")
    const reader = await connect(url, { authorization: "Bearer reader" })
    expect(await toolNames(reader.client)).toEqual(["user_ping", "wait"])
  })
})

describe("tool groups", () => {
  const inventory = claxedoMcpToolGroupInventory()
  const toolsOf = (...ids: string[]) =>
    inventory.filter((group) => ids.includes(group.id)).flatMap((group) => group.tools).toSorted()

  test("every registered group's inventory is the names its registration declares", () => {
    expect(inventory.map((group) => group.id)).toEqual(CLAXEDO_MCP_TOOL_GROUP_IDS)
    expect(inventory.every((group) => group.tools.length > 0)).toBe(true)
    expect(toolsOf("tasks")).toEqual(["task_create", "task_edit", "task_get", "task_list", "task_start"])
  })

  test("a mount serving a subset lists and admits exactly that subset's tools", async () => {
    const { url } = await hosted({
      registerTools: CLAXEDO_MCP_TOOL_GROUPS,
      enabledToolGroups: () => ["review", "workspaces"],
    })
    const { client } = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(client)).toEqual(toolsOf("review", "workspaces"))
    expect(await client.callTool({ name: "session_create", arguments: {} })).toEqual(unknownTool("session_create"))
  })

  test("a group turned off takes its tools with it, by name as well as from the list", async () => {
    const enabled = new Set(["review", "workspaces"])
    const { url } = await hosted({
      registerTools: CLAXEDO_MCP_TOOL_GROUPS,
      enabledToolGroups: () => [...enabled],
    })
    const before = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(before.client)).toContain("workspaces_list")
    enabled.delete("workspaces")
    const after = await connect(url, { authorization: "Bearer cli-jwt" })
    expect(await toolNames(after.client)).toEqual(toolsOf("review"))
    expect(await after.client.callTool({ name: "workspaces_list", arguments: {} }))
      .toEqual(unknownTool("workspaces_list"))
  })

  test("a loopback mount cannot be built without a consent resolver", () => {
    expect(() => createClaxedoMcpRoutes({
      mount: "loopback",
      verifyRuntimeCredential: () => runtimeClaims,
      createClient: () => stubClient,
      registerTools: [],
      audit: () => undefined,
    })).toThrow(/consented tool groups/)
  })
})
