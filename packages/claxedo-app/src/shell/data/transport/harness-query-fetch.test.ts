import { describe, expect, test } from "bun:test"
import { harnessQueryFetch } from "./harness-query-fetch"

describe("harnessQueryFetch", () => {
  test("returns the underlying request when no harness is selected", () => {
    const request = (() => Promise.resolve(new Response())) as typeof fetch

    expect(harnessQueryFetch({ request })).toBe(request)
  })

  test("adds the harness query parameter to string requests", async () => {
    const calls: string[] = []
    const request = ((url: RequestInfo | URL) => {
      calls.push(String(url))
      return Promise.resolve(new Response())
    }) as typeof fetch

    await harnessQueryFetch({
      request,
      harnessType: "claude",
      baseUrl: "https://server.test",
    })("/session/ses_1?directory=/repo")

    expect(calls).toEqual(["https://server.test/session/ses_1?directory=%2Frepo&harness=claude"])
  })

  test("adds the harness query parameter to Request inputs and preserves request metadata", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const request = ((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(new Response())
    }) as typeof fetch
    const controller = new AbortController()

    await harnessQueryFetch({
      request,
      harnessType: "opencode",
    })(new Request("https://server.test/session/ses_1/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
      signal: controller.signal,
    }))

    expect(calls[0]?.url).toBe("https://server.test/session/ses_1/message?harness=opencode")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toBeInstanceOf(Headers)
    expect(calls[0]?.init?.signal).toBe(controller.signal)
    expect(new TextDecoder().decode(calls[0]?.init?.body as ArrayBuffer)).toBe('{"text":"hello"}')
  })
})
