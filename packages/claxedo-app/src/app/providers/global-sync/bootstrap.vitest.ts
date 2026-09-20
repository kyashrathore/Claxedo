import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { bootstrapDirectory, bootstrapGlobal, type GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import type { ClaxedoAgentProfile as Agent, ClaxedoCommand as Command, ClaxedoPath as Path, ClaxedoProject as Project, ClaxedoProvider as Provider, ClaxedoProviderList as ProviderListResponse } from "@/platform/api/claxedo-api-types"
import { type NormalizedProviderListResponse, normalizeProviderList } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { setSessionStatusQueryData } from "@/features/session/data/sync/queries"
import { configureServiceContributions } from "@/app/composition/service-contributions"
import type { ContentSurfaceContribution } from "@/app/integrations/content-surface-contract"
import { SERVICE_PROTOCOL_VERSION } from "@claxedo/service-contract"

const toast = vi.hoisted(() => vi.fn())
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: toast }))

type GlobalSdk = Parameters<typeof bootstrapGlobal>[0]["globalSDK"]
type DirectorySdk = Parameters<typeof bootstrapDirectory>[0]["sdk"]

const defaultPath: Path = { state: "", config: "", worktree: "/tmp/ws", directory: "/tmp/ws", home: "" }

function project(input: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    worktree: "/tmp/ws",
    time: { created: 1, updated: 1 },
    sandboxes: [],
    ...input,
  }
}

function provider(input: Partial<Provider> & { id: string; name: string }): Provider {
  return {
    source: "api",
    env: [],
    options: {},
    models: {},
    ...input,
  }
}

function providers(input: Partial<ProviderListResponse> = {}): ProviderListResponse {
  return {
    all: [],
    connected: [],
    default: {},
    ...input,
  }
}

function directorySdk(input: Partial<DirectorySdk> = {}): DirectorySdk {
  return {
    project: {
      current: async () => ({ data: project() }),
    },
    path: {
      get: async () => ({ data: defaultPath }),
    },
    command: {
      list: async () => ({ data: [] }),
    },
    vcs: {
      get: async () => ({ data: undefined }),
    },
    ...input,
  }
}

function globalSdk(input: Partial<GlobalSdk> = {}): GlobalSdk {
  return {
    global: {
      health: async () => ({ data: { healthy: true } }),
    },
    path: {
      get: async () => ({ data: defaultPath }),
    },
    project: {
      list: async () => ({ data: [project()] }),
    },
    provider: {
      list: async () => ({ data: providers() }),
      auth: async () => ({ data: {} }),
    },
    ...input,
  }
}

// Flush the two owned post-paint/idle macrotasks and their resolved promises.
function warmup() {
  return vi.advanceTimersByTimeAsync(1)
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.useFakeTimers()
  toast.mockClear()
  globalThis.fetch = (async () => new Response("unexpected global fetch", { status: 404 })) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  queryClient.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
})

const agentNames = (baseUrl: string, directory: string, harnessType?: string, workspaceKey?: string) =>
  queryClient.getQueryData<Agent[]>(queryKeys.directory.agents(baseUrl, directory, harnessType, workspaceKey))?.map((item) => item.name)

const directoryPath = (baseUrl: string, directory: string) =>
  queryClient.getQueryData<Path>(queryKeys.directory.path(baseUrl, directory))

// Catalog cache identity includes the explicit native harness and workspace scope.
const directoryProviders = (baseUrl: string, harnessType?: string, scope?: string) =>
  queryClient.getQueryData<NormalizedProviderListResponse>(
    queryKeys.controlPlane.providers(baseUrl, scope, harnessType),
  )

const directoryProject = (baseUrl: string, directory: string) =>
  queryClient.getQueryData<string>(queryKeys.directory.project(baseUrl, directory))

function harnessProviderUrl(harness = "pi", base = "http://localhost:4096") {
  const url = new URL("/api/claxedo/agent-config/providers", base)
  url.searchParams.set("nativeHarness", harness)
  return url.toString()
}

