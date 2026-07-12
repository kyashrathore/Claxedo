import { beforeEach, describe, expect, test, mock } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let shouldFail = false
let failStatus = 500
let failText = "Request failed"
let okContentType = "application/json"
let okText = "{}"

mock.module("@/platform/api/api", () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (shouldFail) {
      return new Response(failText, {
        status: failStatus,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(okText, {
      status: 200,
      headers: { "Content-Type": okContentType },
    })
  },
  getClaxedoServerUrl: () => "http://test.local",
  getDefaultBaseUrl: () => "http://test.local",
  normalizeUrl: (input?: string) => input?.replace(/\/+$/, ""),
  isDemoMode: () => false,
  isDemoPath: (path: string) => path === "/demo" || path.startsWith("/demo/"),
  isEmbedMode: () => false,
  fixDir: (input: string | undefined) => input?.trim() || undefined,
  api: {},
}))

// Import AFTER mock registration — no dynamic import, no cache busting
const { arenaApi } = await import("./arena-api")

beforeEach(() => {
  calls.length = 0
  shouldFail = false
  failStatus = 500
  failText = "Request failed"
  okContentType = "application/json"
  okText = "{}"
})

describe("arenaApi", () => {
  test("start(id, input) calls POST /:id/arena/start", async () => {
    const input = {
      directory: "/repo",
      parent_session_id: "ses-parent",
      config: {
        max_rounds: 2,
        agents: [{ name: "builder", role: "implementer", duty: "build", model: "opencode/big-pickle" }],
      },
    }
    await arenaApi.start("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/start")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("state(id) calls GET /:id/arena/state", async () => {
    await arenaApi.state("p1")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/state")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("message(id, input) calls POST /:id/arena/message", async () => {
    const input = { text: "hello", targets: ["builder"] }
    await arenaApi.message("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/message")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("control(id, input) calls POST /:id/arena/control", async () => {
    const input = { action: "pause" as const }
    await arenaApi.control("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/control")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("eventsUrl(id, directory?) builds expected SSE URL", () => {
    expect(arenaApi.eventsUrl("p1")).toBe("http://test.local/pages/p1/arena/events")
    expect(arenaApi.eventsUrl("p1", "/tmp/repo a")).toBe(
      "http://test.local/pages/p1/arena/events?directory=%2Ftmp%2Frepo%20a",
    )
  })

  test("all methods include Content-Type: application/json header", async () => {
    await arenaApi.start("x", { config: { agents: [{ name: "a", role: "r", duty: "d", model: "p/m" }] } })
    await arenaApi.state("x")
    await arenaApi.message("x", { text: "hello" })
    await arenaApi.control("x", { action: "pause" })

    expect(calls).toHaveLength(4)
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers).toBeDefined()
      expect(headers.get("Content-Type")).toBe("application/json")
    }
  })
})
