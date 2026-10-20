/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { isOperationUnavailable } from "./errors"
import { placementId, projectId, sessionId } from "./ids"
import { createMcpAppsApi } from "./mcp-apps"
import type { SessionContext } from "./session-context"
import { bootstrap } from "./test-session-server"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

const ref = { projectId: projectId("proj_1"), placementId: placementId("ws_cloud"), sessionId: sessionId("ses_1") }

const MCP = "/workspaces/ws_cloud/session/ses_1/mcp/weather%20app"

async function fixture(options: { reachable?: boolean } = {}) {
  const requests: { path: string; body?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/claxedo/bootstrap") return Response.json(bootstrap(() => options.reachable ?? true, false))
      requests.push({ path, ...(request.method === "POST" ? { body: await request.json() } : {}) })
      if (path === `${MCP}/tools`) {
        return Response.json({ tools: [{ name: "forecast", annotations: { readOnlyHint: true } }, { name: "book", _meta: { ui: { visibility: ["model"] } } }, { name: "" }, { title: "nameless" }] })
      }
      if (path === `${MCP}/tool-call`) return Response.json({ content: [{ type: "text", text: "4°" }], structuredContent: { temp: 4 }, _meta: { trace: "t" } })
      if (path === `${MCP}/resource-read`) return Response.json({ ok: false, error: { code: "unsupported_operation", capability: "mcp" } }, { status: 409 })
      if (path === "/workspaces/ws_cloud/session/ses_1/mcp/down/tools") return Response.json({ ok: false, status: "unavailable" }, { status: 502 })
      return Response.json({ ok: false, status: "not_found", message: "No MCP server named nowhere" }, { status: 404 })
    },
  })
  running.push(server)
  const transport = createTransport({ serverUrl: `http://127.0.0.1:${server.port}` })
  const workspaces = createWorkspaces(transport, new QueryClient())
  const api = createMcpAppsApi({ transport, workspaces } as unknown as SessionContext)
  return { api, requests, dispose: () => workspaces.dispose() }
}

const failureOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error)

test("lists a server's tools with whether each is read-only and offered to apps", async () => {
  const f = await fixture()
  expect(await f.api.mcpTools(ref, "weather app")).toEqual([
    { name: "forecast", readOnly: true, visibleToApp: true },
    { name: "book", readOnly: false, visibleToApp: false },
  ])
  f.dispose()
})

test("posts a tool call and passes the MCP result through unchanged", async () => {
  const f = await fixture()
  expect(await f.api.callMcpTool(ref, "weather app", "forecast", { city: "Oslo" })).toEqual({ content: [{ type: "text", text: "4°" }], structuredContent: { temp: 4 }, _meta: { trace: "t" } })
  expect(f.requests).toEqual([{ path: `${MCP}/tool-call`, body: { tool: "forecast", arguments: { city: "Oslo" } } }])
  f.dispose()
})

test("an unsupported operation, an unreachable harness and a missing server come back as typed errors", async () => {
  const f = await fixture()
  const unsupported = await failureOf(f.api.readMcpResource(ref, "weather app", "ui://weather/app"))
  expect(unsupported).toMatchObject({ class: "conflict", code: "unsupported_operation" })
  expect(isOperationUnavailable(unsupported)).toBe(true)
  expect(f.requests.at(-1)).toEqual({ path: `${MCP}/resource-read`, body: { uri: "ui://weather/app" } })
  const missing = await failureOf(f.api.mcpTools(ref, "nowhere"))
  expect(missing).toMatchObject({ class: "not_found", message: "No MCP server named nowhere" })
  expect(isOperationUnavailable(missing)).toBe(false)
  expect(isOperationUnavailable(await failureOf(f.api.mcpTools(ref, "down")))).toBe(true)
  f.dispose()
})

test("a sleeping runtime is not woken: the call fails as unavailable without reaching it", async () => {
  const f = await fixture({ reachable: false })
  const asleep = await failureOf(f.api.callMcpTool(ref, "weather app", "book", {}))
  expect(asleep).toMatchObject({ class: "runtime_unreachable", code: "runtime_asleep" })
  expect(isOperationUnavailable(asleep)).toBe(true)
  expect(f.requests.filter((request) => request.path.includes("/mcp/"))).toEqual([])
  f.dispose()
})
