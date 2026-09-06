import { describe, expect, test } from "bun:test"
import { harnessQueryFetch } from "./harness-query-fetch"
import { requestUrl } from "@/lib/url"

describe("harnessQueryFetch", () => {
  test("returns the underlying request when no harness is selected", () => {
    const request = (() => Promise.resolve(new Response())) as typeof fetch

    expect(harnessQueryFetch({ request })).toBe(request)
  })

  test("adds the harness query parameter to string requests", async () => {
    const calls: string[] = []
    const request = ((url: RequestInfo | URL) => {
      calls.push(requestUrl(url))
      return Promise.resolve(new Response())
    }) as typeof fetch

    await harnessQueryFetch({
      request,
      harnessType: { kind: "native", harnessId: "claude" },
      baseUrl: "https://server.test",
    })("/session/ses_1?directory=/repo")

    expect(calls).toEqual(["https://server.test/session/ses_1?directory=%2Frepo&nativeHarness=claude"])
  })

  test("adds the harness query parameter to Request inputs and preserves request metadata", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const request = ((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init })
      return Promise.resolve(new Response())
    }) as typeof fetch
    const controller = new AbortController()

    await harnessQueryFetch({
      request,
      harnessType: { kind: "connection", connectionId: "external-opencode" },
    })(new Request("https://server.test/session/ses_1/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
      signal: controller.signal,
    }))

    expect(calls[0]?.url).toBe("https://server.test/session/ses_1/message?connectionId=external-opencode")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json")
    const signal = calls[0]?.init?.signal
    expect(signal?.aborted).toBe(false)
    controller.abort("navigation changed")
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe("navigation changed")
    expect(new TextDecoder().decode(calls[0]?.init?.body as ArrayBuffer)).toBe('{"text":"hello"}')
  })
})
