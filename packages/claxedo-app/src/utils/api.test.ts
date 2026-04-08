import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

let token: string | null = null
const calls: Array<{
  auth: string | null
  dir: string | null
  url: string
}> = []
const raw = globalThis.fetch

mock.module("./auth-client", () => ({
  getAuthToken: async () => token,
}))

// Use an absolute path with a cache-busting query to bypass any stale
// mock.module("./api") registered by other test files (pages-api.test.ts,
// workgraph-api.test.ts).  Bun treats distinct specifiers as distinct
// module instances, so this always evaluates the real api.ts.
const {
  authFetch,
  configureApiRuntime,
  fixDir,
  getDefaultBaseUrl,
  isDemoMode,
  isDemoPath,
  isEmbedMode,
  resetApiRuntime,
} = await import(`${import.meta.dir}/api.ts?test`)

beforeEach(() => {
  window.location.href = "http://localhost/"
  token = null
  calls.length = 0
  resetApiRuntime()
  globalThis.fetch = (async (input, init) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    calls.push({
      auth: req.headers.get("Authorization"),
      dir: req.headers.get("x-opencode-directory"),
      url: req.url,
    })
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
})

describe("demo routing", () => {

  test("matches only the demo path prefix", () => {
    expect(isDemoPath("/")).toBe(false)
    expect(isDemoPath("/demo")).toBe(true)
    expect(isDemoPath("/demo/")).toBe(true)
    expect(isDemoPath("/demo/foo")).toBe(true)
    expect(isDemoPath("/foo/demo")).toBe(false)
  })

  test("ignores the old demo query on the live root", () => {
    window.location.href = "http://localhost/?demo=1"
    expect(isDemoMode()).toBe(false)
  })

  test("enables demo mode under /demo", () => {
    window.location.href = "http://localhost/demo/?demo=1"
    expect(isDemoMode()).toBe(true)
  })

  test("keeps embed detection query-based", () => {
    window.location.href = "http://localhost/demo/?embed=1"
    expect(isEmbedMode()).toBe(true)
  })
})

describe("authFetch", () => {
  test("prefers bearer auth over configured desktop basic auth", async () => {
    token = "tok_123"
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe("Bearer tok_123")
  })

  test("uses configured desktop basic auth when no token exists", async () => {
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe(`Basic ${btoa("opencode:desk-secret")}`)
  })

  test("preserves an explicit authorization header", async () => {
    token = "tok_123"
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test", {
      headers: { Authorization: "Bearer custom" },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.auth).toBe("Bearer custom")
  })

  test("does not inject x-opencode-directory from window globals", async () => {
    window.__OPENCODE__ ??= {}
    window.__OPENCODE__.activeDirectory = "/tmp/project"

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.dir).toBeNull()
  })
})

describe("getDefaultBaseUrl", () => {
  test("prefers configured runtime base url over fallback detection", () => {
    configureApiRuntime({ baseUrl: "http://127.0.0.1:7777/" })
    expect(getDefaultBaseUrl()).toBe("http://127.0.0.1:7777")
  })
})

describe("fixDir", () => {
  test("preserves absolute paths", () => {
    expect(fixDir("/Users/yash/project")).toBe("/Users/yash/project")
  })

  test("restores a leading slash for workspace paths", () => {
    expect(fixDir("Users/yash/project")).toBe("/Users/yash/project")
  })

  test("recovers embedded absolute paths from temp prefixes", () => {
    expect(fixDir("tmp/dev/Users/yash/project")).toBe("/Users/yash/project")
  })
})

afterAll(() => {
  globalThis.fetch = raw
})
