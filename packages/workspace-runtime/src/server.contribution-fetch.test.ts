import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createWorkspaceRuntimeApp } from "./server"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "./exposure"
import { createRuntimeCredentialIssuer } from "./first-party-mcp/index"
import type { WorkspaceRuntimeRouteContribution } from "./route-contribution"

function probe(calls: Array<() => Promise<Response>>): WorkspaceRuntimeRouteContribution {
  return {
    id: "probe",
    mount(context) {
      calls.push(() => context.fetch(new Request("http://127.0.0.1/api/wr/capabilities")))
      return { path: "/", routes: new Hono(), dispose: () => {} }
    },
  }
}

const relayAuth = { key: new Uint8Array([1]), workspaceId: "ws_1", hostId: "host_1" }

describe("the route-contribution in-process fetch", () => {
  test("passes the relay host-token boundary that refuses the same route to an outside caller", async () => {
    const calls: Array<() => Promise<Response>> = []
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayAuth),
      routeContributions: [probe(calls)],
    })
    try {
      expect((await runtime.app.request("http://127.0.0.1/api/wr/capabilities")).status).toBe(401)
      expect((await calls[0]()).status).toBe(200)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("reaches the runtime's routes on a loopback runtime too", async () => {
    const calls: Array<() => Promise<Response>> = []
    const runtime = createWorkspaceRuntimeApp({
      exposure: loopbackWorkspaceRuntimeExposure(),
      routeContributions: [probe(calls)],
    })
    try {
      expect((await calls[0]()).status).toBe(200)
    } finally {
      await runtime.host.dispose()
    }
  })
})

describe("the first-party MCP credential as a direct caller", () => {
  test("is trusted only on the endpoint's own path, and only when this runtime minted it", async () => {
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: "ws_1" })
    const foreign = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: "ws_1" })
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayAuth),
      firstPartyMcpLaunch: { enabledToolGroups: () => ["sessions"], baseUrl: "http://127.0.0.1:2593", issuer },
      routeContributions: [{
        id: "mcp",
        mount: () => ({
          path: "/api/claxedo/mcp",
          routes: new Hono().all("/", (c) => c.text("mounted")),
          dispose: () => {},
        }),
      }],
    })
    const request = (path: string, token: string) =>
      runtime.app.request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${token}` } })
    try {
      expect((await request("/api/claxedo/mcp", issuer.current())).status).toBe(200)
      expect((await request("/api/claxedo/mcp", foreign.current())).status).toBe(401)
      expect((await request("/api/wr/capabilities", issuer.current())).status).toBe(401)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("is refused when no launch option was composed, so the endpoint is unreachable", async () => {
    const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: "ws_1" })
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayAuth),
      routeContributions: [{
        id: "mcp",
        mount: () => ({
          path: "/api/claxedo/mcp",
          routes: new Hono().all("/", (c) => c.text("mounted")),
          dispose: () => {},
        }),
      }],
    })
    try {
      const response = await runtime.app.request("http://127.0.0.1/api/claxedo/mcp", {
        headers: { authorization: `Bearer ${issuer.current()}` },
      })
      expect(response.status).toBe(401)
    } finally {
      await runtime.host.dispose()
    }
  })
})