describe("bootstrapGlobal", () => {
  test("sends browser credentials and atomically follows the authenticated service catalog", async () => {
    const registered: string[] = []
    const loaded: string[] = []
    configureServiceContributions({
      local: [],
      loaders: {
        documents: async () => {
          loaded.push("documents")
          return {
            contentSurfaces: [{
              id: "documents",
              tier: "claxedo-first-party",
              surface: "page",
              slot: "workbench",
              renderer: () => null,
            } as ContentSurfaceContribution],
          }
        },
      },
      register: (surface) => registered.push(surface.id),
      unregister: (surface) => registered.splice(registered.indexOf(surface.id), 1),
    })

    const authenticated = {
      authenticated: true,
      services: [{
        serviceId: "documents",
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        schemaVersion: 1,
        state: "enabled",
      }],
    }
    const requests: Request[] = []
    let payload: unknown = authenticated
    const fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json(payload)
    }
    const run = () => bootstrapGlobal({
      baseUrl: "https://api.example.test",
      globalSDK: globalSdk(),
      fetch: fetch as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: String,
      setGlobalState: () => undefined,
    })

    await run()
    expect(requests[0]?.url).toBe("https://api.example.test/api/claxedo/services")
    expect(requests[0]?.credentials).toBe("include")
    expect(loaded).toEqual(["documents"])
    expect(registered).toEqual(["documents"])

    payload = { ...authenticated, authenticated: false, services: [] }
    await run()
    expect(registered).toEqual([])
  })

  test("a loopback boot seeds only the path from the daemon aggregate", async () => {
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      reload: undefined,
    }
    const setGlobalState = (patch: Partial<GlobalBootstrapState>) => Object.assign(globalState, patch)
    const urls: string[] = []
    const fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      urls.push(`${req.url} ${req.headers.get("accept") ?? ""}`)
      return new Response(JSON.stringify({
        healthy: true,
        path: { state: "/state", config: "/config", worktree: "/tmp/ws", directory: "/tmp/ws", home: "/home/test" },
        project: [{ id: "proj_1", name: "Project 1", worktree: "/tmp/ws", time: { created: 1, updated: 1 } }],
        provider: {
          all: [{ id: "claude-acp", name: "Claude ACP", env: [], models: { opus: { id: "opus", name: "Opus" } } }],
          connected: ["claude-acp"],
          default: { "claude-acp": "opus" },
        },
        provider_auth: { "claude-acp": { type: "api", authenticated: true } },
        config: { theme: "system" },
      }), { status: 200 })
    }

    await bootstrapGlobal({
      baseUrl: "http://localhost:4096",
      globalSDK: globalSdk(),
      fetch: fetch as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => String(count),
      setGlobalState,
      harnessType: "claude-acp",
    })

    expect(urls).toEqual(["http://localhost:4096/api/claxedo/bootstrap?harness=claude-acp application/json"])
    expect(globalState.ready).toBe(true)
    expect(globalState.path?.directory).toBe("/tmp/ws")
    expect(queryClient.getQueryData(queryKeys.directory.path("http://localhost:4096", ""))?.home).toBe("/home/test")

    // The workspace catalog has ONE owner (features/workspaces/data/workspace-catalog.ts)
    // and boot is not it: a payload carrying projects must not seed the rail.
    expect(queryClient.getQueryData(queryKeys.controlPlane.projects("http://localhost:4096"))).toBeUndefined()
    // Provider catalogs and auth are per-workspace, per-harness reads that
    // `bootstrapDirectory` owns; global config is no longer a client key at all.
    expect(
      queryClient.getQueryData(queryKeys.controlPlane.providers("http://localhost:4096", undefined, "claude-acp")),
    ).toBeUndefined()
    expect(
      queryClient.getQueryData(queryKeys.controlPlane.providerAuth("http://localhost:4096", undefined, "claude-acp")),
    ).toBeUndefined()
    expect(queryClient.getQueryData(["global", "http://localhost:4096", "config"])).toBeUndefined()
  })

  test("a boot whose aggregate carries a malformed path seeds the empty path, not the payload", async () => {
    // `path` is the one field of the aggregate that boot writes straight into
    // global state and the directory query cache, where every consumer reads
    // `path.worktree` as a string without checking. The response is `unknown`,
    // so a payload that types `worktree` as a number has to be rejected at the
    // boundary — otherwise the number reaches those readers wearing the
    // `Path` type and nothing downstream can notice.
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      reload: undefined,
    }

    await bootstrapGlobal({
      baseUrl: "http://localhost:4096",
      globalSDK: globalSdk(),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            healthy: true,
            // `worktree` is a number and `home` is absent.
            path: { state: "/state", config: "/config", worktree: 42, directory: "/tmp/ws" },
          }),
          { status: 200 },
        )) as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => String(count),
      setGlobalState: (patch) => Object.assign(globalState, patch),
      harnessType: "claude-acp",
    })

    // Boot still completes — a bad path is not a failed boot — but the partial
    // record is dropped whole rather than merged, because a `Path` missing
    // `home` is not a `Path` and half of one is harder to diagnose than none.
    expect(globalState.ready).toBe(true)
    expect(globalState.path).toEqual({ state: "", config: "", worktree: "", directory: "", home: "" })
    expect(queryClient.getQueryData(queryKeys.directory.path("http://localhost:4096", ""))).toEqual({
      state: "",
      config: "",
      worktree: "",
      directory: "",
      home: "",
    })
  })

  test("a non-loopback boot never requests the aggregate", async () => {
    const urls: string[] = []
    const globalState: Partial<GlobalBootstrapState> = { ready: false }

    await bootstrapGlobal({
      baseUrl: "https://api.example.test",
      globalSDK: globalSdk(),
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init)
        urls.push(req.url)
        return Response.json({ authenticated: false, services: [] })
      }) as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: String,
      setGlobalState: (patch) => Object.assign(globalState, patch),
      harnessType: "pi",
    })

    expect(urls.some((url) => url.includes("/api/claxedo/bootstrap"))).toBe(false)
    expect(urls).toEqual(["https://api.example.test/api/claxedo/services"])
    expect(globalState.ready).toBe(true)
  })

  test("a loopback boot without the aggregate falls back to the daemon's own path route", async () => {
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      reload: undefined,
    }
    let authCalls = 0

    await bootstrapGlobal({
      baseUrl: "http://localhost:4096",
      globalSDK: globalSdk({
        provider: {
          list: async () => ({ data: providers({ all: [provider({ id: "anthropic", name: "Anthropic" })] }) }),
          auth: async () => {
            authCalls++
            return { data: { anthropic: [{ type: "api", authenticated: true }] } }
          },
        },
      }),
      fetch: (async () => new Response("bootstrap unavailable", { status: 503 })) as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => String(count),
      setGlobalState: (patch) => Object.assign(globalState, patch),
    })

    expect(globalState.ready).toBe(true)
    expect(globalState.path?.worktree).toBe("/tmp/ws")
    // Boot asks the daemon for nothing else: no provider auth, no catalog.
    expect(authCalls).toBe(0)
    expect(queryClient.getQueryData(queryKeys.controlPlane.projects("http://localhost:4096"))).toBeUndefined()
  })
})

