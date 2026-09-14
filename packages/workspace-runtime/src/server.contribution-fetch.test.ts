import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createWorkspaceRuntimeApp } from "./server"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "./exposure"
import { createRuntimeCredentialIssuer } from "./first-party-mcp/index"
import type { WorkspaceRuntimeRouteContribution } from "./route-contribution"
import type { EmbeddedRelayHostIdentity } from "./workspace-host-service-auth"

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

describe("an owner grant presented on the in-process fetch", () => {
  const owner: EmbeddedRelayHostIdentity = {
    principal_kind: "user",
    actor_id: "actor_owner",
    actor_kind: "human",
    actor_public_id: "actor_owner",
    actor_name: "workspace owner",
    org_id: "org_1",
    workspace_id: "ws_1",
    role: "owner",
  }

  function echo(): WorkspaceRuntimeRouteContribution & { calls: Array<(headers?: Record<string, string>) => Promise<Response>> } {
    const calls: Array<(headers?: Record<string, string>) => Promise<Response>> = []
    return {
      calls,
      id: "echo",
      mount(context) {
        calls.push((headers) => context.fetch(new Request("http://127.0.0.1/echo-identity", { headers })))
        const routes = new Hono()
        routes.get("/echo-identity", (c) =>
          c.json({ identity: (c as unknown as { get(name: string): unknown }).get("relayHostAuth") ?? null }))
        return { path: "/", routes, dispose: () => {} }
      },
    }
  }

  test("is stamped as the verified actor when this runtime's verifier accepts it, and leaves the request actor-less otherwise", async () => {
    const probe = echo()
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayAuth),
      ownerGrantIdentity: async (token) => {
        seen.push(token)
        return token === "minted-for-ws_1" ? owner : undefined
      },
      routeContributions: [probe],
    })
    try {
      expect(await (await probe.calls[0]({ authorization: "Bearer minted-for-ws_1" })).json()).toEqual({ identity: owner })
      expect(await (await probe.calls[0]({ authorization: "Bearer minted-for-ws_2" })).json()).toEqual({ identity: null })
      expect(await (await probe.calls[0]()).json()).toEqual({ identity: null })
      expect(seen).toEqual(["minted-for-ws_1", "minted-for-ws_2"])
      // The same bearer from outside the process is not an owner: it is not a relay host token.
      expect((await runtime.app.request("http://127.0.0.1/echo-identity", { headers: { authorization: "Bearer minted-for-ws_1" } })).status).toBe(401)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("is ignored by a runtime composed without a verifier", async () => {
    const probe = echo()
    const runtime = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayAuth), routeContributions: [probe] })
    try {
      expect(await (await probe.calls[0]({ authorization: "Bearer minted-for-ws_1" })).json()).toEqual({ identity: null })
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
