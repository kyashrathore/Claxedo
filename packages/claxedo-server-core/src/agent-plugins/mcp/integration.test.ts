import { describe, expect, it, vi } from "vitest"
import type { McpOAuthDiscovery } from "./discovery"
import {
  createMcpOAuthIntegration,
  createMcpOAuthIntegrationFromAttempt,
  mcpOAuthIntegrationId,
} from "./integration"

/** The form body an OAuth token request carries. Anything else is a bug in the code under test. */
function formBody(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body
  if (body instanceof URLSearchParams) return body
  if (typeof body === "string") return new URLSearchParams(body)
  throw new Error(`expected a form-encoded request body, received ${typeof body}`)
}

const discovery = (overrides: Partial<McpOAuthDiscovery> = {}): McpOAuthDiscovery => ({
  resource: "https://mcp.example/mcp",
  resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/mcp",
  issuer: "https://login.example",
  authorizationEndpoint: "https://login.example/authorize",
  tokenEndpoint: "https://login.example/token",
  authorizationResponseIssuerParameterSupported: true,
  scopes: ["read", "write"],
  client: { kind: "pre-registered", clientId: "claxedo", clientSecret: "secret" },
  ...overrides,
})

describe("MCP OAuth Connections integration", () => {
  it("derives a stable identity from the source-scoped plugin and server name", async () => {
    const input = { pluginInstanceId: "plugin@sha256:abc", serverName: "docs", discovery: discovery() }
    expect(await mcpOAuthIntegrationId(input)).toBe(await mcpOAuthIntegrationId(input))
    expect(await mcpOAuthIntegrationId({ ...input, serverName: "issues" })).not.toBe(await mcpOAuthIntegrationId(input))
    expect(await mcpOAuthIntegrationId({ ...input, pluginInstanceId: "other@sha256:abc" })).not.toBe(await mcpOAuthIntegrationId(input))
  })

  it("creates a PKCE authorization request bound to the exact resource", async () => {
    const integration = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch: vi.fn(),
    })
    const url = await integration.impl.auth.authorize("state", "verifier")
    expect(url.origin + url.pathname).toBe("https://login.example/authorize")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "claxedo",
      redirect_uri: "https://claxedo.example/api/connections/callback",
      state: "state",
      code_challenge_method: "S256",
      resource: "https://mcp.example/mcp",
      scope: "read write",
    })
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("omits the optional scopes field when discovery advertises no scopes", async () => {
    const integration = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery({ scopes: [] }),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch: vi.fn(),
    })

    expect(integration.impl.auth.attemptContext).not.toHaveProperty("scopes")
    expect((await integration.impl.auth.authorize("state", "verifier")).searchParams.has("scope")).toBe(false)
  })

  it("freezes discovery into the attempt, validates response issuer, and exchanges without leaking token data", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 60,
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const integration = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch,
      now: () => 1_000,
    })
    await expect(integration.impl.auth.callback("code", "verifier", integration.impl.auth.attemptContext, { issuer: "https://login.example" })).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 61_000,
      fields: { resource: "https://mcp.example/mcp", issuer: "https://login.example" },
    })
    const [url, init] = calls[0]
    expect(url).toBe("https://login.example/token")
    const body = formBody(init)
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "code",
      code_verifier: "verifier",
      redirect_uri: "https://claxedo.example/api/connections/callback",
      resource: "https://mcp.example/mcp",
      client_id: "claxedo",
      client_secret: "secret",
    })
  })

  it("rejects stale attempt metadata, a missing required issuer, and any present issuer mismatch before token exchange", async () => {
    const fetch = vi.fn()
    const integration = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch,
    })
    await expect(integration.impl.auth.callback("code", "verifier", { ...integration.impl.auth.attemptContext, resource: "https://evil.example" }, { issuer: "https://login.example" })).rejects.toThrow("no longer matches")
    await expect(integration.impl.auth.callback("code", "verifier", integration.impl.auth.attemptContext)).rejects.toThrow("omitted")
    await expect(integration.impl.auth.callback("code", "verifier", integration.impl.auth.attemptContext, { issuer: "https://evil.example" })).rejects.toThrow("mismatch")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("binds refresh requests to the same MCP resource", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ access_token: "next" }), { status: 200 })
    }
    const integration = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch,
    })
    await expect(integration.impl.auth.refresh("old-refresh")).resolves.toEqual({ accessToken: "next" })
    expect(Object.fromEntries(formBody(calls[0]?.[1]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      resource: "https://mcp.example/mcp",
      scope: "read write",
      client_id: "claxedo",
      client_secret: "secret",
    })
  })

  it("reconstructs callback handling from only the durable public attempt and configured pre-registration", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({
        access_token: "access",
        token_type: "Bearer",
      }), { status: 200 })
    }
    const original = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch,
    })
    const reconstructed = await createMcpOAuthIntegrationFromAttempt({
      integrationId: original.decl.id,
      serverName: "docs",
      attemptContext: original.impl.auth.attemptContext,
      preRegistered: { "https://login.example": { clientId: "claxedo", clientSecret: "secret" } },
      fetch,
    })

    expect(reconstructed.decl.id).toBe(original.decl.id)
    await expect(reconstructed.impl.auth.callback(
      "code",
      "verifier",
      original.impl.auth.attemptContext,
      { issuer: "https://login.example" },
    )).resolves.toMatchObject({
      accessToken: "access",
      fields: { resource: "https://mcp.example/mcp", issuer: "https://login.example" },
    })
    expect(formBody(calls[0]?.[1]).get("client_secret")).toBe("secret")
  })

  it("fails callback reconstruction when a pre-registration was removed or changed", async () => {
    const original = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery(),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch: vi.fn(),
    })
    await expect(createMcpOAuthIntegrationFromAttempt({
      integrationId: original.decl.id,
      serverName: "docs",
      attemptContext: original.impl.auth.attemptContext,
      preRegistered: { "https://login.example": { clientId: "different" } },
      fetch: vi.fn(),
    })).rejects.toThrow("pre-registration no longer matches")
  })

  it("re-validates a dynamically registered client against the registry and presents its secret", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ access_token: "access", token_type: "Bearer" }), { status: 200 })
    }
    const original = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      // A dynamic attempt freezes only the client id; the secret is never in it.
      discovery: discovery({ client: { kind: "dynamic", clientId: "dyn-1", clientSecret: "issued" } }),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch,
    })
    expect(original.impl.auth.attemptContext.client_kind).toBe("dynamic")
    expect(JSON.stringify(original.impl.auth.attemptContext)).not.toContain("issued")

    const reconstructed = await createMcpOAuthIntegrationFromAttempt({
      integrationId: original.decl.id,
      serverName: "docs",
      attemptContext: original.impl.auth.attemptContext,
      dynamicRegistration: { lookup: async () => ({ clientId: "dyn-1", clientSecret: "issued" }) },
      fetch,
    })
    await expect(reconstructed.impl.auth.callback(
      "code",
      "verifier",
      original.impl.auth.attemptContext,
      { issuer: "https://login.example" },
    )).resolves.toMatchObject({ accessToken: "access" })
    const body = formBody(calls[0]?.[1])
    expect(body.get("client_id")).toBe("dyn-1")
    expect(body.get("client_secret")).toBe("issued")
  })

  it.each([
    ["the registry holds a different client", async () => ({ clientId: "other" })],
    ["the registry holds nothing", async () => undefined],
    ["no registry is composed at all", undefined],
  ])("fails callback reconstruction for a dynamic client when %s", async (_case, lookup) => {
    const original = await createMcpOAuthIntegration({
      pluginInstanceId: "plugin@sha256:abc",
      serverName: "docs",
      discovery: discovery({ client: { kind: "dynamic", clientId: "dyn-1" } }),
      callbackUrl: "https://claxedo.example/api/connections/callback",
      fetch: vi.fn(),
    })
    await expect(createMcpOAuthIntegrationFromAttempt({
      integrationId: original.decl.id,
      serverName: "docs",
      attemptContext: original.impl.auth.attemptContext,
      ...(lookup ? { dynamicRegistration: { lookup } } : {}),
      fetch: vi.fn(),
    })).rejects.toThrow("dynamic registration no longer matches")
  })
})
