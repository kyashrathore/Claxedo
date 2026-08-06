import { afterEach, describe, expect, test } from "bun:test"
import {
  checkOpenCodeServerHealthCached,
  normalizeServerUrl,
  opencodeServerHealthQueryKey,
  resetOpenCodeServerHealthCacheForTest,
} from "@/app/connection/server"

afterEach(() => {
  resetOpenCodeServerHealthCacheForTest()
})

describe("normalizeServerUrl", () => {
  test("rewrites local web dev frontend ports to the backend", () => {
    expect(normalizeServerUrl("http://localhost:4444")).toBe("http://localhost:2593")
    expect(normalizeServerUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:2593")
  })

  test("leaves non-dev hosts and ports alone", () => {
    expect(normalizeServerUrl("http://localhost:3001")).toBe("http://localhost:3001")
    expect(normalizeServerUrl("https://example.com:4444/")).toBe("https://example.com:4444")
  })
})

describe("checkOpenCodeServerHealthCached", () => {
  test("dedupes OpenCode global health checks through Query", async () => {
    let calls = 0
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe("https://opencode.example.test/global/health")
      return Response.json({ healthy: true, version: "1.2.3" })
    }
    const [first, second] = await Promise.all([
      checkOpenCodeServerHealthCached({
        url: "https://opencode.example.test",
        fetch,
      }),
      checkOpenCodeServerHealthCached({
        url: "https://opencode.example.test",
        fetch,
      }),
    ])

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(calls).toBe(1)
  })

  test("does not place raw URL credentials in the health query key", () => {
    expect(JSON.stringify(opencodeServerHealthQueryKey({
      fetchKey: "test",
      url: "https://user:secret@opencode.example.test/",
    }))).not.toContain("secret")
  })
})

describe("source ownership", () => {
  test("keeps context server health freshness state in the query client", async () => {
    const source = await Bun.file(new URL("../connection/server.tsx", import.meta.url)).text()

    expect(await Bun.file(new URL("../../overrides/context/server.tsx", import.meta.url)).exists()).toBe(false)
    expect(source).not.toContain("healthCache = new Map")
    expect(source).not.toContain("const healthCache")
    expect(source).not.toContain("setInterval(")
    expect(source).toContain("opencodeServerHealthPollQueryKey")
  })
})
