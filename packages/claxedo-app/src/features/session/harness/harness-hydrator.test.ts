import { describe, expect, test } from "bun:test"
import { createHarnessHydrator, type HarnessHydratorCache } from "./harness-hydrator"
import type { HarnessStoreState } from "./store-state"
import type { HarnessScopeInput } from "./store-policy"

type ScopeInput = HarnessScopeInput

function response(body: unknown, init?: ResponseInit) {
  return Response.json(body, init)
}

function createCache(): HarnessHydratorCache<ScopeInput> & { seen: Map<string, string>; pending: Map<string, Promise<void>> } {
  const seen = new Map<string, string>()
  const pending = new Map<string, Promise<void>>()
  return {
    seen,
    pending,
    getSeen: (scope) => seen.get(scope),
    setSeen: (scope, key) => seen.set(scope, key),
    clearSeen: (scope) => seen.delete(scope),
    getPending: (scope) => pending.get(scope),
    setPending: (scope, value) => pending.set(scope, value),
    removePending: (scope, value) => {
      if (pending.get(scope) === value) pending.delete(scope)
    },
    fetchSessionConfig: async (_params, run) => await run(),
  }
}

function harnessState(overrides?: Partial<HarnessStoreState>): HarnessStoreState {
  return {
    harnessMode: "harness",
    harness: "acp:claude",
    harnessBinary: "",
    selectedModel: "sonnet",
    selectedAgent: "",
    dynamicModels: null,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
    ...overrides,
  }
}

function createSubject(input?: {
  state?: HarnessStoreState
  local?: boolean
  workspaceRuntime?: boolean
  workspaceKind?: "local" | "cloud" | "user-hosted" | null
  sessionConfig?: unknown
  sessionConfigs?: unknown[]
  statusBody?: unknown
  statusOk?: boolean
}) {
  const calls: string[] = []
  const cache = createCache()
  const state = new Map<string, HarnessStoreState>([["scope", input?.state ?? harnessState()]])
  const hydrator = createHarnessHydrator<ScopeInput>({
    base: "http://127.0.0.1:3001",
    seed: (scope) => calls.push(`seed:${scope}`),
    state: (scope) => state.get(scope),
    resetWorkspaceDraftHarness: (scope) => calls.push(`reset:${scope}`),
    applyStatus: async (_scope, data) => calls.push(`apply:${data.type ?? ""}:${data.model ?? ""}`),
    setPollingHydration: (_scope, type) => calls.push(`polling:${type ?? ""}`),
    setReadyHydration: (_scope, type) => calls.push(`ready:${type}`),
    fetchConfigOptions: (_scope, type) => calls.push(`options:${type}`),
    refresh: async (directory, harness, opts) => calls.push(`refresh:${directory ?? ""}:${harness ?? ""}:${opts?.draft ? "draft" : ""}`),
    workspaceRuntime: () => input?.workspaceRuntime ?? false,
    runtime: {
      useLocalHarnessConfig: () => input?.local ?? true,
      workspaceKind: () => input?.workspaceKind,
      harnessSessionFetch: () => async () => response(
        input?.sessionConfigs?.length
          ? input.sessionConfigs.shift()
          : input?.sessionConfig ?? {
            harness: { type: "acp:codex" },
            model: { modelID: "gpt-5.5" },
          },
      ),
      localHarnessConfigFetch: () => async () =>
        response(input?.statusBody ?? {
          type: "acp:claude",
          model: "sonnet",
          activeType: "acp:claude",
        }, { status: input?.statusOk === false ? 500 : 200 }),
    },
    cache,
  })
  return { cache, calls, hydrator, state }
}

