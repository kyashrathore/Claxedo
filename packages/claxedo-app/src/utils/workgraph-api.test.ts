import { beforeEach, describe, expect, test, mock } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let fail = false
let txt = "Request failed"
let type = "application/json"
let json: unknown = {}
let htmlRetry = false

mock.module("./api", () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (htmlRetry) {
      const html = url.startsWith("http://localhost:3000")
      return {
        ok: true,
        status: 200,
        text: async () => (html ? "<html></html>" : txt),
        json: async () => json,
        headers: { get: () => (html ? "text/html" : "application/json") },
      } as Response
    }
    if (fail) {
      return {
        ok: false,
        status: 500,
        text: async () => txt,
        json: async () => ({}),
        headers: { get: () => "application/json" },
      } as Response
    }
    return {
      ok: true,
      status: 200,
      text: async () => txt,
      json: async () => json,
      headers: { get: () => type },
    } as Response
  },
  getDefaultBaseUrl: () => "http://localhost:3000",
  getClaxedoServerUrl: () => "http://localhost:3000",
  isDemoMode: () => {
    if (typeof window === "undefined") return false
    const p = window.location.pathname
    return p === "/demo" || p.startsWith("/demo/")
  },
  isDemoPath: (p: string) => p === "/demo" || p.startsWith("/demo/"),
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

const { workgraphApi } = await import("./workgraph-api")

beforeEach(() => {
  calls.length = 0
  fail = false
  txt = "Request failed"
  type = "application/json"
  json = {}
  htmlRetry = false
})

describe("workgraphApi", () => {
  test("connections() calls GET /graph/providers/connections", async () => {
    await workgraphApi.connections()
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/providers/connections")
  })

  test("connect() calls POST /graph/providers/connections", async () => {
    await workgraphApi.connect({ provider: "github", token: "secret" })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/providers/connections")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("queryProvider() calls POST /graph/providers/query", async () => {
    await workgraphApi.queryProvider({ connection_id: "conn_1", mode: "assigned_to_me", query: { owner: "acme", repo: "app" } })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/providers/query")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("importProvider() calls POST /graph/providers/import", async () => {
    await workgraphApi.importProvider({ connection_id: "conn_1", mode: "project_or_team" })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/providers/import")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("items() calls GET /graph/items", async () => {
    await workgraphApi.items()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/items")
  })

  test("items() serializes filters", async () => {
    await workgraphApi.items({ status: "ready", slice_id: "src_1", run_id: "run_1", repo_ref: "github:acme/app", attention: true, search: "alpha" })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/items?status=ready&slice_id=src_1&run_id=run_1&repo_ref=github%3Aacme%2Fapp&attention=true&search=alpha")
  })

  test("item() calls GET /graph/items/:id", async () => {
    await workgraphApi.item("item_1")
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/items/item_1")
  })

  test("slices() calls GET /graph/slices", async () => {
    await workgraphApi.slices()
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/slices")
  })

  test("repos() calls GET /graph/repos", async () => {
    await workgraphApi.repos()
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/repos")
  })

  test("sliceEvents() calls GET /graph/slices/:id/events", async () => {
    await workgraphApi.sliceEvents("src_1")
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/slices/src_1/events")
  })

  test("ingest() calls POST /graph/slices", async () => {
    await workgraphApi.ingest({ title: "Audit", content: "# Brief" })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/slices")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("plan() calls POST /graph/slices/:id/plan", async () => {
    await workgraphApi.plan("src_1", "/repo/main")
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/slices/src_1/plan")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("run() calls POST /graph/runs", async () => {
    await workgraphApi.run({ root_item_id: "item_1" })
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/runs")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("throws clear error when API returns app html", async () => {
    type = "text/html"
    await expect(workgraphApi.items()).rejects.toThrow(
      "WorkGraph API resolved to app HTML. Set VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001.",
    )
  })

  test("retries local html responses against 127.0.0.1:4096", async () => {
    htmlRetry = true
    await workgraphApi.items()
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("http://localhost:3000/api/workgraph/graph/items")
    expect(calls[1].url).toBe("http://127.0.0.1:4096/api/workgraph/graph/items")
  })
})