describe("override bootstrapDirectory", () => {
  test("critical path is inventory hydration only", async () => {
    const returned = {
      project: 0,
      path: 0,
      workspace: 0,
    }
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const sdk = directorySdk({
      project: {
        current: async () => {
          await pending
          returned.project++
          return { data: project() }
        },
      },
      path: {
        get: async () => {
          await pending
          returned.path++
          return { data: defaultPath }
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
    })

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        if (req.url.includes("/workspace/resolve")) {
          await pending
          returned.workspace++
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      },
    })

    expect(returned).toEqual({
      project: 0,
      path: 0,
      workspace: 0,
    })

    release()
    await warmup()
    expect(directoryProject("https://app.claxedo.test", "/tmp/ws")).toBe("proj_1")
    expect(returned).toEqual({ project: 1, path: 1, workspace: 1 })
  })

  test("keeps query-backed directory state renderable while refreshing", async () => {
    const sdk = directorySdk()
    queryClient.setQueryData(queryKeys.directory.project("default", "/tmp/ws"), "existing")

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
    })

    expect(directoryProject("default", "/tmp/ws")).toBe("existing")
  })

  test("warms only canonical directory resources without an implicit provider catalog", async () => {
    const calls: string[] = []
    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk: directorySdk(),
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        calls.push(url)
        if (url === "https://app.claxedo.test/api/workspace/resolve?directory=%2Ftmp%2Fws") {
          return new Response("not found", { status: 404 })
        }
        if (url.startsWith("https://app.claxedo.test/api/claxedo/agent-config/agents?") ||
            url === "https://app.claxedo.test/api/claxedo/agent-config/commands") return Response.json([])
        throw new Error(`Unexpected bootstrap request: ${url}`)
      },
    })
    await warmup()

    expect(calls).toEqual([
      "https://app.claxedo.test/api/workspace/resolve?directory=%2Ftmp%2Fws",
      "https://app.claxedo.test/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws",
      "https://app.claxedo.test/api/claxedo/agent-config/commands",
    ])
    expect(directoryProviders("https://app.claxedo.test", undefined, "/tmp/ws")).toBeUndefined()
  })

  /**
   * Regression: opening a pi session republished pi's three-provider catalog as
   * THE global catalog, because every directory bootstrap wrote its
   * harness-qualified fetch to the unqualified cache key. The owner hit this as
   * "Connect Provider from a session offers only anthropic/openai/openai-codex".
   *
   * The two catalogs must coexist: pi's under pi's key, the global one intact.
   */
  test("a pi session's catalog does not overwrite the global one", async () => {
    const globalCatalog = normalizeProviderList(providers({
      all: [provider({ id: "anthropic", name: "Anthropic" }), provider({ id: "google", name: "Google" })],
      connected: ["anthropic"],
      default: {},
    }))
    queryClient.setQueryData(queryKeys.controlPlane.providers("http://localhost:4096"), globalCatalog)

    const previousFetch = globalThis.fetch
    try {
      await bootstrapDirectory({
        directory: "/tmp/ws",
        sdk: directorySdk(),
        loadSessions: async () => {},
        translate: (key) => key,
        baseUrl: "http://localhost:4096",
        harnessType: "pi",
        fetch: async (input, init) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          if (req.url.includes("/workspace/resolve")) {
            return new Response(JSON.stringify({ kind: "local", directory: "/tmp/ws" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (req.url === harnessProviderUrl("pi")) {
            return new Response(JSON.stringify({
              all: [
                { id: "anthropic", name: "Anthropic", env: [], models: { opus: { id: "opus", name: "Opus" } } },
                { id: "openai", name: "OpenAI", env: [], models: { gpt: { id: "gpt", name: "GPT" } } },
                { id: "openai-codex", name: "OpenAI Codex", env: [], models: { codex: { id: "codex", name: "Codex" } } },
              ],
              connected: [],
              default: {},
            }), { status: 200, headers: { "Content-Type": "application/json" } })
          }
          throw new Error(`unexpected pi bootstrap fetch: ${req.url}`)
        },
      })
      await warmup()
      } finally {
      globalThis.fetch = previousFetch
    }

    expect(Array.from(directoryProviders("http://localhost:4096", "pi", "/tmp/ws")?.all.values() ?? []).map((item) => item.id))
      .toEqual(["anthropic", "openai", "openai-codex"])
    // The global catalog — what a harness-less Connect Provider renders — is
    // exactly what it was before the pi session opened.
    expect(Array.from(directoryProviders("http://localhost:4096")?.all.values() ?? []).map((item) => item.id))
      .toEqual(["anthropic", "google"])
  })

  test("leaves session status ownership to the session controller", async () => {
    setSessionStatusQueryData({ queryClient, sessionId: "busy", status: { type: "busy" } })
    setSessionStatusQueryData({ queryClient, sessionId: "recovering", status: {
      type: "recovering",
      kind: "process_restart",
      message: "Recovering ACP client...",
    } })
    const sdk = directorySdk()

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
    })
    await warmup()

    expect(queryClient.getQueryData(shellDataKeys.sessionId("busy", "status"))).toEqual({ type: "busy" })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("recovering", "status"))).toEqual({
      type: "recovering",
      kind: "process_restart",
      message: "Recovering ACP client...",
    })
  })

  test("uses harness-scoped provider and agent endpoints for a native harness", async () => {
    const urls: string[] = []
    const localUrls: string[] = []
    const sdk = directorySdk({
    })

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      localUrls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      if (req.url.includes("/api/claxedo/agent-config/agents")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (req.url.includes("/api/claxedo/agent-config/commands")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      throw new Error(`unexpected local fetch: ${req.url}`)
    }) as typeof globalThis.fetch

    try {
      await bootstrapDirectory({
        directory: "/tmp/ws",
        sdk,
        loadSessions: async () => {},
        translate: (key) => key,
        baseUrl: "http://localhost:4096",
        harnessType: "pi",
        fetch: async (input, init) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          urls.push(req.url)
          if (req.url.includes("/workspace/resolve")) {
            return new Response(JSON.stringify({ kind: "local", directory: "/tmp/ws" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (req.url === harnessProviderUrl()) {
            return new Response(
              JSON.stringify({
                all: [{ id: "claude", name: "Claude", env: [], models: { opus: { id: "opus", name: "Opus" } } }],
                connected: ["claude"],
                default: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          throw new Error(`unexpected signed bootstrap fetch: ${req.url}`)
        },
      })
      await warmup()
      } finally {
      globalThis.fetch = previousFetch
    }

    expect(urls).toContain("http://localhost:4096/api/claxedo/workspace/resolve?directory=%2Ftmp%2Fws")
    expect(urls).toContain("http://localhost:4096/api/claxedo/agent-config/providers?nativeHarness=pi")
    expect(localUrls).toContain("GET http://localhost:4096/api/claxedo/agent-config/commands")
    expect(localUrls.some((item) => item.includes("/api/claxedo/agent-config/agents"))).toBe(true)
    expect([...urls, ...localUrls].some((item) => new URL(item.replace(/^GET /, "")).pathname === "/agent")).toBe(false)
    expect(agentNames("http://localhost:4096", "/tmp/ws", "pi")).toEqual([])
    expect(Array.from(directoryProviders("http://localhost:4096", "pi", "/tmp/ws")?.all.values() ?? []).map((item) => item.id))
      .toEqual(["claude"])
    // ...and NOT under the global key, which serves every harness-less picker.
    expect(directoryProviders("http://localhost:4096")).toBeUndefined()
  })

  test("loads native agent profiles into the harness-scoped cache", async () => {
    const sdk = directorySdk({
    })

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.includes("/api/claxedo/agent-config/agents")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (req.url.includes("/api/claxedo/agent-config/commands")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      throw new Error(`unexpected local fetch: ${req.url}`)
    }) as typeof globalThis.fetch

    try {
      await bootstrapDirectory({
        directory: "/tmp/ws",
        sdk,
        loadSessions: async () => {},
        translate: (key) => key,
        baseUrl: "http://localhost:4096",
        harnessType: "pi",
        fetch: async (input, init) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          if (req.url.includes("/workspace/resolve")) {
            return new Response(JSON.stringify({ kind: "local", directory: "/tmp/ws" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          if (req.url === harnessProviderUrl()) {
            return new Response(
              JSON.stringify({
                all: [{ id: "claude", name: "Claude", env: [], models: {} }],
                connected: ["claude"],
                default: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          throw new Error(`unexpected signed bootstrap fetch: ${req.url}`)
        },
      })

      expect(agentNames("http://localhost:4096", "/tmp/ws", "pi")).toBeUndefined()

      await warmup()
      } finally {
      globalThis.fetch = previousFetch
    }

    expect(agentNames("http://localhost:4096", "/tmp/ws", "pi")).toEqual([])
  })
  test("signed cloud bootstrap keeps native credentials central and metadata on its relay", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud project metadata")
        },
      },
      path: {
        get: async () => {
          throw new Error("expected signed cloud path metadata")
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
    })

    await bootstrapDirectory({
      directory: "workspace:ws_cloud",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      harnessType: "pi",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(JSON.stringify({
            workspaceId: "ws_cloud",
            directory: "workspace:ws_cloud",
            kind: "cloud",
            status: "ready",
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url.includes("/api/workspace/ws_cloud/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_cloud",
            relayUrl: "http://relay.test",
            role: "owner",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 30 * 60_000,
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi") {
          return new Response(JSON.stringify({
            all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
            connected: ["opencode"],
            default: { opencode: "big-pickle" },
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://relay.test/workspaces/ws_cloud/agent?harness=pi") {
          return new Response(JSON.stringify([{ name: "plan", mode: "primary" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (req.url === "http://relay.test/workspaces/ws_cloud/command") {
          return new Response(JSON.stringify([{ name: "build", template: "bun test" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls.some((url) => url.includes("/workspace/resolve"))).toBe(true)
    expect(urls).toContain("https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi")
    expect(urls).toContain("http://relay.test/workspaces/ws_cloud/agent?harness=pi")
    expect(urls).toContain("http://relay.test/workspaces/ws_cloud/command")
    expect(directoryProviders("https://app.claxedo.test", "pi", "workspace:ws_cloud")?.default.opencode).toBe("big-pickle")
    expect(
      queryClient.getQueryData<Command[]>(
        queryKeys.shell.commands("https://app.claxedo.test", "workspace:ws_cloud", undefined, "provisioner:ws_cloud"),
      )
        ?.map((item) => item.name),
    ).toEqual(["build"])
    expect(directoryPath("https://app.claxedo.test", "workspace:ws_cloud")?.directory).toBe("workspace:ws_cloud")
  })

  test("a failed central catalog is not replaced with relay or bootstrap data", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud project metadata")
        },
      },
      path: {
        get: async () => {
          throw new Error("expected signed cloud path metadata")
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
    })

    await bootstrapDirectory({
      directory: "workspace:ws_cloud",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "http://127.0.0.1:3001",
      harnessType: "pi",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(JSON.stringify({
            workspaceId: "ws_cloud",
            directory: "workspace:ws_cloud",
            kind: "cloud",
            status: "ready",
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url.includes("/api/workspace/ws_cloud/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_cloud",
            relayUrl: "http://relay.test",
            role: "owner",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 30 * 60_000,
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://127.0.0.1:3001/api/claxedo/agent-config/providers?nativeHarness=pi") {
          return Response.json({ error: "catalog unavailable" }, { status: 503 })
        }
        if (req.url === "http://127.0.0.1:3001/workspaces/ws_cloud/agent?harness=pi") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://127.0.0.1:3001/workspaces/ws_cloud/command") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls).toContain("http://127.0.0.1:3001/api/claxedo/agent-config/providers?nativeHarness=pi")
    expect(urls.some((url) => url.includes("/api/claxedo/bootstrap"))).toBe(false)
    expect(directoryProviders("http://127.0.0.1:3001", "pi", "workspace:ws_cloud")).toBeUndefined()
    expect(urls.some((url) => /\/workspaces\/[^/]+\/provider/.test(url))).toBe(false)
  })

  test("signed cloud bootstrap uses known workspace identity without resolving a directory alias", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud bootstrap to skip project.current")
        },
      },
      path: {
        get: async () => {
          throw new Error("expected signed cloud bootstrap to skip path.get")
        },
      },
      command: {
        list: async () => {
          throw new Error("expected signed cloud bootstrap to fetch commands through relay")
        },
      },
    })

    await bootstrapDirectory({
      directory: "/tmp/cloud-alias",
      workspace: {
        workspaceId: "ws_known_bootstrap",
        directory: "/tmp/cloud-alias",
        kind: "provisioner",
        status: "ready",
      },
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      harnessType: "pi",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          throw new Error(`unexpected workspace resolve: ${req.url}`)
        }
        if (req.url.includes("/api/workspace/ws_known_bootstrap/connection")) {
          return Response.json({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_known_bootstrap",
            relayUrl: "http://relay.test",
            role: "owner",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 30 * 60_000,
          })
        }
        if (req.url === "https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi") {
          return Response.json({
            all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
            connected: ["opencode"],
            default: { opencode: "big-pickle" },
          })
        }
        if (req.url === "http://relay.test/workspaces/ws_known_bootstrap/agent?harness=pi") {
          return Response.json([{ name: "plan", mode: "primary" }])
        }
        if (req.url === "http://relay.test/workspaces/ws_known_bootstrap/command") {
          return Response.json([{ name: "build", template: "bun test" }])
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls).not.toContain("https://app.claxedo.test/api/workspace/resolve?directory=%2Ftmp%2Fcloud-alias")
    expect(urls).toContain("https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi")
    expect(urls).toContain("http://relay.test/workspaces/ws_known_bootstrap/agent?harness=pi")
    expect(urls).toContain("http://relay.test/workspaces/ws_known_bootstrap/command")
    expect(directoryPath("https://app.claxedo.test", "/tmp/cloud-alias")?.directory).toBe("/tmp/cloud-alias")
  })

  test("does not invent a harness for signed provisioner-placed workspace refs", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      command: {
        list: async () => {
          throw new Error("expected relay command fetch")
        },
      },
    })

    await bootstrapDirectory({
      directory: "workspace:ws_default",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(JSON.stringify({
            workspaceId: "ws_default",
            directory: "workspace:ws_default",
            kind: "cloud",
            status: "ready",
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url.includes("/api/workspace/ws_default/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_default",
            relayUrl: "http://relay.test",
            role: "owner",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 30 * 60_000,
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://relay.test/workspaces/ws_default/agent") {
          return new Response(JSON.stringify([{ name: "build", mode: "primary" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        if (req.url === "http://relay.test/workspaces/ws_default/command") {
          return new Response(JSON.stringify([{ name: "build", template: "bun test" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls.some((url) => url.includes("provider"))).toBe(false)
    expect(directoryProviders("https://app.claxedo.test", undefined, "workspace:ws_default")).toBeUndefined()
    expect(agentNames("https://app.claxedo.test", "workspace:ws_default", undefined, "provisioner:ws_default")).toEqual(["build"])
  })

  test("raw workspace id bootstrap resolves identity before caching its native catalog", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      command: {
        list: async () => {
          throw new Error("expected relay command fetch")
        },
      },
    })

    await bootstrapDirectory({
      directory: "ws_raw",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      harnessType: "pi",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(JSON.stringify({
            workspaceId: "ws_raw",
            directory: "ws_raw",
            kind: "cloud",
            status: "ready",
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url.includes("/api/workspace/ws_raw/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_raw",
            relayUrl: "http://relay.test",
            role: "owner",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 30 * 60_000,
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi") {
          return new Response(JSON.stringify({
            all: [{ id: "opencode", name: "OpenCode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
            connected: ["opencode"],
            default: { opencode: "big-pickle" },
          }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://relay.test/workspaces/ws_raw/agent?harness=pi") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://relay.test/workspaces/ws_raw/command") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls).toContain("https://app.claxedo.test/api/workspace/resolve?workspaceId=ws_raw")
    expect(urls).toContain("https://app.claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi")
    expect(directoryProviders("https://app.claxedo.test", "pi", "workspace:ws_raw")?.default.opencode).toBe("big-pickle")
  })
})

describe("directory session-load failure reporting", () => {
  test.each([true, false])("forwards quiet=%s and only reports an interactive failure", async (quiet) => {
    const loadSessions = vi.fn(async () => { throw new Error("inventory unavailable") })
    await bootstrapDirectory({
      directory: "/tmp/failed-inventory", sdk: directorySdk(), loadSessions,
      translate: (key) => key, quiet,
      baseUrl: "https://app.claxedo.test",
      fetch: async () => Response.json([]),
    })
    expect(loadSessions).toHaveBeenCalledWith("/tmp/failed-inventory", expect.objectContaining({ quiet }))
    if (quiet) expect(toast).not.toHaveBeenCalled()
    else {
      expect(toast).toHaveBeenCalledTimes(1)
      expect(toast.mock.calls[0][0]).toEqual(expect.objectContaining({ variant: "error" }))
    }
  })
})
