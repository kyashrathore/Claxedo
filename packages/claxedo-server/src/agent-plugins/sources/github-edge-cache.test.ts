import { describe, expect, test, vi } from "vitest"
import { githubEdgeCachedFetch, type EdgeCache } from "./github-edge-cache"

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

const SHA = "a".repeat(40)

describe("GitHub edge cache", () => {
  test("a ref lookup is fetched once and served from the cache with a one-minute lifetime", async () => {
    const { cache, store } = fakeCache()
    const upstream = vi.fn(async () => new Response(JSON.stringify({ sha: SHA }), { status: 200, headers: { "content-type": "application/json" } }))
    const fetcher = githubEdgeCachedFetch({ cache: () => cache, fetch: upstream })
    const url = "https://api.github.com/repos/acme/plugins/commits/main"
    await (await fetcher(url, { headers: { accept: "application/vnd.github+json" } })).json()
    const second = await fetcher(url)
    expect(await second.json()).toEqual({ sha: SHA })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(store.get(url)?.headers.get("cache-control")).toBe("public, max-age=60")
  })

  test("an archive by commit is cached for a day; a failed download is not cached", async () => {
    const { cache, store } = fakeCache()
    let status = 500
    const upstream = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status }))
    const fetcher = githubEdgeCachedFetch({ cache: () => cache, fetch: upstream })
    const url = `https://codeload.github.com/acme/plugins/zip/${SHA}`
    expect((await fetcher(url)).status).toBe(500)
    expect(store.size).toBe(0)
    status = 200
    expect((await fetcher(url)).status).toBe(200)
    expect(store.get(url)?.headers.get("cache-control")).toBe("public, max-age=86400")
    await fetcher(url)
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  test("other requests, and every request without an edge cache, go straight upstream", async () => {
    const upstream = vi.fn(async () => new Response("ok"))
    const passthrough = githubEdgeCachedFetch({ cache: () => undefined, fetch: upstream })
    await passthrough("https://api.github.com/repos/acme/plugins/commits/main")
    await passthrough("https://api.github.com/repos/acme/plugins/commits/main")
    const { cache, store } = fakeCache()
    const cached = githubEdgeCachedFetch({ cache: () => cache, fetch: upstream })
    await cached("https://example.test/anything")
    await cached("https://codeload.github.com/acme/plugins/zip/main")
    expect(upstream).toHaveBeenCalledTimes(4)
    expect(store.size).toBe(0)
  })
})
