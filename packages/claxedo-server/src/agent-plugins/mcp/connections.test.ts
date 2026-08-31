import { describe, expect, test, vi } from "vitest"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { hostedAgentPluginConnectionIntegrations } from "./connections"

const auth = {
  mode: "signed",
  token: "signed-token",
  user: { subject: "clerk-user", issuer: "https://clerk.example", tokenIdentifier: "token" },
} as const

function artifact(resource = "https://mcp.example/mcp") {
  return {
    digest: "sha256:user",
    tree: [],
    plugin: {
      root: ".",
      manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
      skills: [],
      mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http", url: resource }] },
    },
  } as never
}

function oauthFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://mcp.example/mcp" && init?.method === "POST") {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.example/.well-known/oauth-protected-resource/mcp\"" },
      })
    }
    if (url === "https://mcp.example/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://login.example"] })
    }
    if (url === "https://login.example/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
      })
    }
    return new Response(null, { status: 404 })
  })
}

describe("hosted Agent Plugin Connections adapter", () => {
  test("lists only retained streamable-http servers whose OAuth path is supported", async () => {
    const fetch = oauthFetch()
    const artifacts = { get: vi.fn(async (digest: string) => digest === "sha256:user" ? artifact() : undefined) }
    const activations = {
      listKnown: vi.fn(async () => [{
        pluginInstanceId: "collection:docs",
        pins: {
          user: { digest: "sha256:user", sourceId: "personal", relativePath: "docs", sourceRevision: "a" },
          organization: { digest: "sha256:org", sourceId: "org", relativePath: "docs", sourceRevision: "b" },
        },
      }]),
    }
    const provider = hostedAgentPluginConnectionIntegrations({
      activations: activations as never,
      artifacts: artifacts as never,
      oauth: {
        callbackUrl: "https://claxedo.example/api/claxedo/integrations/callback",
        fetch,
        preRegistered: { "https://login.example": { clientId: "claxedo" } },
      },
    })

    const listed = await provider({ ownerUserId: "user-1", orgId: "org-1", auth })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ decl: { name: "docs MCP", capabilities: ["mcp"] }, impl: {} })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(artifacts.get).toHaveBeenCalledWith("sha256:user")

    const integrationId = await mcpOAuthIntegrationId({ pluginInstanceId: "collection:docs", serverName: "docs" })
    const selected = await provider({
      ownerUserId: "user-1",
      orgId: "org-1",
      auth,
      integrationId,
      request: new Request("https://claxedo.example/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer: "https://login.example" }),
      }),
    })
    expect(selected).toHaveLength(1)
    expect(selected[0]?.impl.authorize).toEqual(expect.any(Function))
    expect(selected[0]?.impl.attemptContext).toMatchObject({
      resource: "https://mcp.example/mcp",
      issuer: "https://login.example",
    })
  })

  test("does not create an OAuth path for a public MCP server", async () => {
    const provider = hostedAgentPluginConnectionIntegrations({
      activations: { listKnown: async () => [{
        pluginInstanceId: "collection:docs",
        pins: { user: { digest: "sha256:user" } },
      }] } as never,
      artifacts: { get: async () => artifact() } as never,
      oauth: {
        callbackUrl: "https://claxedo.example/api/claxedo/integrations/callback",
        fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
      },
    })
    const integrationId = await mcpOAuthIntegrationId({ pluginInstanceId: "collection:docs", serverName: "docs" })
    const selected = await provider({ ownerUserId: "user-1", orgId: "org-1", auth, integrationId })
    expect(selected).toHaveLength(0)
  })
})
