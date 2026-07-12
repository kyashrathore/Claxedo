import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { checkServerHealth, checkServerHealthCached, serverHealthQueryOptions } from "./server-health"

afterEach(() => {
  queryClient.clear()
})

describe("checkServerHealth", () => {
  test("uses the health route and preserves bearer header", async () => {
    const calls: { url: string; authorization: string | null }[] = []
    const result = await checkServerHealth(
      { url: "https://control.example.test/", password: "secret" },
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        })
        return Response.json({ healthy: true, version: "1.2.3" })
      },
    )

    expect(result).toEqual({ healthy: true, version: "1.2.3" })
    expect(calls).toEqual([{
      url: "https://control.example.test/api/claxedo/health",
      authorization: "Bearer secret",
    }])
  })

  test("returns unhealthy when the server rejects the health request", async () => {
    const result = await checkServerHealth(
      { url: "https://control.example.test" },
      async () => new Response("unavailable", { status: 503 }),
    )

    expect(result).toEqual({ healthy: false })
  })

  test("dedupes in-flight cached checks through Query", async () => {
    let calls = 0
    const [a, b] = await Promise.all([
      checkServerHealthCached({ url: "https://dedupe.example.test" }, async () => {
        calls += 1
        return Response.json({ healthy: true, version: "1.2.3" })
      }),
      checkServerHealthCached({ url: "https://dedupe.example.test" }, async () => {
        calls += 1
        return Response.json({ healthy: true, version: "1.2.3" })
      }),
    ])

    expect(a).toEqual({ healthy: true, version: "1.2.3" })
    expect(b).toEqual({ healthy: true, version: "1.2.3" })
    expect(calls).toBe(1)
  })

  test("reuses fresh cached checks and refreshes stale checks", async () => {
    let calls = 0
    let now = 1_000
    const fetch = async () => {
      calls += 1
      return Response.json({ healthy: true, version: `${calls}` })
    }

    expect(await checkServerHealthCached({ url: "https://fresh.example.test" }, fetch, () => now)).toEqual({
      healthy: true,
      version: "1",
    })
    expect(await checkServerHealthCached({ url: "https://fresh.example.test" }, fetch, () => now + 749)).toEqual({
      healthy: true,
      version: "1",
    })

    now += 751

    expect(await checkServerHealthCached({ url: "https://fresh.example.test" }, fetch, () => now)).toEqual({
      healthy: true,
      version: "2",
    })
    expect(calls).toBe(2)
  })

  test("keeps query result data separate from the in-flight cache entry", async () => {
    let calls = 0
    const options = serverHealthQueryOptions({
      server: { url: "https://query-cache.example.test" },
      fetch: async () => {
        calls += 1
        return Response.json({ healthy: true, version: "fresh" })
      },
    })
    queryClient.setQueryData(options.queryKey, { healthy: false })

    await expect(options.queryFn()).resolves.toEqual({ healthy: true, version: "fresh" })
    expect(calls).toBe(1)
  })
})

describe("source ownership", () => {
  test("keeps server health cache state in the query client", async () => {
    const source = await Bun.file(new URL("./server-health.ts", import.meta.url)).text()
    const dialogSource = await Bun.file(new URL("../dialogs/select-server.tsx", import.meta.url)).text()

    expect(source).not.toContain("healthCache = new Map")
    expect(source).not.toContain("const healthCache")
    expect(source).not.toContain("RuntimeGateway")
    expect(dialogSource).not.toContain("setInterval(")
    expect(dialogSource).toContain("serverHealthQueryOptions")
  })
})
