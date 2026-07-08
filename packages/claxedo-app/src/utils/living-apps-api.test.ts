import { beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let shouldFail = false

mock.module("./api", () => ({
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (shouldFail) {
      return new Response("Failed", { status: 500 })
    }
    return Response.json({})
  },
  getConfiguredClaxedoServerUrl: () => "http://test.local",
  getClaxedoServerUrl: () => "http://test.local",
  getDefaultBaseUrl: () => "http://test.local",
  normalizeUrl: (url: string | undefined) => {
    const trimmed = url?.trim()
    if (!trimmed) return undefined
    return trimmed.replace(/\/+$/, "")
  },
  // When this mock leaks into persist.test.ts via bun's
  // module cache, a static `() => false` overrides the real impl
  // and the demo-mode guard in persist.ts never fires — real
  // localStorage gets written and persist.test.ts's "demo mode keeps
  // persisted app state out of localStorage" fails. Mirror the real
  // impl from utils/api.ts so the leaked mock still detects demo
  // paths.
  isDemoMode: () => {
    if (typeof window === "undefined") return false
    const p = window.location.pathname
    return p === "/demo" || p.startsWith("/demo/")
  },
  isDemoPath: (path: string) => path === "/demo" || path.startsWith("/demo/"),
  // Include the `api: {}` shim so this mock — which leaks
  // into other test files via the bun module cache — doesn't strip
  // the `api` named export and break consumers like
  // claxedo-layout-actions/project-actions.tsx.
  api: {},
}))

const { livingAppsApi } = await import("./living-apps-api")

beforeEach(() => {
  calls.length = 0
  shouldFail = false
})

describe("livingAppsApi", () => {
  test("lists apps with workspace scope", async () => {
    await livingAppsApi.list({ workspace_id: "ws/one" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/api/claxedo/living-apps?workspace_id=ws%2Fone")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("gets an app with a path suffix", async () => {
    await livingAppsApi.get("app_1")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/api/claxedo/living-apps/app_1")
    expect(calls[0].init?.method).toBeUndefined()
  })

  test("creates an app shell", async () => {
    const input = {
      name: "Hiring intake",
      shell_spec: { type: "Stack" },
      backend_contract: { kind: "openapi" },
      action_bindings: { refresh: { operation: "listCandidates" } },
      sync_config: { provider: "turso" as const, local_path: "file:apps/hiring.db" },
    }
    await livingAppsApi.create(input)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://test.local/api/claxedo/living-apps")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(JSON.stringify(input))
  })

  test("manages data sources and events", async () => {
    await livingAppsApi.createDataSource("app_1", { kind: "browser-tab", label: "Research", config: { tab_id: "tab_1" } })
    await livingAppsApi.appendEvent("app_1", { type: "idea_marked", payload: { text: "hello" } })

    expect(calls[0].url).toBe("http://test.local/api/claxedo/living-apps/app_1/data-sources")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[1].url).toBe("http://test.local/api/claxedo/living-apps/app_1/events")
    expect(calls[1].init?.method).toBe("POST")
  })

  test("throws response text on failure", async () => {
    shouldFail = true
    await expect(livingAppsApi.list()).rejects.toThrow("Failed")
  })
})
