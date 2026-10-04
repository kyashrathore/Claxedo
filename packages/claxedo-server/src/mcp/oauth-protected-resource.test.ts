import { describe, expect, test } from "vitest"
import { CLAXEDO_MCP_PATH } from "@claxedo/mcp"
import { MCP_SCOPES } from "@claxedo/mcp/context"

import { CLAXEDO_MCP_OAUTH_SCOPES, claxedoMcpResource } from "../platform/auth/mcp-oauth-scopes"
import { OAuthProtectedResourceRoutes } from "./oauth-protected-resource"

const HOSTED = OAuthProtectedResourceRoutes({
  controlPlaneOrigin: () => "https://api.claxedo.test",
  authorizationServer: () => "https://api.claxedo.test/api/auth",
})

describe("protected resource metadata", () => {
  test("answers RFC 9728 metadata at the path the 401 challenge names", async () => {
    const response = await HOSTED.request("/.well-known/oauth-protected-resource")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      resource: "https://api.claxedo.test/api/claxedo/mcp",
      authorization_servers: ["https://api.claxedo.test/api/auth"],
      scopes_supported: ["claxedo:read", "claxedo:act", "claxedo:approve", "claxedo:admin"],
      bearer_methods_supported: ["header"],
    })
  })

  test("answers the same document at the RFC 9728 path-inserted URL", async () => {
    const inserted = await HOSTED.request("/.well-known/oauth-protected-resource/api/claxedo/mcp")

    expect(inserted.status).toBe(200)
    await expect(inserted.json()).resolves.toMatchObject({
      resource: "https://api.claxedo.test/api/claxedo/mcp",
    })
  })

  test("names another resource's metadata path as nothing this deployment protects", async () => {
    const other = await HOSTED.request("/.well-known/oauth-protected-resource/api/other")

    expect(other.status).toBe(404)
  })

  test("a deployment that resolves per request answers with the origin the request reached", async () => {
    const node = OAuthProtectedResourceRoutes({
      controlPlaneOrigin: (origin) => origin,
      authorizationServer: (origin) => `${origin}/api/auth`,
    })

    const response = await node.request("http://127.0.0.1:2593/.well-known/oauth-protected-resource")

    await expect(response.json()).resolves.toMatchObject({
      resource: "http://127.0.0.1:2593/api/claxedo/mcp",
      authorization_servers: ["http://127.0.0.1:2593/api/auth"],
    })
  })
})

describe("scope and resource drift", () => {
  /**
   * `mcp-oauth-scopes.ts` spells both out rather than reading `@claxedo/mcp`,
   * because every auth composition is in its closure and that package carries
   * Hono and the MCP SDK. These are the reads that module skips.
   */
  test("the OAuth scope names are the MCP credential's scopes", () => {
    expect(CLAXEDO_MCP_OAUTH_SCOPES).toEqual(MCP_SCOPES.map((scope) => `claxedo:${scope}`))
  })

  test("the resource identifier is the MCP endpoint's own URL", () => {
    expect(claxedoMcpResource("https://api.claxedo.test")).toBe(`https://api.claxedo.test${CLAXEDO_MCP_PATH}`)
  })
})
