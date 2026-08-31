import { describe, expect, it, vi } from "vitest"
import { discoverMcpOAuth, McpOAuthDiscoveryError } from "./discovery"

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  ...init,
})

function mappedFetch(responses: Record<string, Response | (() => Response)>) {
  return vi.fn(async (url: string) => {
    const found = responses[url]
    if (!found) return new Response(null, { status: 404 })
    return typeof found === "function" ? found() : found.clone()
  })
}

describe("MCP OAuth discovery", () => {
  it("recognizes a public MCP endpoint without touching metadata", async () => {
    const fetch = mappedFetch({ "https://mcp.example/mcp": json({ jsonrpc: "2.0" }) })
    await expect(discoverMcpOAuth({ resourceUrl: "https://mcp.example/mcp", fetch })).resolves.toEqual({ status: "public" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("uses the challenge metadata pointer, challenge scopes, exact issuer binding, and pre-registration", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/resource.json", scope="read write"' },
      }),
      "https://mcp.example/resource.json": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example/tenant"],
        scopes_supported: ["ignored:fallback"],
      }),
      "https://login.example/.well-known/oauth-authorization-server/tenant": json({
        issuer: "https://login.example/tenant",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      preRegistered: { "https://login.example/tenant": { clientId: "claxedo", clientSecret: "secret" } },
    })).resolves.toEqual({
      status: "protected",
      discovery: {
        resource: "https://mcp.example/mcp",
        resourceMetadataUrl: "https://mcp.example/resource.json",
        issuer: "https://login.example/tenant",
        authorizationEndpoint: "https://login.example/authorize",
        tokenEndpoint: "https://login.example/token",
        authorizationResponseIssuerParameterSupported: true,
        scopes: ["read", "write"],
        client: { kind: "pre-registered", clientId: "claxedo", clientSecret: "secret" },
      },
    })
  })

  it("tries every required path-issuer metadata location in order and falls back to protected-resource scopes", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example/tenant"],
        scopes_supported: ["basic"],
      }),
      "https://login.example/.well-known/openid-configuration/tenant": json({
        issuer: "https://login.example/tenant",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      }),
    })
    const result = await discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      clientIdMetadataDocumentUrl: "https://claxedo.example/oauth/client.json",
    })
    expect(result.status === "protected" && result.discovery.scopes).toEqual(["basic"])
    expect(result.status === "protected" && result.discovery.client).toEqual({
      kind: "client-id-metadata-document",
      clientId: "https://claxedo.example/oauth/client.json",
    })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://mcp.example/mcp",
      "https://mcp.example/.well-known/oauth-protected-resource/mcp",
      "https://login.example/.well-known/oauth-authorization-server/tenant",
      "https://login.example/.well-known/openid-configuration/tenant",
    ])
  })

  it("requires an explicit issuer choice when protected metadata offers more than one", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://one.example", "https://two.example"],
      }),
      "https://one.example/.well-known/oauth-authorization-server": json({
        issuer: "https://one.example",
        authorization_endpoint: "https://one.example/authorize",
        token_endpoint: "https://one.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
      "https://two.example/.well-known/oauth-authorization-server": json({
        issuer: "https://two.example",
        authorization_endpoint: "https://two.example/authorize",
        token_endpoint: "https://two.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      preRegistered: {
        "https://one.example": { clientId: "one" },
        "https://two.example": { clientId: "two" },
      },
    })).rejects.toMatchObject({
      code: "ambiguous-issuer",
      issuers: ["https://one.example", "https://two.example"],
    } satisfies Partial<McpOAuthDiscoveryError>)
  })

  it("automatically selects the only issuer compatible with configured registration", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://unsupported.example", "https://ready.example"],
      }),
      "https://unsupported.example/.well-known/oauth-authorization-server": json({
        issuer: "https://unsupported.example",
        authorization_endpoint: "https://unsupported.example/authorize",
        token_endpoint: "https://unsupported.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
      "https://ready.example/.well-known/oauth-authorization-server": json({
        issuer: "https://ready.example",
        authorization_endpoint: "https://ready.example/authorize",
        token_endpoint: "https://ready.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
    })

    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      preRegistered: { "https://ready.example": { clientId: "claxedo" } },
    })).resolves.toMatchObject({
      status: "protected",
      discovery: { issuer: "https://ready.example" },
    })
  })

  it("refuses authorization metadata that does not advertise PKCE S256", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://login.example"] }),
      "https://login.example/.well-known/oauth-authorization-server": json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      preRegistered: { "https://login.example": { clientId: "claxedo" } },
    })).rejects.toMatchObject({ code: "pkce-unsupported" } satisfies Partial<McpOAuthDiscoveryError>)
  })

  it.each([
    "http://mcp.example/mcp",
    "https://10.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@mcp.example/mcp",
    "https://mcp.example/mcp#fragment",
  ])("rejects an unsafe resource before fetching: %s", async (resourceUrl) => {
    const fetch = vi.fn()
    await expect(discoverMcpOAuth({ resourceUrl, fetch })).rejects.toMatchObject({ code: "invalid-resource" } satisfies Partial<McpOAuthDiscoveryError>)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("permits explicit HTTP loopback for local MCP servers", async () => {
    const fetch = mappedFetch({ "http://127.0.0.1:4567/mcp": json({ jsonrpc: "2.0" }) })
    await expect(discoverMcpOAuth({ resourceUrl: "http://127.0.0.1:4567/mcp", fetch })).resolves.toEqual({ status: "public" })
  })

  it("rejects oversized metadata even without a Content-Length header", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": () => new Response(new Uint8Array(256 * 1024 + 1)),
    })
    await expect(discoverMcpOAuth({ resourceUrl: "https://mcp.example/mcp", fetch })).rejects.toMatchObject({ code: "discovery-failed" } satisfies Partial<McpOAuthDiscoveryError>)
  })
})
