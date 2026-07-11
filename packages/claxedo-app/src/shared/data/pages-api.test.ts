import { beforeEach, describe, expect, test, mock } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let shouldFail = false
let failStatus = 500
let failText = "Request failed"
let okContentType = "application/json"
let okText = "{}"

mock.module("@/shared/data/api", () => ({
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
  failStatus = 500
  failText = "Request failed"
  okContentType = "application/json"
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

  test("eventsUrl(input) builds the page list stream URL", () => {
    expect(pagesApi.eventsUrl({ scope: "project", project_id: "proj_1", directory: "/repo" })).toBe(
      "http://test.local/pages/events?scope=project&project_id=proj_1&directory=%2Frepo",
    )
  })

  test("create(input) calls POST with body", async () => {
    await pagesApi.create({ title: "My Page" })
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

  test("createFromRepo(input) posts to the repo import route", async () => {
    const input = { title: "Doc", project_id: "proj_1", workspace_id: "ws_1", directory: "/repo", path: "docs/doc.md" }
    await pagesApi.createFromRepo(input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/from-repo")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("update(id, patch) calls PATCH with patch body", async () => {
    const patch = { title: "Updated", content: "New content" }
    await pagesApi.update("pg-1", patch)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/pg-1")
    expect(calls[0].init?.method).toBe("PATCH")
    expect(calls[0].init?.body).toBe(JSON.stringify(patch))
  })

  test("update(id, patch, version) sends If-Match and scope query", async () => {
    await pagesApi.update("pg-1", { title: "Updated" }, { scope: "project", project_id: "proj_1", version: 7 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/pg-1?scope=project&project_id=proj_1")
    expect(new Headers(calls[0].init?.headers).get("If-Match")).toBe("7")
  })

  test("update returns typed conflict on stale version", async () => {
    shouldFail = true
    failStatus = 409
    failText = JSON.stringify({ error: "page_version_conflict", currentVersion: 9 })
    const oldFetch = calls.length
    const result = await pagesApi.update("pg-1", { title: "Updated" }, { version: 7 })
    expect(calls.length).toBe(oldFetch + 1)
    expect(result).toEqual({ conflict: true, currentVersion: 9 })
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

  test("updateSessionId(pageId, sessionId, input) calls PATCH through encoded page route", async () => {
    await pagesApi.updateSessionId("page/1", "ses_1", { directory: "/repo" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/page%2F1/session?directory=%2Frepo")
    expect(calls[0].init?.method).toBe("PATCH")
    expect(calls[0].init?.body).toBe(JSON.stringify({ session_id: "ses_1" }))
  })

  test("transitionStatus(pageId, status, input) calls POST through encoded page route", async () => {
    await pagesApi.transitionStatus("page/1", "done", { scope: "project", project_id: "proj_1" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/page%2F1/status?scope=project&project_id=proj_1")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify({ status: "done" }))
    expect(new Headers(calls[0].init?.headers).has("If-Match")).toBe(false)
  })

  test("exportMarkdown(id, input) requests raw markdown export", async () => {
    okContentType = "text/markdown"
    okText = "# Page"
    const result = await pagesApi.exportMarkdown("page/1", { scope: "project", project_id: "proj_1" })
    expect(result).toBe("# Page")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/page%2F1/export?scope=project&project_id=proj_1")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("commitToGit(id, input) posts to the git commit route", async () => {
    await pagesApi.commitToGit("page/1", { message: "docs: update" }, { project_id: "proj_1" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/pages/page%2F1/git/commit?project_id=proj_1")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify({ message: "docs: update" }))
  })

  test("all methods include Content-Type: application/json header", async () => {
    await pagesApi.list()
    await pagesApi.get("x")
    await pagesApi.create({ title: "t" })
    await pagesApi.update("x", { title: "t" })
    await pagesApi.delete("x")
    await pagesApi.commitToGit("x")

    expect(calls).toHaveLength(6)
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers).toBeDefined()
      expect(headers.get("Content-Type")).toBe("application/json")
    }
  })

  test("create() without title sends undefined in body", async () => {
    await pagesApi.create()
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify({}))
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
