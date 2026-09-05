import { describe, expect, test, vi } from "vitest"
import { forwardMcpGatewayRequest, McpGatewayError } from "./gateway"

describe("MCP transport gateway", () => {
  test("forwards one ordinary MCP request with the live token and protocol headers", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response("event: message\ndata: {}\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "mcp-session-id": "session-2",
        "mcp-task-id": "task-2",
        "set-cookie": "never",
      },
    }))
    const response = await forwardMcpGatewayRequest({
      request: new Request("https://claxedo.example/gateway", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "echo",
          "mcp-param-city": "Boston",
          "mcp-session-id": "session-1",
          authorization: "Bearer attacker-value",
          cookie: "private",
          "x-private-context": "never",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      }),
      resource: "https://mcp.example/mcp",
      token: "connection-token",
      tokenType: "bearer",
      fetch,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("https://mcp.example/mcp")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer connection-token")
    expect(new Headers(init?.headers).get("cookie")).toBeNull()
    expect(new Headers(init?.headers).get("x-private-context")).toBeNull()
    expect(new Headers(init?.headers).get("mcp-method")).toBe("tools/call")
    expect(new Headers(init?.headers).get("mcp-name")).toBe("echo")
    expect(new Headers(init?.headers).get("mcp-param-city")).toBe("Boston")
    expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-1")
    expect(response.headers.get("mcp-session-id")).toBe("session-2")
    expect(response.headers.get("mcp-task-id")).toBe("task-2")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.text()).toContain("event: message")
  })

  test("never follows an authenticated redirect or retries an ambiguous request", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(null, { status: 307, headers: { location: "https://evil.example/mcp" } })
    }
    await expect(forwardMcpGatewayRequest({
      request: new Request("https://claxedo.example/gateway", { method: "POST", body: "{}" }),
      resource: "https://mcp.example/mcp",
      token: "secret",
      tokenType: "bearer",
      fetch,
    })).rejects.toMatchObject({ code: "upstream-redirect" } satisfies Partial<McpGatewayError>)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]?.redirect).toBe("manual")
  })

  test("rejects unsafe resources and methods before token-bearing fetch", async () => {
    const fetch = vi.fn()
    await expect(forwardMcpGatewayRequest({
      request: new Request("https://claxedo.example/gateway", { method: "PUT" }),
      resource: "https://mcp.example/mcp",
      token: "secret",
      tokenType: "bearer",
      fetch,
    })).rejects.toMatchObject({ code: "unsupported-method" })
    await expect(forwardMcpGatewayRequest({
      request: new Request("https://claxedo.example/gateway"),
      resource: "http://mcp.example/mcp",
      token: "secret",
      tokenType: "bearer",
      fetch,
    })).rejects.toMatchObject({ code: "invalid-resource" })
    expect(fetch).not.toHaveBeenCalled()
  })
})
