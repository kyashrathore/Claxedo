import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintMcpGatewayToken, type McpGatewayTokenScope } from "./runtime-token"
import { HostedMcpGatewayRoutes } from "./routes"

const scope: McpGatewayTokenScope = {
  userId: "user-1",
  orgId: "org-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  harnessId: "opencode",
  pluginInstanceId: "collection:docs",
  serverName: "docs",
  integrationId: "mcp-docs",
}

async function setup(overrides: {
  authorize?: (scope: McpGatewayTokenScope) => Promise<{ resource: string } | undefined>
  resource?: string
  /** Serve the route with this env instead of the minting env (a deployment missing its key). */
  routeEnv?: Record<string, string | undefined>
} = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const credential = await mintMcpGatewayToken(scope, env)
  const order: string[] = []
  const resolveConnection = vi.fn(async () => {
    order.push("resolve")
    return {
      ok: true as const,
      connectionId: "connection-1",
      token: "upstream-token",
      tokenType: "bearer" as const,
      fields: { resource: overrides.resource ?? "https://mcp.example/mcp" },
    }
  })
  const fetchCalls: Array<[string, RequestInit | undefined]> = []
  const fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push([url, init])
    order.push("fetch")
    return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, {
      headers: { "mcp-session-id": "session-1" },
    })
  }
  const app = HostedMcpGatewayRoutes({
    env: overrides.routeEnv ?? env,
    authorize: overrides.authorize ?? (async () => {
      order.push("authorize")
      return { resource: "https://mcp.example/mcp" }
    }),
    resolveConnection,
    fetch,
  })
  return { app, credential: credential.token, order, resolveConnection, fetch, fetchCalls }
}

describe("hosted MCP gateway route", () => {
  test("a deployment without its verification key answers 503, not a reconnect-inviting 401", async () => {
    const subject = await setup({ routeEnv: {} })
    const response = await subject.app.request("http://gateway.test/integration-1", {
      method: "POST",
      headers: { authorization: `Bearer ${subject.credential}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "mcp_gateway_misconfigured" })
    expect(subject.resolveConnection).not.toHaveBeenCalled()
  })

  test("a tampered credential is refused as invalid", async () => {
    const subject = await setup()
    const response = await subject.app.request("http://gateway.test/integration-1", {
      method: "POST",
      headers: { authorization: `Bearer ${subject.credential.slice(0, -4)}AAAA`, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: "mcp_gateway_unauthorized", reason: "invalid_token" })
  })

  test("authorizes the exact activation before resolving and forwarding a Connection token", async () => {
    const subject = await setup()
    const response = await subject.app.request(`/mcp-docs`, {
      method: "POST",
      headers: { authorization: `Bearer ${subject.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(200)
    expect(subject.order).toEqual(["authorize", "resolve", "fetch"])
    expect(subject.fetchCalls[0]?.[0]).toBe("https://mcp.example/mcp")
    expect(new Headers(subject.fetchCalls[0]?.[1]?.headers).get("authorization")).toBe("Bearer upstream-token")
  })

  test("denies stale activation before revealing Connection state", async () => {
    const subject = await setup({ authorize: async () => undefined })
    const response = await subject.app.request(`/mcp-docs`, { headers: { authorization: `Bearer ${subject.credential}` } })
    expect(response.status).toBe(403)
    expect(subject.resolveConnection).not.toHaveBeenCalled()
    expect(subject.fetchCalls).toHaveLength(0)
  })

  test("fails closed when the Connection audience differs from the current retained server", async () => {
    const subject = await setup({ resource: "https://other.example/mcp" })
    const response = await subject.app.request(`/mcp-docs`, { headers: { authorization: `Bearer ${subject.credential}` } })
    expect(response.status).toBe(409)
    expect(subject.fetchCalls).toHaveLength(0)
  })

  test("rejects integration substitution at JWT verification", async () => {
    const subject = await setup()
    const response = await subject.app.request(`/mcp-other`, { headers: { authorization: `Bearer ${subject.credential}` } })
    expect(response.status).toBe(401)
    expect(subject.resolveConnection).not.toHaveBeenCalled()
  })
})
