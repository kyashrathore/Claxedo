import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { MCP_APP_MIME, toolPartHeader, type AgentToolPart, type SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, McpOperations, McpResourceRead, McpToolCall } from "@claxedo/harness/contract"
import { managedWorkspaceSessionAccessPolicy, sessionAccessWriteClass, type SessionAccessPolicy } from "../session-access-policy"
import { FakeTransport, type FakeTransportOptions } from "../test-support/fake-transport"
import { rmSync } from "node:fs"
import { createHostFixture, LOOPBACK_ORIGIN, sessionCreate, tempStoreRoot, type HostFixture } from "../test-support/host-fixture"
import { testLaunch } from "../test-support/host-composition"
import { openTestRuntimeStore } from "../test-support/store"
import { createSessionRoutes } from "./session-core"

const CODEX: SessionHarness = { id: "codex", access: "native" }
const WORKSPACE = "/workspace"
const hosts: HostFixture[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function weatherMcp() {
  const seen: Array<{ session: string; call?: McpToolCall; read?: McpResourceRead; listed?: string }> = []
  const operations: McpOperations = {
    listTools: async (session: HarnessSession, server) => {
      seen.push({ session: session.binding.sessionId, listed: server })
      return server === "weather"
        ? { ok: true, tools: [{ name: "refresh", annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } }] }
        : { ok: false, status: "not_found", message: `The session has no MCP server ${server}` }
    },
    callTool: async (session, call) => {
      seen.push({ session: session.binding.sessionId, call })
      if (call.tool === "summarize") return { ok: false, status: "refused", message: "MCP tool summarize is not offered to apps" }
      return { ok: true, result: { content: [{ type: "text", text: "21°" }], structuredContent: { temperature: 21 } } }
    },
    readResource: async (session, read) => {
      seen.push({ session: session.binding.sessionId, read })
      return { ok: true, result: { contents: [{ uri: read.uri, mimeType: "text/html;profile=mcp-app", text: "<p>app</p>" }] } }
    },
  }
  return { operations, seen }
}

