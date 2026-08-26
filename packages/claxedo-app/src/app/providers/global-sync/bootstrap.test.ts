import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { bootstrapDirectory, bootstrapGlobal, type GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import type {
  Agent,
  Command,
  Config,
  Path,
  Project,
  Provider,
  ProviderListResponse,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { type NormalizedProviderListResponse, normalizeProviderList } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { setSessionStatusQueryData } from "@/features/session/data/sync/queries"

type GlobalSdk = Parameters<typeof bootstrapGlobal>[0]["globalSDK"]
type DirectorySdk = Parameters<typeof bootstrapDirectory>[0]["sdk"]

const defaultPath: Path = { state: "", config: "", worktree: "/tmp/ws", directory: "/tmp/ws", home: "" }
const emptyConfig: Config = {}

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
    provider: {
      list: async () => ({ data: providers() }),
    },
    app: {
      agents: async () => ({ data: [] }),
    },
    config: {
      get: async () => ({ data: emptyConfig }),
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
      config: {
        get: async () => ({ data: emptyConfig }),
      },
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function warmup() {
  await tick()
  await tick()
  await tick()
}

function idle() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = (async () => new Response("unexpected global fetch", { status: 404 })) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  queryClient.clear()
})

const agentNames = (baseUrl: string, directory: string, harnessType?: string, workspaceKey?: string) =>
  queryClient
    .getQueryData<Agent[]>(queryKeys.directory.agents(baseUrl, directory, harnessType, workspaceKey))
    ?.map((item) => item.name)

const directoryPath = (baseUrl: string, directory: string) =>
  queryClient.getQueryData<Path>(queryKeys.directory.path(baseUrl, directory))

// The directory bootstrap always fetches with a `?harness=`, so its catalog is
// cached under that harness. `opencode` is the default and shares the
// unqualified key, which is the one `useProviders()` (no harness) reads.
const directoryProviders = (baseUrl: string, harnessType?: string, scope?: string) =>
  queryClient.getQueryData<NormalizedProviderListResponse>(
    queryKeys.controlPlane.providers(baseUrl, scope, harnessType),
  )

const directoryProject = (baseUrl: string, directory: string) =>
  queryClient.getQueryData<string>(queryKeys.directory.project(baseUrl, directory))

function harnessProviderUrl(harness = "claude-acp", base = "http://localhost:4096", directory = "/tmp/ws") {
  const url = new URL("/provider", base)
  url.searchParams.set("harness", harness)
  url.searchParams.set("directory", directory)
  return url.toString()
}

describe("bootstrapGlobal", () => {
  test("hydrates global state from healthy bootstrap payload", async () => {
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      project: [],
      provider: { all: [], connected: [], default: {} },
      provider_auth: {},
      config: {},
      reload: undefined,
    }
    const setGlobalState = (patch: Partial<GlobalBootstrapState>) => Object.assign(globalState, patch)
    const urls: string[] = []
    const fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      urls.push(`${req.url} ${req.headers.get("accept") ?? ""}`)
      return new Response(
        JSON.stringify({
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
        }),
        { status: 200 },
      )
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
    expect(globalState.project?.map((item) => item.id)).toEqual(["proj_1"])
    expect(queryClient.getQueryData(queryKeys.controlPlane.projects("http://localhost:4096"))).toEqual(
      globalState.project,
    )
    expect(globalState.config).toEqual({ theme: "system" })

    // A HARNESS-qualified bootstrap fetched a harness-qualified catalog, so it
    // lands under that harness's key and NOT the global one. It previously did
    // both, which published claude-acp's five-provider catalog as the app-wide
    // provider list: the settings provider page and every harness-less picker
    // then rendered that harness's catalog. `GlobalBootstrapState.provider`
    // is the global catalog, so a harness bootstrap must leave it untouched.
    expect(
      queryClient.getQueryData<NormalizedProviderListResponse>(
        queryKeys.controlPlane.providers("http://localhost:4096", undefined, "claude-acp"),
      )?.connected,
    ).toEqual(["claude-acp"])
    expect(queryClient.getQueryData(queryKeys.controlPlane.providers("http://localhost:4096"))).toBeUndefined()
    expect(globalState.provider?.connected).toEqual([])

    expect(
      queryClient.getQueryData(queryKeys.controlPlane.providerAuth("http://localhost:4096", "claude-acp")),
    ).toEqual({
      "claude-acp": { type: "api", authenticated: true },
    })
    expect(queryClient.getQueryData(queryKeys.controlPlane.providerAuth("http://localhost:4096"))).toBeUndefined()
    expect(globalState.provider_auth).toEqual({})
  })

  // The default harness IS the global catalog: `useProviders()` asks for it with
  // no harness, so an opencode bootstrap must land on the unqualified key or it
  // would warm a cache entry nothing reads.
  test("an opencode bootstrap still publishes the global catalog", async () => {
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      project: [],
      provider: { all: [], connected: [], default: {} },
      provider_auth: {},
      config: {},
      reload: undefined,
    }
    const setGlobalState = (patch: Partial<GlobalBootstrapState>) => Object.assign(globalState, patch)
    const fetch = async () =>
      new Response(
        JSON.stringify({
          healthy: true,
          path: { state: "", config: "", worktree: "/tmp/ws", directory: "/tmp/ws", home: "" },
          project: [],
          provider: {
            all: [{ id: "anthropic", name: "Anthropic", env: [], models: { opus: { id: "opus", name: "Opus" } } }],
            connected: ["anthropic"],
            default: { anthropic: "opus" },
          },
          provider_auth: { anthropic: { type: "api", authenticated: true } },
          config: {},
        }),
        { status: 200 },
      )

    await bootstrapGlobal({
      baseUrl: "http://localhost:4097",
      globalSDK: globalSdk(),
      fetch: fetch as typeof globalThis.fetch,
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => String(count),
      setGlobalState,
      harnessType: "opencode",
    })

    expect(globalState.provider?.connected).toEqual(["anthropic"])
    expect(
      queryClient.getQueryData<NormalizedProviderListResponse>(
        queryKeys.controlPlane.providers("http://localhost:4097"),
      )?.connected,
    ).toEqual(["anthropic"])
    expect(queryClient.getQueryData(queryKeys.controlPlane.providerAuth("http://localhost:4097"))).toEqual({
      anthropic: { type: "api", authenticated: true },
    })
  })

  test("a compact opencode bootstrap preserves provider details loaded on demand", async () => {
    const baseUrl = "http://localhost:4098"
    queryClient.setQueryData(
      queryKeys.controlPlane.providers(baseUrl),
      normalizeProviderList(
        providers({
          all: [
            provider({
              id: "anthropic",
              name: "Anthropic",
              env: ["ANTHROPIC_API_KEY"],
              models: {
                sonnet: { id: "sonnet", name: "Sonnet" },
                opus: { id: "opus", name: "Opus" },
              },
            }),
          ],
          connected: ["anthropic"],
          default: { anthropic: "sonnet" },
        }),
      ),
    )

    await bootstrapGlobal({
      baseUrl,
      globalSDK: globalSdk(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            healthy: true,
            path: { state: "", config: "", worktree: "/tmp/ws", directory: "/tmp/ws", home: "" },
            project: [],
            provider: {
              all: [
                {
                  id: "anthropic",
                  name: "Anthropic",
                  env: [],
                  models: { sonnet: { id: "sonnet", name: "Sonnet" } },
                },
              ],
              connected: ["anthropic"],
              default: { anthropic: "sonnet" },
            },
            provider_auth: {},
            config: {},
          }),
          { status: 200 },
        ),
      connectErrorTitle: "",
      connectErrorDescription: "",
      requestFailedTitle: "",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => String(count),
      setGlobalState: () => undefined,
      harnessType: "opencode",
    })

    const cached = queryClient.getQueryData<NormalizedProviderListResponse>(queryKeys.controlPlane.providers(baseUrl))
    expect(Object.keys(cached?.all.get("anthropic")?.models ?? {})).toEqual(["sonnet", "opus"])
    expect(cached?.all.get("anthropic")?.env).toEqual(["ANTHROPIC_API_KEY"])
  })

  test("hydrates provider auth through the non-persisted control-plane query bucket on fallback boot", async () => {
    const globalState: Partial<GlobalBootstrapState> = {
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      project: [],
      provider: { all: [], connected: [], default: {} },
      provider_auth: {},
      config: {},
      reload: undefined,
    }
    const setGlobalState = (patch: Partial<GlobalBootstrapState>) => Object.assign(globalState, patch)
    let authCalls = 0

    await bootstrapGlobal({
      baseUrl: "http://localhost:4096",
      globalSDK: globalSdk({
        provider: {
          list: async () => ({
            data: providers({
              all: [provider({ id: "anthropic", name: "Anthropic" })],
            }),
          }),
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
      setGlobalState,
    })

    expect(authCalls).toBe(1)
    expect(globalState.ready).toBe(true)
    expect(globalState.provider_auth?.anthropic?.[0]?.authenticated).toBe(true)
    expect(queryClient.getQueryData(queryKeys.controlPlane.providerAuth("http://localhost:4096"))).toEqual({
      anthropic: [{ type: "api", authenticated: true }],
    })
  })
})

describe("override bootstrapDirectory", () => {
  test("critical path is inventory hydration only", async () => {
    const returned = {
      project: 0,
      config: 0,
      provider: 0,
      agent: 0,
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
      provider: {
        list: async () => {
          await pending
          returned.provider++
          return { data: providers() }
        },
      },
      app: {
        agents: async () => {
          await pending
          returned.agent++
          return { data: [] }
        },
      },
      config: {
        get: async () => {
          await pending
          returned.config++
          return { data: emptyConfig }
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
      config: 0,
      provider: 0,
      agent: 0,
      path: 0,
      workspace: 0,
    })

    release()
    await warmup()
    expect(directoryProject("https://app.claxedo.test", "/tmp/ws")).toBe("proj_1")
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

  test("marks provider ready without bootstrapping removed mcp/lsp state", async () => {
    let mcp = 0
    let lsp = 0
    const sdk = directorySdk({
      provider: {
        list: async () => ({
          data: providers({
            all: [provider({ id: "anthropic", name: "Anthropic" })],
            connected: ["anthropic"],
            default: {},
          }),
        }),
      },
    })

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
    })
    await warmup()
    await idle()

    expect(mcp).toBe(0)
    expect(lsp).toBe(0)
    expect(Array.from(directoryProviders("default")?.all.values() ?? []).map((item) => item.id)).toEqual(["anthropic"])
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
    const globalCatalog = normalizeProviderList(
      providers({
        all: [provider({ id: "anthropic", name: "Anthropic" }), provider({ id: "google", name: "Google" })],
        connected: ["anthropic"],
        default: {},
      }),
    )
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
            return new Response(
              JSON.stringify({
                all: [
                  { id: "anthropic", name: "Anthropic", env: [], models: { opus: { id: "opus", name: "Opus" } } },
                  { id: "openai", name: "OpenAI", env: [], models: { gpt: { id: "gpt", name: "GPT" } } },
                  {
                    id: "openai-codex",
                    name: "OpenAI Codex",
                    env: [],
                    models: { codex: { id: "codex", name: "Codex" } },
                  },
                ],
                connected: [],
                default: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          throw new Error(`unexpected pi bootstrap fetch: ${req.url}`)
        },
      })
      await warmup()
      await idle()
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(
      Array.from(directoryProviders("http://localhost:4096", "pi", "/tmp/ws")?.all.values() ?? []).map(
        (item) => item.id,
      ),
    ).toEqual(["anthropic", "openai", "openai-codex"])
    // The global catalog — what a harness-less Connect Provider renders — is
    // exactly what it was before the pi session opened.
    expect(Array.from(directoryProviders("http://localhost:4096")?.all.values() ?? []).map((item) => item.id)).toEqual([
      "anthropic",
      "google",
    ])
  })

  test("leaves session status ownership to the session controller", async () => {
    setSessionStatusQueryData({ queryClient, sessionId: "busy", status: { type: "busy" } })
    setSessionStatusQueryData({
      queryClient,
      sessionId: "recovering",
      status: {
        type: "recovering",
        kind: "process_restart",
        message: "Recovering ACP client...",
      },
    })
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

  test("uses harness-scoped provider endpoint without loading agent profiles when harnessType is provided", async () => {
    const urls: string[] = []
    const localUrls: string[] = []
    const sdk = directorySdk({
      app: {
        agents: async () => {
          throw new Error("unexpected runner agent profile client")
        },
      },
    })

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      localUrls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      if (req.url.includes("/api/claxedo/agent-config/agents")) {
        throw new Error(`unexpected runner agent profile fetch: ${req.url}`)
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
        harnessType: "claude-acp",
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
                all: [
                  { id: "claude-acp", name: "Claude ACP", env: [], models: { opus: { id: "opus", name: "Opus" } } },
                ],
                connected: ["claude-acp"],
                default: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          throw new Error(`unexpected signed bootstrap fetch: ${req.url}`)
        },
      })
      await warmup()
      await idle()
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(urls).toContain("http://localhost:4096/api/claxedo/workspace/resolve?directory=%2Ftmp%2Fws")
    expect(urls).toContain("http://localhost:4096/provider?harness=claude-acp&directory=%2Ftmp%2Fws")
    expect(localUrls).toContain("GET http://localhost:4096/api/claxedo/agent-config/commands")
    expect(localUrls.some((item) => item.includes("/api/claxedo/agent-config/agents"))).toBe(false)
    expect([...urls, ...localUrls].some((item) => new URL(item.replace(/^GET /, "")).pathname === "/agent")).toBe(false)
    expect(agentNames("http://localhost:4096", "/tmp/ws", "claude-acp")).toEqual([])
    expect(
      Array.from(directoryProviders("http://localhost:4096", "claude-acp", "/tmp/ws")?.all.values() ?? []).map(
        (item) => item.id,
      ),
    ).toEqual(["claude-acp"])
    // ...and NOT under the global key, which serves every harness-less picker.
    expect(directoryProviders("http://localhost:4096")).toBeUndefined()
  })

  test("does not load agent profiles for runner-scoped bootstrap", async () => {
    const sdk = directorySdk({
      app: {
        agents: async () => {
          throw new Error("unexpected runner agent profile client")
        },
      },
    })

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      if (req.url.includes("/api/claxedo/agent-config/agents")) {
        throw new Error(`unexpected runner agent profile fetch: ${req.url}`)
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
        harnessType: "claude-acp",
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
                all: [{ id: "claude-acp", name: "Claude ACP", env: [], models: {} }],
                connected: ["claude-acp"],
                default: {},
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          }
          throw new Error(`unexpected signed bootstrap fetch: ${req.url}`)
        },
      })

      expect(agentNames("http://localhost:4096", "/tmp/ws", "claude-acp")).toBeUndefined()

      await warmup()
      await idle()
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(agentNames("http://localhost:4096", "/tmp/ws", "claude-acp")).toEqual([])
  })
  test("signed cloud opencode bootstrap fetches metadata through workspace relay", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud project metadata")
        },
      },
      provider: {
        list: async () => {
          throw new Error("expected relay provider fetch")
        },
      },
      app: {
        agents: async () => {
          throw new Error("expected relay agent fetch")
        },
      },
      config: {
        get: async () => {
          throw new Error("expected signed cloud config metadata")
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
      harnessType: "opencode",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(
            JSON.stringify({
              workspaceId: "ws_cloud",
              directory: "workspace:ws_cloud",
              kind: "cloud",
              status: "ready",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url.includes("/api/workspace/ws_cloud/connection")) {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_cloud",
              relayUrl: "http://relay.test",
              role: "owner",
              runtimeAccessToken: "runtime-token",
              tokenExpiresAt: Date.now() + 60_000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_cloud/provider?harness=opencode") {
          return new Response(
            JSON.stringify({
              all: [
                {
                  id: "opencode",
                  name: "OpenCode",
                  env: [],
                  models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
                },
              ],
              connected: ["opencode"],
              default: { opencode: "big-pickle" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_cloud/agent?harness=opencode") {
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
    expect(urls).toContain("http://relay.test/workspaces/ws_cloud/provider?harness=opencode")
    expect(urls).toContain("http://relay.test/workspaces/ws_cloud/agent?harness=opencode")
    expect(urls).toContain("http://relay.test/workspaces/ws_cloud/command")
    expect(directoryProviders("https://app.claxedo.test")?.default.opencode).toBe("big-pickle")
    expect(agentNames("https://app.claxedo.test", "workspace:ws_cloud", "opencode", "cloud:ws_cloud")).toEqual(["plan"])
    expect(
      queryClient
        .getQueryData<Command[]>(queryKeys.shell.commands("https://app.claxedo.test", "workspace:ws_cloud"))
        ?.map((item) => item.name),
    ).toEqual(["build"])
    expect(directoryPath("https://app.claxedo.test", "workspace:ws_cloud")?.directory).toBe("workspace:ws_cloud")
  })

  test("rejects a relay catalog that lacks OpenCode models without substituting another producer", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud project metadata")
        },
      },
      provider: {
        list: async () => {
          throw new Error("expected relay or bootstrap provider fetch")
        },
      },
      app: {
        agents: async () => {
          throw new Error("expected relay agent fetch")
        },
      },
      config: {
        get: async () => {
          throw new Error("expected signed cloud config metadata")
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
      harnessType: "opencode",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(
            JSON.stringify({
              workspaceId: "ws_cloud",
              directory: "workspace:ws_cloud",
              kind: "cloud",
              status: "ready",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url.includes("/api/workspace/ws_cloud/connection")) {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_cloud",
              relayUrl: "http://relay.test",
              role: "owner",
              runtimeAccessToken: "runtime-token",
              tokenExpiresAt: Date.now() + 60_000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://127.0.0.1:3001/workspaces/ws_cloud/provider?harness=opencode") {
          return new Response(
            JSON.stringify({
              all: [
                { id: "claude-acp", name: "Claude", env: [], models: { sonnet: { id: "sonnet", name: "Sonnet" } } },
              ],
              connected: [],
              default: { "claude-acp": "sonnet" },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          )
        }
        if (req.url === "http://127.0.0.1:3001/workspaces/ws_cloud/agent?harness=opencode") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        if (req.url === "http://127.0.0.1:3001/workspaces/ws_cloud/command") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        throw new Error(`unexpected signed cloud fetch: ${req.url}`)
      },
    })
    await warmup()

    expect(urls).toContain("http://127.0.0.1:3001/workspaces/ws_cloud/provider?harness=opencode")
    expect(urls.some((url) => url.includes("/api/claxedo/bootstrap"))).toBe(false)
    expect(directoryProviders("http://127.0.0.1:3001")).toBeUndefined()
  })

  test("signed cloud bootstrap uses known workspace identity without resolving a directory alias", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      project: {
        current: async () => {
          throw new Error("expected signed cloud bootstrap to skip project.current")
        },
      },
      config: {
        get: async () => {
          throw new Error("expected signed cloud bootstrap to skip config.get")
        },
      },
      path: {
        get: async () => {
          throw new Error("expected signed cloud bootstrap to skip path.get")
        },
      },
      provider: {
        list: async () => {
          throw new Error("expected signed cloud bootstrap to fetch provider through relay")
        },
      },
      app: {
        agents: async () => {
          throw new Error("expected signed cloud bootstrap to fetch agents through relay")
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
        kind: "cloud",
        status: "ready",
      },
      sdk,
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "https://app.claxedo.test",
      harnessType: "opencode",
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
            tokenExpiresAt: Date.now() + 60_000,
          })
        }
        if (req.url === "http://relay.test/workspaces/ws_known_bootstrap/provider?harness=opencode") {
          return Response.json({
            all: [
              {
                id: "opencode",
                name: "OpenCode",
                env: [],
                models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
              },
            ],
            connected: ["opencode"],
            default: { opencode: "big-pickle" },
          })
        }
        if (req.url === "http://relay.test/workspaces/ws_known_bootstrap/agent?harness=opencode") {
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
    expect(urls).toContain("http://relay.test/workspaces/ws_known_bootstrap/provider?harness=opencode")
    expect(urls).toContain("http://relay.test/workspaces/ws_known_bootstrap/agent?harness=opencode")
    expect(urls).toContain("http://relay.test/workspaces/ws_known_bootstrap/command")
    expect(directoryPath("https://app.claxedo.test", "/tmp/cloud-alias")?.directory).toBe("/tmp/cloud-alias")
  })

  test("defaults signed cloud workspace refs to OpenCode when runner type is omitted", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      provider: {
        list: async () => {
          throw new Error("expected relay provider fetch")
        },
      },
      app: {
        agents: async () => {
          throw new Error("expected relay agent fetch")
        },
      },
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
          return new Response(
            JSON.stringify({
              workspaceId: "ws_default",
              directory: "workspace:ws_default",
              kind: "cloud",
              status: "ready",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url.includes("/api/workspace/ws_default/connection")) {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_default",
              relayUrl: "http://relay.test",
              role: "owner",
              runtimeAccessToken: "runtime-token",
              tokenExpiresAt: Date.now() + 60_000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_default/provider?harness=opencode") {
          return new Response(
            JSON.stringify({
              all: [
                {
                  id: "opencode",
                  name: "OpenCode",
                  env: [],
                  models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
                },
              ],
              connected: ["opencode"],
              default: { opencode: "big-pickle" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_default/agent?harness=opencode") {
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

    expect(urls).toContain("http://relay.test/workspaces/ws_default/provider?harness=opencode")
    expect(directoryProviders("https://app.claxedo.test")?.default.opencode).toBe("big-pickle")
    expect(agentNames("https://app.claxedo.test", "workspace:ws_default", "opencode", "cloud:ws_default")).toEqual([
      "build",
    ])
  })

  test("raw workspace id bootstrap resolves before fetching OpenCode provider", async () => {
    const urls: string[] = []
    const sdk = directorySdk({
      provider: {
        list: async () => {
          throw new Error("expected relay provider fetch")
        },
      },
      app: {
        agents: async () => {
          throw new Error("expected relay agent fetch")
        },
      },
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
      harnessType: "opencode",
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        urls.push(req.url)
        if (req.url.includes("/workspace/resolve")) {
          return new Response(
            JSON.stringify({
              workspaceId: "ws_raw",
              directory: "ws_raw",
              kind: "cloud",
              status: "ready",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url.includes("/api/workspace/ws_raw/connection")) {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_raw",
              relayUrl: "http://relay.test",
              role: "owner",
              runtimeAccessToken: "runtime-token",
              tokenExpiresAt: Date.now() + 60_000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_raw/provider?harness=opencode") {
          return new Response(
            JSON.stringify({
              all: [
                {
                  id: "opencode",
                  name: "OpenCode",
                  env: [],
                  models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
                },
              ],
              connected: ["opencode"],
              default: { opencode: "big-pickle" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        if (req.url === "http://relay.test/workspaces/ws_raw/agent?harness=opencode") {
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
    expect(urls).toContain("http://relay.test/workspaces/ws_raw/provider?harness=opencode")
    expect(directoryProviders("https://app.claxedo.test")?.default.opencode).toBe("big-pickle")
  })
})
