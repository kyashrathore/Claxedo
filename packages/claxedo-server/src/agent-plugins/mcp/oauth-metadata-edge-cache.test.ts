import { describe, expect, test, vi } from "vitest"
import type { EdgeCache } from "../edge-cached-fetch"
import { oauthMetadataEdgeCachedFetch } from "./oauth-metadata-edge-cache"

const keyOf = (request: RequestInfo | URL) =>
  typeof request === "string" ? request : request instanceof URL ? request.href : request.url

function fakeCache() {
  const store = new Map<string, Response>()
  const cache: EdgeCache = {
    match: async (request) => store.get(keyOf(request))?.clone(),
    put: async (request, response) => { store.set(keyOf(request), response) },
  }
  return { cache, store }
}

describe("MCP OAuth metadata edge cache", () => {
  test("well-known documents and their 404s are served from the cache for ten minutes", async () => {
    const { cache, store } = fakeCache()
    const upstream = vi.fn(async (url: string) => url.endsWith("/oauth-authorization-server")
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify({ issuer: "https://issuer.test" }), { status: 200, headers: { "content-type": "application/json" } }))
    const fetcher = oauthMetadataEdgeCachedFetch({ cache: () => cache, fetch: upstream })
    const missing = "https://issuer.test/.well-known/oauth-authorization-server"
    const present = "https://issuer.test/.well-known/openid-configuration"
    expect((await fetcher(missing, { headers: { accept: "application/json" } })).status).toBe(404)
    expect((await fetcher(missing)).status).toBe(404)
    expect(await (await fetcher(present)).json()).toEqual({ issuer: "https://issuer.test" })
    expect(await (await fetcher(present)).json()).toEqual({ issuer: "https://issuer.test" })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(store.get(missing)?.headers.get("cache-control")).toBe("public, max-age=600")
    expect(store.get(present)?.headers.get("cache-control")).toBe("public, max-age=600")
  })

  test("the probe POST, a server error, and non-well-known reads are never cached", async () => {
    const { cache, store } = fakeCache()
    const upstream = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"' } })
      : new Response("boom", { status: url.includes("/.well-known/") ? 500 : 200 }))
    const fetcher = oauthMetadataEdgeCachedFetch({ cache: () => cache, fetch: upstream })
    await fetcher("https://mcp.test/mcp", { method: "POST", body: "{}" })
    await fetcher("https://mcp.test/mcp", { method: "POST", body: "{}" })
    await fetcher("https://mcp.test/.well-known/oauth-protected-resource")
    await fetcher("https://mcp.test/.well-known/oauth-protected-resource")
    await fetcher("https://mcp.test/anything")
    expect(upstream).toHaveBeenCalledTimes(5)
    expect(store.size).toBe(0)
  })
})
