import { beforeEach, describe, expect, test, mock } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let shouldFail = false
let failText = "Request failed"
let okContentType = "application/json"
let okJson: unknown = {}
let okText = "{}"

mock.module("./api", () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (shouldFail) {
      return {
        ok: false,
        status: 500,
        text: async () => failText,
        json: async () => ({}),
        headers: { get: () => "application/json" },
      } as Response
    }
    return {
      ok: true,
      status: 200,
      text: async () => okText,
      json: async () => okJson,
      headers: { get: () => okContentType },
    } as Response
  },
  getClaxedoServerUrl: () => "http://test.local",
  getDefaultBaseUrl: () => "http://test.local",
  // Include all api.ts exports so the mock doesn't strip them for other test
  // files that import from the same resolved module (e.g. persist.test.ts).
  isDemoMode: () => {
    if (typeof window === "undefined") return false
    const p = window.location.pathname
    return p === "/demo" || p.startsWith("/demo/")
  },
  isDemoPath: (path: string) => path === "/demo" || path.startsWith("/demo/"),
  isEmbedMode: () => {
    if (typeof window === "undefined") return false
    return new URLSearchParams(window.location.search).has("embed")
  },
  fixDir: (input: string | undefined) => {
    const txt = input?.trim()
    if (!txt) return undefined
    if (txt.startsWith("/")) return txt
    const hit = ["/Users/", "/private/", "/Volumes/", "/home/"]
      .map((item) => txt.indexOf(item))
      .filter((item) => item >= 0)
      .sort((a, b) => a - b)[0]
    if (hit !== undefined) return txt.slice(hit)
    if (/^(Users|private|Volumes|home)\//.test(txt)) return `/${txt}`
    return txt
  },
  api: {},
}))

// Import AFTER mock registration — no dynamic import, no cache busting
const { pagesApi } = await import("./pages-api")

beforeEach(() => {
  calls.length = 0
  shouldFail = false
  failText = "Request failed"
  okContentType = "application/json"
  okJson = {}
  okText = "{}"
})

describe("pagesApi", () => {
  test("list() calls GET http://test.local/pages", async () => {
    await pagesApi.list()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages")
    // No method means GET (fetch default)
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("get(id) calls GET http://test.local/pages/my-id", async () => {
    await pagesApi.get("my-id")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/my-id")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("list(input) appends scope query params", async () => {
    await pagesApi.list({ scope: "project", directory: "/repo", project_id: "proj_1" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages?scope=project&project_id=proj_1&directory=%2Frepo")
  })

  test("create(title) calls POST with { title } body", async () => {
    await pagesApi.create("My Page")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: "My Page" }))
  })

  test("create(input) sends project-aware body", async () => {
    await pagesApi.create({ title: "My Page", project_id: "proj_1", directory: "/repo" })
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: "My Page", project_id: "proj_1", directory: "/repo" }))
  })

  test("update(id, patch) calls PATCH with patch body", async () => {
    const patch = { title: "Updated", content: "New content" }
    await pagesApi.update("pg-1", patch)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/pg-1")
    expect(calls[0].init?.method).toBe("PATCH")
    expect(calls[0].init?.body).toBe(JSON.stringify(patch))
  })

  test("delete(id) calls DELETE http://test.local/pages/my-id", async () => {
    await pagesApi.delete("my-id")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/my-id")
    expect(calls[0].init?.method).toBe("DELETE")
  })

  test("listStatuses(input) appends scope query params", async () => {
    await pagesApi.listStatuses({ scope: "project", project_id: "proj_1", directory: "/repo" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/statuses?scope=project&project_id=proj_1&directory=%2Frepo")
  })

  test("saveStatuses(input) appends scope query params", async () => {
    const rows = [{ id: "draft", name: "Draft", color: "#000", position: 0, transitions: [] }]
    await pagesApi.saveStatuses(rows, { scope: "global" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/statuses?scope=global")
    expect(calls[0].init?.method).toBe("PUT")
    expect(calls[0].init?.body).toBe(JSON.stringify(rows))
  })

  test("arenaStart(id, input) calls POST /:id/arena/start", async () => {
    const input = {
      directory: "/repo",
      parent_session_id: "ses-parent",
      config: {
        max_rounds: 2,
        agents: [{ name: "builder", role: "implementer", duty: "build", model: "opencode/big-pickle" }],
      },
    }
    await pagesApi.arenaStart("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/start")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("arenaState(id) calls GET /:id/arena/state", async () => {
    await pagesApi.arenaState("p1")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/state")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("arenaMessage(id, input) calls POST /:id/arena/message", async () => {
    const input = { text: "hello", targets: ["builder"] }
    await pagesApi.arenaMessage("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/message")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("arenaControl(id, input) calls POST /:id/arena/control", async () => {
    const input = { action: "pause" as const }
    await pagesApi.arenaControl("p1", input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/p1/arena/control")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("arenaEventsUrl(id, directory?) builds expected SSE URL", () => {
    expect(pagesApi.arenaEventsUrl("p1")).toBe("http://test.local/pages/p1/arena/events")
    expect(pagesApi.arenaEventsUrl("p1", "/tmp/repo a")).toBe(
      "http://test.local/pages/p1/arena/events?directory=%2Ftmp%2Frepo%20a",
    )
  })

  test("all methods include Content-Type: application/json header", async () => {
    await pagesApi.list()
    await pagesApi.get("x")
    await pagesApi.create("t")
    await pagesApi.update("x", { title: "t" })
    await pagesApi.delete("x")
    await pagesApi.arenaStart("x", { config: { agents: [{ name: "a", role: "r", duty: "d", model: "p/m" }] } })
    await pagesApi.arenaState("x")
    await pagesApi.arenaMessage("x", { text: "hello" })
    await pagesApi.arenaControl("x", { action: "pause" })

    expect(calls).toHaveLength(9)
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string> | undefined
      expect(headers).toBeDefined()
      expect(headers!["Content-Type"]).toBe("application/json")
    }
  })

  test("create() without title sends undefined in body", async () => {
    await pagesApi.create()
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify({ title: undefined }))
  })
})

describe("error handling", () => {
  test("throws on non-ok response with error text from body", async () => {
    shouldFail = true
    failText = "Internal Server Error"
    await expect(pagesApi.list()).rejects.toThrow("Internal Server Error")
  })

  test("throws with default message when body is empty", async () => {
    shouldFail = true
    failText = ""
    await expect(pagesApi.list()).rejects.toThrow("Request failed: 500")
  })

  test("throws clear error when API responds with app HTML", async () => {
    okContentType = "text/html"
    await expect(pagesApi.list()).rejects.toThrow(
      "Pages API resolved to app HTML. Set VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001.",
    )
  })

})
