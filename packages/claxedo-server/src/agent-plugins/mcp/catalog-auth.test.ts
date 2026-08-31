import { describe, expect, test, vi } from "vitest"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { hostedMcpCatalogAuthentication } from "./catalog-auth"

describe("hosted MCP catalog authentication projection", () => {
  test("distinguishes public, supported OAuth, and unsupported discovery without storing state", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://public.example/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: {} })
      if (url === "https://protected.example/mcp" && init?.method === "POST") {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer resource_metadata=\"https://protected.example/metadata\"" },
        })
      }
      if (url === "https://protected.example/metadata") {
        return Response.json({ resource: "https://protected.example/mcp", authorization_servers: ["https://login.example"] })
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
    const inspect = hostedMcpCatalogAuthentication({
      callbackUrl: "https://claxedo.example/api/claxedo/integrations/callback",
      fetch,
      preRegistered: { "https://login.example": { clientId: "claxedo" } },
    })

    await expect(inspect({
      pluginInstanceId: "collection:docs",
      server: { name: "public", type: "streamable-http", url: "https://public.example/mcp" },
    })).resolves.toEqual({ state: "public" })

    const integrationId = await mcpOAuthIntegrationId({ pluginInstanceId: "collection:docs", serverName: "protected" })
    await expect(inspect({
      pluginInstanceId: "collection:docs",
      server: { name: "protected", type: "streamable-http", url: "https://protected.example/mcp" },
    })).resolves.toEqual({ state: "oauth", integrationId })

    await expect(inspect({
      pluginInstanceId: "collection:docs",
      server: { name: "legacy", type: "sse", url: "https://public.example/mcp" },
    })).resolves.toEqual({ state: "unavailable", reason: "mcp_transport_unsupported" })
  })

  test("keeps a protected server connectable when the user must choose an issuer", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://protected.example/mcp") return new Response(null, { status: 401 })
      if (url === "https://protected.example/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: "https://protected.example/mcp",
          authorization_servers: ["https://one.example", "https://two.example"],
        })
      }
      if (url === "https://one.example/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://one.example",
          authorization_endpoint: "https://one.example/authorize",
          token_endpoint: "https://one.example/token",
          code_challenge_methods_supported: ["S256"],
        })
      }
      if (url === "https://two.example/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://two.example",
          authorization_endpoint: "https://two.example/authorize",
          token_endpoint: "https://two.example/token",
          code_challenge_methods_supported: ["S256"],
        })
      }
      return new Response(null, { status: 404 })
    })
    const inspect = hostedMcpCatalogAuthentication({
      callbackUrl: "https://claxedo.example/api/claxedo/integrations/callback",
      fetch,
      preRegistered: {
        "https://one.example": { clientId: "one" },
        "https://two.example": { clientId: "two" },
      },
    })
    const integrationId = await mcpOAuthIntegrationId({
      pluginInstanceId: "collection:docs",
      serverName: "protected",
    })

    await expect(inspect({
      pluginInstanceId: "collection:docs",
      server: { name: "protected", type: "streamable-http", url: "https://protected.example/mcp" },
    })).resolves.toEqual({
      state: "oauth",
      integrationId,
      issuers: ["https://one.example", "https://two.example"],
    })
  })
})
