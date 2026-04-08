import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { bootstrapDirectory } from "./bootstrap"
import type { State, VcsCache } from "./types"

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function state() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: false,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: false,
    mcp: {},
    lsp_ready: false,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    session_agent: {},
    session_config: {},
    session_usage: {},
  })
}

function cache(): VcsCache {
  const [store, setStore] = createStore<{ value: State["vcs"] }>({ value: undefined })
  return {
    store,
    setStore,
    ready: () => true,
  }
}

describe("override bootstrapDirectory", () => {
  test("keeps partial stores renderable while refreshing", async () => {
    const [store, setStore] = state()
    setStore("status", "partial")
    const statuses: State["status"][] = []
    const sdk = {
      project: {
        current: async () => ({ data: { id: "proj_1" } }),
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
      },
      app: {
        agents: async () => ({ data: [] }),
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      mcp: {
        status: async () => ({ data: {} }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async () => ({ data: undefined }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
    } as any

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      store,
      setStore: ((...args: Parameters<typeof setStore>) => {
        if (args[0] === "status" && typeof args[1] === "string") statuses.push(args[1] as State["status"])
        return setStore(...args)
      }) as typeof setStore,
      vcsCache: cache(),
      loadSessions: async () => {},
      translate: (key) => key,
    })
    await Promise.resolve()

    expect(statuses).not.toContain("loading")
    expect(statuses).toContain("partial")
  })

  test("marks provider, mcp, and lsp as ready after successful bootstrap", async () => {
    const [store, setStore] = state()
    const sdk = {
      project: {
        current: async () => ({ data: { id: "proj_1" } }),
      },
      provider: {
        list: async () => ({
          data: {
            all: [{ id: "anthropic", name: "Anthropic", env: [], models: {} }],
            connected: ["anthropic"],
            default: {},
          },
        }),
      },
      app: {
        agents: async () => ({ data: [] }),
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      mcp: {
        status: async () => ({ data: { foo: { command: "foo", args: [], env: {}, enabled: true, connected: false } } }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async () => ({ data: { branch: "dev" } }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
    } as any

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      store,
      setStore,
      vcsCache: cache(),
      loadSessions: async () => {},
      translate: (key) => key,
    })
    await Promise.resolve()

    expect(store.provider_ready).toBe(true)
    expect(store.mcp_ready).toBe(true)
    expect(store.lsp_ready).toBe(true)
    expect(store.provider.all.map((item) => item.id)).toEqual(["anthropic"])
  })

  test("preserves only optimistic local busy during session status bootstrap", async () => {
    const [store, setStore] = state()
    setStore("session_status", {
      busy: { type: "busy" },
      recovering: { type: "recovering", kind: "process_restart", message: "Recovering ACP client..." },
    } as State["session_status"])
    const sdk = {
      project: {
        current: async () => ({ data: { id: "proj_1" } }),
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
      },
      app: {
        agents: async () => ({ data: [] }),
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      mcp: {
        status: async () => ({ data: {} }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async () => ({ data: undefined }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
    } as any

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      store,
      setStore,
      vcsCache: cache(),
      loadSessions: async () => {},
      translate: (key) => key,
    })
    await tick()

    expect(store.session_status).toEqual({
      busy: { type: "busy" },
    })
  })

  test("uses runner-scoped provider endpoint when runnerType is provided", async () => {
    const [store, setStore] = state()
    const urls: string[] = []
    const headers: string[] = []
    const sdk = {
      project: {
        current: async () => ({ data: { id: "proj_1" } }),
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
      },
      app: {
        agents: async () => {
          throw new Error("expected runner-scoped agent client")
        },
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      mcp: {
        status: async () => ({ data: {} }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async () => ({ data: undefined }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
    } as any

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      store,
      setStore,
      vcsCache: cache(),
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "http://localhost:4096",
      runnerType: "claude-acp",
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(String(input))
        urls.push(req.url)
        headers.push(req.headers.get("x-claxedo-runner") ?? "")
        if (req.url.includes("/agent")) {
          return new Response(
            JSON.stringify([{ name: "plan", mode: "primary" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response(
          JSON.stringify({
            all: [{ id: "claude-acp", name: "Claude ACP", env: [], models: { opus: { id: "opus", name: "Opus" } } }],
            connected: ["claude-acp"],
            default: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      },
    })
    await Promise.resolve()
    await tick()

    expect(urls).toEqual([
      "http://localhost:4096/provider?runner=claude-acp",
      "http://localhost:4096/agent?directory=%2Ftmp%2Fws",
    ])
    expect(headers).toEqual(["", "claude-acp"])
    expect(store.agent).toEqual([{ name: "plan", mode: "primary" }])
    expect(store.provider_ready).toBe(true)
    expect(store.provider.all.map((item) => item.id)).toEqual(["claude-acp"])
  })

  test("does not block bootstrap on runner-scoped agent loading", async () => {
    const [store, setStore] = state()
    let release = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const sdk = {
      project: {
        current: async () => ({ data: { id: "proj_1" } }),
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
      },
      app: {
        agents: async () => {
          throw new Error("expected runner-scoped agent client")
        },
      },
      config: {
        get: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({ data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }),
      },
      command: {
        list: async () => ({ data: [] }),
      },
      session: {
        status: async () => ({ data: {} }),
      },
      mcp: {
        status: async () => ({ data: {} }),
      },
      lsp: {
        status: async () => ({ data: [] }),
      },
      vcs: {
        get: async () => ({ data: undefined }),
      },
      permission: {
        list: async () => ({ data: [] }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
    } as any

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk,
      store,
      setStore,
      vcsCache: cache(),
      loadSessions: async () => {},
      translate: (key) => key,
      baseUrl: "http://localhost:4096",
      runnerType: "claude-acp",
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(String(input))
        if (req.url.includes("/agent")) {
          await wait
          return new Response(
            JSON.stringify([{ name: "plan", mode: "primary" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response(
          JSON.stringify({
            all: [{ id: "claude-acp", name: "Claude ACP", env: [], models: {} }],
            connected: ["claude-acp"],
            default: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      },
    })

    expect(store.status).toBe("partial")
    expect(store.agent).toEqual([])

    release()
    await tick()
    await tick()

    expect(store.agent).toEqual([{ name: "plan", mode: "primary" }])
  })
})
