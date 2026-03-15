import { describe, expect, test } from "bun:test"
import { checkServerHealth } from "./server-health"

const server = { url: "http://localhost:4096" }

describe("checkServerHealth", () => {
  test("returns healthy response with version", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("returns unhealthy when request fails", async () => {
    const fetch = (async () => {
      throw new Error("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: false })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const abort = new AbortController()
    await checkServerHealth(server, fetch, { signal: abort.signal })

    expect(signal).toBe(abort.signal)
  })
})