function fixtureOver(mcp: McpOperations | undefined, store?: HostFixture["store"], turn?: FakeTransportOptions["turn"]) {
  const transport = new FakeTransport({ kind: "codex-app-server", ...(mcp ? { mcp } : {}), ...(turn ? { turn } : {}) })
  const fixture = createHostFixture({ transports: { codex: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1", ["actor_grantee"]), ...(store ? { store } : {}) })
  hosts.push(fixture)
  return fixture
}

async function host(mcp: McpOperations | undefined) {
  const fixture = fixtureOver(mcp)
  await fixture.runtime.sessions.create(sessionCreate({ id: "s1", workspaceId: "ws_1", directory: WORKSPACE, harness: CODEX }))
  await fixture.runtime.turns.start({ sessionId: "s1", parts: [{ type: "text", text: "hi" }], origin: LOOPBACK_ORIGIN })
  await fixture.runtime.turns.whenIdle("s1")
  return fixture
}

async function restartedHost(mcp: McpOperations) {
  const root = tempStoreRoot()
  const store = openTestRuntimeStore(root)
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const before = fixtureOver(mcp, store)
  await before.runtime.sessions.create(sessionCreate({ id: "s1", workspaceId: "ws_1", directory: WORKSPACE, harness: CODEX }))
  await before.runtime.dispose()
  return fixtureOver(mcp, store)
}

function routes(fixture: HostFixture, sessionAccessPolicy?: SessionAccessPolicy) {
  return createSessionRoutes({
    getPart: (_c, _directory, sessionId, messageId, partId) => fixture.store.getPart(sessionId, messageId, partId),
    sessionIdWorkspace: () => undefined,
    runtime: async () => fixture.runtime,
    defaultHarness: () => CODEX,
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    publishGlobal: () => {},
    ...(sessionAccessPolicy ? { sessionAccessPolicy } : {}),
  })
}

async function call(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, path: string, body?: unknown) {
  const response = await app.request(`http://localhost${path}`, body === undefined ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as unknown }
}

test("an app lists its server's tools, calls one and reads a resource through the session's harness", async () => {
  const mcp = weatherMcp()
  const app = routes(await host(mcp.operations))

  expect(await call(app, "/session/s1/mcp/weather/tools")).toEqual({ status: 200, body: {
    tools: [{ name: "refresh", annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } }],
  } })
  expect(await call(app, "/session/s1/mcp/weather/tool-call", { tool: "refresh", arguments: { city: "Oslo" } })).toEqual({ status: 200, body: {
    content: [{ type: "text", text: "21°" }], structuredContent: { temperature: 21 },
  } })
  expect(await call(app, "/session/s1/mcp/weather/resource-read", { uri: "ui://weather/app" })).toEqual({ status: 200, body: {
    contents: [{ uri: "ui://weather/app", mimeType: "text/html;profile=mcp-app", text: "<p>app</p>" }],
  } })
  expect(mcp.seen).toEqual([
    { session: "s1", listed: "weather" },
    { session: "s1", call: { server: "weather", tool: "refresh", arguments: { city: "Oslo" } } },
    { session: "s1", read: { server: "weather", uri: "ui://weather/app" } },
  ])
})

test("an unknown server, a tool hidden from apps, a malformed call and a session holding no harness are each refused before or by the harness", async () => {
  const mcp = weatherMcp()
  const app = routes(await host(mcp.operations))

  expect(await call(app, "/session/s1/mcp/elsewhere/tools")).toMatchObject({ status: 404, body: { ok: false, status: "not_found" } })
  expect(await call(app, "/session/s1/mcp/weather/tool-call", { tool: "summarize" })).toMatchObject({ status: 403, body: { ok: false, status: "refused" } })
  expect(await call(app, "/session/s1/mcp/weather/tool-call", { tool: "refresh", arguments: ["Oslo"] })).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })
  expect(await call(app, "/session/s1/mcp/weather/resource-read", {})).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } })

  const asleep = weatherMcp()
  const unattached = routes(await restartedHost(asleep.operations))
  expect(await call(unattached, "/session/s1/mcp/weather/tools")).toMatchObject({ status: 404, body: { ok: false, status: "not_found" } })
  expect(asleep.seen).toEqual([])
})

test("a harness without MCP operations answers unsupported, and the capability record says so", async () => {
  const without = await host(undefined)
  const app = routes(without)

  expect(await call(app, "/session/s1/mcp/weather/tools")).toMatchObject({ status: 409, body: { error: { code: "unsupported_operation", capability: "mcp" } } })
  expect(await call(app, "/session/s1/mcp/weather/tool-call", { tool: "refresh" })).toMatchObject({ status: 409, body: { error: { code: "unsupported_operation", capability: "mcp" } } })
  expect((await call(app, "/session/s1/capabilities")).body).toMatchObject({ mcp: false })
  expect((await call(routes(await host(weatherMcp().operations)), "/session/s1/capabilities")).body).toMatchObject({ mcp: true })
})

