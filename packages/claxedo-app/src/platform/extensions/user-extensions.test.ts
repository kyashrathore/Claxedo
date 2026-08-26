import { describe, expect, test, beforeEach } from "bun:test"
import {
  loadUserExtensions,
  userExtensionsDisabled,
  USER_EXTENSIONS_KILL_SWITCH,
  type UserExtensionApi,
  type UserExtensionFetcher,
  type UserExtensionModule,
} from "./user-extensions"
import { removeUserExtensionViews, userExtensionView, userExtensionViews } from "./user-extension-views"

function listing(extensions: unknown[]): UserExtensionFetcher {
  return async () => new Response(JSON.stringify({ extensions }), { status: 200 })
}

function manifest(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    version: "1.0.0",
    apiVersion: 1,
    entryPath: `/api/claxedo/extensions/${name}/main.js`,
    ...overrides,
  }
}

beforeEach(() => {
  for (const view of userExtensionViews()) removeUserExtensionViews(view.extension.name)
})

describe("loadUserExtensions", () => {
  test("activates each extension and registers its views under a namespaced id", async () => {
    const modules: Record<string, UserExtensionModule> = {
      "http://localhost:1707/api/claxedo/extensions/hello-clock/main.js": {
        activate: (api: UserExtensionApi) => {
          api.registerView({ id: "clock", title: "Clock", mount: () => {} })
        },
      },
    }

    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      fetcher: listing([manifest("hello-clock")]),
      importModule: async (url) => modules[url] ?? Promise.reject(new Error(`unexpected import ${url}`)),
    })

    expect(result.loaded).toEqual([{ name: "hello-clock", version: "1.0.0", views: 1 }])
    expect(result.failed).toEqual([])
    expect(userExtensionView("hello-clock.clock")?.title).toBe("Clock")
    expect(userExtensionView("hello-clock.clock")?.extension).toEqual({ name: "hello-clock", version: "1.0.0" })
  })

  test("isolates a throwing activation and rolls back its partial registrations", async () => {
    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      fetcher: listing([manifest("bad"), manifest("good", { entryPath: "/api/claxedo/extensions/good/main.js" })]),
      importModule: async (url) => {
        if (url.includes("/bad/")) {
          return {
            activate: (api: UserExtensionApi) => {
              api.registerView({ id: "half", title: "Half", mount: () => {} })
              throw new Error("boom")
            },
          }
        }
        return {
          activate: (api: UserExtensionApi) => {
            api.registerView({ id: "main", title: "Good", mount: () => {} })
          },
        }
      },
    })

    expect(result.failed).toEqual([{ name: "bad", error: "boom" }])
    expect(result.loaded).toEqual([{ name: "good", version: "1.0.0", views: 1 }])
    expect(userExtensionView("bad.half")).toBeUndefined()
    expect(userExtensionView("good.main")?.title).toBe("Good")
  })

  test("revokes a timed-out activation and continues with later manifests", async () => {
    let timedOutApi: UserExtensionApi | undefined
    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      activationTimeoutMs: 5,
      fetcher: listing([manifest("stuck"), manifest("good")]),
      importModule: async (url) => {
        if (url.includes("/stuck/")) {
          return {
            activate: (api: UserExtensionApi) => {
              timedOutApi = api
              api.registerView({ id: "partial", title: "Partial", mount: () => {} })
              return new Promise<void>(() => {})
            },
          }
        }
        return {
          activate: (api: UserExtensionApi) => {
            api.registerView({ id: "main", title: "Good", mount: () => {} })
          },
        }
      },
    })

    expect(result.failed).toEqual([{ name: "stuck", error: 'Extension "stuck" activation timed out after 5ms' }])
    expect(result.loaded).toEqual([{ name: "good", version: "1.0.0", views: 1 }])
    expect(userExtensionView("stuck.partial")).toBeUndefined()
    expect(userExtensionView("good.main")?.title).toBe("Good")
    expect(() => timedOutApi?.registerView({ id: "late", title: "Late", mount: () => {} })).toThrow(
      'Extension "stuck" activation is no longer active',
    )
    expect(userExtensionView("stuck.late")).toBeUndefined()
  })

  test("fails an extension whose module exports no activate", async () => {
    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      fetcher: listing([manifest("empty")]),
      importModule: async () => ({}),
    })

    expect(result.loaded).toEqual([])
    expect(result.failed[0]?.name).toBe("empty")
  })

  test("drops listing entries that fail client-side validation instead of importing them", async () => {
    const imported: string[] = []
    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      fetcher: listing([
        manifest("UPPER"),
        manifest("wrong-path", { entryPath: "https://evil.example/x.js" }),
        manifest("wrong-api", { apiVersion: 2 }),
      ]),
      importModule: async (url) => {
        imported.push(url)
        return { activate: () => {} }
      },
    })

    expect(imported).toEqual([])
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([])
  })

  test("rejects view registrations with invalid ids or missing mount", async () => {
    const result = await loadUserExtensions({
      baseUrl: "http://localhost:1707",
      fetcher: listing([manifest("strict")]),
      importModule: async () => ({
        activate: (api: UserExtensionApi) => {
          api.registerView({ id: "../escape", title: "Nope", mount: () => {} })
        },
      }),
    })

    expect(result.failed[0]?.name).toBe("strict")
    expect(userExtensionViews()).toEqual([])
  })
})

describe("kill switch", () => {
  test("reads the localStorage flag and defaults to enabled", () => {
    localStorage.removeItem(USER_EXTENSIONS_KILL_SWITCH)
    expect(userExtensionsDisabled()).toBe(false)
    localStorage.setItem(USER_EXTENSIONS_KILL_SWITCH, "off")
    expect(userExtensionsDisabled()).toBe(true)
    localStorage.removeItem(USER_EXTENSIONS_KILL_SWITCH)
  })
})
