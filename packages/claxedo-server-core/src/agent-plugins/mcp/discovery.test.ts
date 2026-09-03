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


  it("accepts protected resource metadata that identifies the resource's ORIGIN, as Context7 does", async () => {
    // Live shape: the MCP endpoint is /mcp/oauth, the metadata resource is the
    // bare origin. RFC 9728 permits the broader identifier.
    const fetch = mappedFetch({
      "https://mcp.context7.test/mcp/oauth": new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.context7.test/.well-known/oauth-protected-resource"' },
      }),
      "https://mcp.context7.test/.well-known/oauth-protected-resource": json({
        resource: "https://mcp.context7.test",
        authorization_servers: ["https://clerk.context7.test"],
      }),
      "https://clerk.context7.test/.well-known/oauth-authorization-server": json({
        issuer: "https://clerk.context7.test",
        authorization_endpoint: "https://clerk.context7.test/oauth/authorize",
        token_endpoint: "https://clerk.context7.test/oauth/token",
        code_challenge_methods_supported: ["S256"],
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.context7.test/mcp/oauth",
      fetch,
      preRegistered: { "https://clerk.context7.test": { clientId: "claxedo" } },
    })).resolves.toMatchObject({
      status: "protected",
      // The resource parameter stays the exact MCP URL the runtime connects to.
      discovery: { resource: "https://mcp.context7.test/mcp/oauth", issuer: "https://clerk.context7.test" },
    })
  })

  it.each([
    ["a foreign origin", "https://attacker.example"],
    ["a path that is not a segment-boundary prefix", "https://mcp.example/mc"],
    ["a sibling path", "https://mcp.example/other"],
  ])("refuses protected resource metadata naming %s", async (_case, resource) => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource,
        authorization_servers: ["https://login.example"],
      }),
      "https://login.example/.well-known/oauth-authorization-server": json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      preRegistered: { "https://login.example": { clientId: "claxedo" } },
    })).rejects.toMatchObject({ code: "discovery-failed" } satisfies Partial<McpOAuthDiscoveryError>)
  })

  it("registers an RFC 7591 client once and reuses it through the registry on the next discovery", async () => {
    const registered = new Map<string, { clientId: string; clientSecret?: string }>()
    const registrationBodies: string[] = []
    const metadata = {
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": {
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example"],
      },
      "https://login.example/.well-known/oauth-authorization-server": {
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        registration_endpoint: "https://login.example/oauth2/register",
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      },
    } as Record<string, unknown>
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://mcp.example/mcp") return new Response(null, { status: 401 })
      if (url === "https://login.example/oauth2/register") {
        registrationBodies.push(String(init?.body))
        return Response.json({
          client_id: "dyn-client-1",
          client_id_issued_at: 1,
          redirect_uris: ["https://claxedo.example/api/claxedo/integrations/callback"],
        }, { status: 201 })
      }
      const found = metadata[url]
      return found ? json(found) : new Response(null, { status: 404 })
    })
    const clientMetadata = {
      client_name: "Claxedo",
      client_uri: "https://claxedo.example/",
      redirect_uris: ["https://claxedo.example/api/claxedo/integrations/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
    const port = {
      clientMetadata,
      lookup: vi.fn(async (issuer: string) => registered.get(issuer)),
      register: vi.fn(async (value: { issuer: string; registrationEndpoint: string; metadata: Record<string, unknown> }) => {
        const client = { clientId: value.metadata.client_id as string }
        registered.set(value.issuer, client)
        return client
      }),
    }

    const first = await discoverMcpOAuth({ resourceUrl: "https://mcp.example/mcp", fetch, dynamicRegistration: port })
    expect(first).toMatchObject({
      status: "protected",
      discovery: { client: { kind: "dynamic", clientId: "dyn-client-1" } },
    })
    // The registration request is exactly the deployment's client metadata, and
    // never carries a client_id the client chose for itself.
    expect(registrationBodies).toHaveLength(1)
    const body = JSON.parse(registrationBodies[0]) as Record<string, unknown>
    expect(body).toEqual(clientMetadata)
    expect(body.client_id).toBeUndefined()
    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({
      issuer: "https://login.example",
      registrationEndpoint: "https://login.example/oauth2/register",
    }))

    const second = await discoverMcpOAuth({ resourceUrl: "https://mcp.example/mcp", fetch, dynamicRegistration: port })
    expect(second).toMatchObject({ status: "protected", discovery: { client: { kind: "dynamic", clientId: "dyn-client-1" } } })
    expect(registrationBodies).toHaveLength(1)
    expect(port.register).toHaveBeenCalledTimes(1)
    expect(port.lookup).toHaveBeenCalledTimes(2)
  })

  it("carries an issued client secret from the registry into the discovery result", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example"],
      }),
      "https://login.example/.well-known/oauth-authorization-server": json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        registration_endpoint: "https://login.example/oauth2/register",
        code_challenge_methods_supported: ["S256"],
      }),
      "https://login.example/oauth2/register": () =>
        Response.json({ client_id: "dyn-2", client_secret: "issued-secret" }, { status: 201 }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      dynamicRegistration: {
        clientMetadata: { client_name: "Claxedo" },
        lookup: async () => undefined,
        register: async ({ metadata }) => ({
          clientId: metadata.client_id as string,
          clientSecret: metadata.client_secret as string,
        }),
      },
    })).resolves.toMatchObject({
      status: "protected",
      discovery: { client: { kind: "dynamic", clientId: "dyn-2", clientSecret: "issued-secret" } },
    })
  })

  it("still refuses an authorization server with no registration endpoint and no metadata-document support", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example"],
      }),
      "https://login.example/.well-known/oauth-authorization-server": json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
      }),
    })
    const port = {
      clientMetadata: { client_name: "Claxedo" },
      lookup: vi.fn(async () => undefined),
      register: vi.fn(async () => ({ clientId: "never" })),
    }
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      clientIdMetadataDocumentUrl: "https://claxedo.example/oauth/client.json",
      dynamicRegistration: port,
    })).rejects.toMatchObject({ code: "unsupported-client-registration" } satisfies Partial<McpOAuthDiscoveryError>)
    expect(port.lookup).not.toHaveBeenCalled()
    expect(port.register).not.toHaveBeenCalled()
  })

  it("refuses to dynamically register at an authorization server whose registration endpoint is unsafe", async () => {
    const fetch = mappedFetch({
      "https://mcp.example/mcp": new Response(null, { status: 401 }),
      "https://mcp.example/.well-known/oauth-protected-resource/mcp": json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://login.example"],
      }),
      "https://login.example/.well-known/oauth-authorization-server": json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        registration_endpoint: "http://169.254.169.254/register",
        code_challenge_methods_supported: ["S256"],
      }),
    })
    await expect(discoverMcpOAuth({
      resourceUrl: "https://mcp.example/mcp",
      fetch,
      dynamicRegistration: {
        clientMetadata: { client_name: "Claxedo" },
        lookup: async () => undefined,
        register: async () => ({ clientId: "never" }),
      },
    })).rejects.toMatchObject({ code: "unsupported-client-registration" } satisfies Partial<McpOAuthDiscoveryError>)
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