test("a reader whose share carries the agent's turn is refused every MCP operation, which runs on the owner's connection", async () => {
  const mcp = weatherMcp()
  const fixture = await host(mcp.operations)
  const decided: Array<{ operation: string; writeClass?: string }> = []
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authority: {
      authorizeSessionRead: async (value) => { decided.push({ operation: value.operation }); return { allowed: true } },
      authorizeSessionWrite: async (value) => {
        const writeClass = sessionAccessWriteClass(value)
        decided.push({ operation: value.operation, ...(writeClass ? { writeClass } : {}) })
        return writeClass === "agent_turn" ? { allowed: true } : { allowed: false, status: 403, code: "workspace_authorization_denied", message: "denied" }
      },
      authorizeSessionStream: async () => ({ allowed: true, lease: "lease", expiresAt: Date.now() + 60_000 }),
      registerSession: async () => ({ allowed: true }),
      acquireTurn: async () => ({ allowed: false, status: 403, code: "denied", message: "denied" }),
      renewTurn: async () => ({ allowed: false, status: 403, code: "denied", message: "denied" }),
      releaseTurn: async () => ({ released: true }),
    },
  })
  const app = new Hono()
  app.use("*", async (context, next) => {
    ;(context as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", {
      actor_id: "actor_grantee", user_id: "actor_grantee", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "editor",
    })
    await next()
  })
  app.route("/", routes(fixture, policy))

  expect((await call(app, "/session/s1/mcp/weather/tools")).status).toBe(403)
  expect((await call(app, "/session/s1/mcp/weather/tool-call", { tool: "refresh" })).status).toBe(403)
  expect((await call(app, "/session/s1/mcp/weather/resource-read", { uri: "ui://weather/app" })).status).toBe(403)
  expect((await call(app, "/session/s1/background-task/stop", { toolCallId: "call-1" })).status).toBe(409)
  expect(decided).toEqual([
    { operation: "mcp_tools_list", writeClass: "session_control" },
    { operation: "mcp_tool_call", writeClass: "session_control" },
    { operation: "mcp_resource_read", writeClass: "session_control" },
    { operation: "background_task_stop", writeClass: "agent_turn" },
  ])
  expect(mcp.seen).toEqual([])
})

test("an MCP tool's app document and facts land on its completed part, stay out of its header and come whole from a part read", async () => {
  const html = `<!doctype html><p>${"weather ".repeat(200_000)}</p>`
  const document = `data:${MCP_APP_MIME};base64,${Buffer.from(html).toString("base64")}`
  const mcp = { server: "weather", tool: "forecast", structuredContent: { temperature: 21 }, app: { resourceUri: "ui://weather/app", prefersBorder: true } }
  const fixture = fixtureOver(undefined, undefined, async function* ({ session }) {
    yield { type: "tool-start", toolCallId: "call-app", toolName: "mcp__weather__forecast" }
    yield { type: "tool-output", toolCallId: "call-app", output: { content: [{ type: "text", text: "Sunny" }] },
      attachments: [{ kind: "inline", mime: MCP_APP_MIME, url: document, filename: "mcp-app.html" }], metadata: { mcp } }
    yield { type: "finish", sessionId: session.binding.sessionId }
  })
  await fixture.runtime.sessions.create(sessionCreate({ id: "s1", workspaceId: "ws_1", directory: WORKSPACE, harness: CODEX }))
  await fixture.runtime.turns.start({ sessionId: "s1", parts: [{ type: "text", text: "forecast" }], origin: LOOPBACK_ORIGIN })
  await fixture.runtime.turns.whenIdle("s1")

  const stored = fixture.store.getMessages("s1").flatMap((message) => message.parts).find((part): part is AgentToolPart => part.type === "tool")
  if (!stored) throw new Error("the turn stored no tool part")
  expect(stored.state).toMatchObject({ status: "completed", output: "Sunny", metadata: { mcp },
    attachments: [{ type: "file", mime: MCP_APP_MIME, filename: "mcp-app.html", url: document }] })

  const header = toolPartHeader(stored)
  expect(header).toMatchObject({ headerOnly: true, state: { metadata: { mcp: { server: "weather", tool: "forecast", app: mcp.app } } } })
  expect(header.state).not.toHaveProperty("attachments")
  expect(JSON.stringify(header)).not.toContain("structuredContent")

  const read = await call(routes(fixture), `/session/s1/message/${stored.messageID}/part/${stored.id}`)
  expect(read).toMatchObject({ status: 200, body: { id: stored.id, state: { metadata: { mcp }, attachments: [{ mime: MCP_APP_MIME, url: document }] } } })
})