describe("harness hydrator", () => {
  test("reads existing session config before falling back to local status", async () => {
    const subject = createSubject()

    await expect(subject.hydrator.status({ directory: "/repo", sessionId: "ses_1" })).resolves.toMatchObject({
      type: "acp:codex",
      model: "gpt-5.5",
      ready: true,
    })
  })

  test("reads central session config without inventing workspace runtime backing", async () => {
    const subject = createSubject({
      local: false,
      workspaceRuntime: false,
      sessionConfig: { harness: { type: "pi" }, model: { modelID: "default" } },
    })

    await expect(subject.hydrator.status({
      directory: "/repo",
      sessionId: "ses_pi",
      sessionRef: {
        host: "central",
        sessionId: "ses_pi",
        toolSandbox: { kind: "virtual" },
        harness: { id: "pi" },
      },
    })).resolves.toMatchObject({ type: "pi", model: "default", ready: true })
  })

  test("hydrates draft status through the local bridge and marks the scope seen", async () => {
    const subject = createSubject()

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:acp:claude:sonnet",
    ])
    expect(subject.cache.seen.get("scope")).toBe("/repo\nnew")
  })

  test("hydrates local workspace-runtime drafts through local harness status", async () => {
    const subject = createSubject({ workspaceRuntime: true, workspaceKind: "local" })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:acp:claude:sonnet",
    ])
  })

  test("does not hydrate remote workspace-runtime drafts through local harness status", async () => {
    const subject = createSubject({ workspaceRuntime: true, workspaceKind: "cloud" })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "ready:acp:claude",
      "options:acp:claude",
      "refresh:/repo:acp:claude:draft",
    ])
  })

  test("falls back to ready hydration and options load when draft status is unavailable", async () => {
    const subject = createSubject({ local: false, statusOk: false, state: harnessState({ harness: "acp:claude" }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "ready:acp:claude",
      "options:acp:claude",
      "refresh:/repo:acp:claude:draft",
    ])
  })

  test("hydrates canonical config for existing sessions", async () => {
    const subject = createSubject({ state: harnessState({ harness: "acp:cursor" }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:acp:codex:gpt-5.5",
    ])
    expect(subject.cache.seen.get("scope")).toBe("session:ses_1")
  })

  test("keeps an existing session polling and retries when canonical config is temporarily unavailable", async () => {
    const subject = createSubject({
      state: harnessState({ harnessMode: "opencode", harness: "opencode", selectedModel: "" }),
      sessionConfigs: [null, {
        harness: { type: "codex-app-server" },
        model: { modelID: "gpt-5.5" },
      }],
      // A directory default is not authoritative for an existing session and
      // must never replace its persisted Codex ownership.
      statusBody: { type: "opencode", model: "" },
    })
    const params: ScopeInput = {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "central",
        sessionId: "ses_1",
        toolSandbox: { kind: "virtual" },
        harness: { id: "codex-app-server" },
      },
    }

    await subject.hydrator.hydrate("scope", params)

    expect(subject.calls).toEqual(["seed:scope", "polling:codex-app-server"])
    expect(subject.cache.seen.has("scope")).toBe(false)

    await subject.hydrator.reprobe("scope", params)

    expect(subject.calls).toEqual([
      "seed:scope",
      "polling:codex-app-server",
      "seed:scope",
      "apply:codex-app-server:gpt-5.5",
    ])
    expect(subject.cache.seen.get("scope")).toContain("session:ses_1")
  })

  test("settles a successful config missing harness identity against the authoritative session ref", async () => {
    const subject = createSubject({
      state: harnessState({ harnessMode: "opencode", harness: "opencode", selectedModel: "" }),
      sessionConfig: {},
    })

    const params: ScopeInput = {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "central",
        sessionId: "ses_1",
        toolSandbox: { kind: "virtual" },
        harness: { id: "codex-app-server" },
      },
    }

    await expect(subject.hydrator.status(params)).resolves.toMatchObject({
      type: "codex-app-server",
      status: "error",
      ready: false,
    })
    await subject.hydrator.hydrate("scope", params)

    expect(subject.calls).toEqual(["seed:scope", "apply:codex-app-server:"])
    expect(subject.cache.seen.get("scope")).toContain("session:ses_1")
  })

  test("rehydrates an existing session when its authoritative ref is upgraded", async () => {
    const subject = createSubject({
      sessionConfig: { harness: { type: "pi" }, model: { modelID: "default" } },
    })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })
    await subject.hydrator.hydrate("scope", {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "central",
        sessionId: "ses_1",
        toolSandbox: { kind: "virtual" },
        harness: { id: "pi" },
      },
    })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:pi:default",
      "seed:scope",
      "apply:pi:default",
    ])
    expect(subject.cache.seen.get("scope")).toContain("\ncentral\n")
    expect(subject.cache.seen.get("scope")).toEndWith("\npi\n")
  })

  test("dedupes concurrent hydrate calls through the injected cache", async () => {
    let release: (() => void) | undefined
    const subject = createSubject()
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: (scope) => subject.calls.push(`seed:${scope}`),
      state: (scope) => subject.state.get(scope),
      resetWorkspaceDraftHarness: (scope) => subject.calls.push(`reset:${scope}`),
      applyStatus: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        subject.calls.push("apply")
      },
      setPollingHydration: () => {},
      setReadyHydration: () => {},
      fetchConfigOptions: () => {},
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({ type: "acp:claude" }),
      },
      cache: subject.cache,
    })

    const first = hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })
    const second = hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })
    expect(subject.cache.pending.has("scope")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release!()
    await Promise.all([first, second])
    expect(subject.calls).toEqual([
      "seed:scope",
      "seed:scope",
      "apply",
    ])
  })

  test("starts a new hydration generation when the workspace changes under one draft scope", async () => {
    const subject = createSubject()
    let releaseFirst: (() => void) | undefined
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: () => {},
      state: (scope) => subject.state.get(scope),
      beginDraftDefault: (_scope, params) => {
        subject.state.set("scope", harnessState({ harness: params?.directory === "/one" ? "acp:claude" : "acp:codex" }))
        return {
          application: { scope: "scope", workspaceKey: params?.directory ?? "", revision: 1 },
          saved: { version: 1, harness: params?.directory === "/one" ? "acp:claude" : "acp:codex" },
        }
      },
      resetWorkspaceDraftHarness: () => {},
      applyStatus: async () => {},
      setPollingHydration: () => {},
      setReadyHydration: () => {},
      fetchConfigOptions: () => {},
      refresh: async (directory) => {
        if (directory !== "/one") return
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      },
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({}),
      },
      cache: subject.cache,
    })

    const first = hydrator.hydrate("scope", { directory: "/one", sessionId: "new" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await hydrator.hydrate("scope", { directory: "/two", sessionId: "new" })
    expect(subject.cache.seen.get("scope")).toBe("/two\nnew")

    releaseFirst?.()
    await first
    expect(subject.cache.seen.get("scope")).toBe("/two\nnew")
  })

  test("does not apply an older draft hydration after an explicit selection cancels it", async () => {
    const subject = createSubject()
    let release: (() => void) | undefined
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: () => {},
      state: (scope) => subject.state.get(scope),
      resetWorkspaceDraftHarness: () => {},
      applyStatus: async () => subject.calls.push("stale-status-applied"),
      setPollingHydration: () => {},
      setReadyHydration: () => {},
      fetchConfigOptions: () => {},
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return response({ type: "opencode" })
        },
      },
      cache: subject.cache,
    })

    const pending = hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    hydrator.cancel("scope")
    release!()
    await pending

    expect(subject.calls).toEqual([])
    expect(subject.cache.seen.has("scope")).toBe(false)
  })

  test("hydrates a saved draft through workspace-default ownership without applying status selection", async () => {
    const subject = createSubject()
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: (scope) => subject.calls.push(`seed:${scope}`),
      state: (scope) => subject.state.get(scope),
      beginDraftDefault: () => ({
        application: { scope: "scope", workspaceKey: "ws_1", revision: 1 },
        saved: { version: 1, harness: "acp:codex", model: { providerID: "acp:codex", modelID: "gpt-5.5" } },
      }),
      resetWorkspaceDraftHarness: () => {},
      applyStatus: async () => subject.calls.push("status-selection"),
      setPollingHydration: () => {},
      setReadyHydration: (_scope, type) => subject.calls.push(`ready:${type}`),
      fetchConfigOptions: (_scope, type) => subject.calls.push(`options:${type}`),
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({ type: "acp:claude" }),
      },
      cache: subject.cache,
    })
    subject.state.set("scope", harnessState({ harness: "acp:codex" }))

    await hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual(["seed:scope", "ready:acp:codex", "options:acp:codex"])
  })

  test("hydrates status when workspace-default ownership has no saved draft", async () => {
    const subject = createSubject()
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: (scope) => subject.calls.push(`seed:${scope}`),
      state: (scope) => subject.state.get(scope),
      beginDraftDefault: () => ({
        application: { scope: "scope", workspaceKey: "ws_1", revision: 1 },
        saved: undefined,
      }),
      resetWorkspaceDraftHarness: () => {},
      applyStatus: async (_scope, data) => subject.calls.push(`apply:${data.type ?? ""}:${data.model ?? ""}`),
      setPollingHydration: () => {},
      setReadyHydration: (_scope, type) => subject.calls.push(`ready:${type}`),
      fetchConfigOptions: (_scope, type) => subject.calls.push(`options:${type}`),
      refresh: async (directory, harness, opts) => subject.calls.push(`refresh:${directory ?? ""}:${harness ?? ""}:${opts?.draft ? "draft" : ""}`),
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({
          type: "acp:claude",
          model: "sonnet",
          activeType: "acp:claude",
        }),
      },
      cache: subject.cache,
    })

    await hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual(["seed:scope", "apply:acp:claude:sonnet"])
  })

  test("marks existing sessions server-owned before asynchronous hydration", async () => {
    const subject = createSubject()
    const marks: string[] = []
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: () => {},
      state: (scope) => subject.state.get(scope),
      markServer: (scope) => marks.push(scope),
      resetWorkspaceDraftHarness: () => {},
      applyStatus: async () => {},
      setPollingHydration: () => {},
      setReadyHydration: () => {},
      fetchConfigOptions: () => {},
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({}),
      },
      cache: subject.cache,
    })

    await hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })
    expect(marks).toEqual(["scope"])
  })

})
