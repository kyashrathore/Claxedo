import { describe, expect, test } from "bun:test"
import { createHarnessHydrator, type HarnessHydratorCache } from "./harness-hydrator"
import type { HarnessStoreState } from "./store-state"
import type { HarnessScopeInput } from "./store-policy"
import { harnessSelectionId, type HarnessType } from "./profile"
import { requestUrl } from "@/lib/url"

type ScopeInput = HarnessScopeInput
const CLAUDE_CONNECTION = { kind: "connection", connectionId: "claude-team" } as const
const CODEX_CONNECTION = { kind: "connection", connectionId: "codex-team" } as const
const CURSOR_CONNECTION = { kind: "connection", connectionId: "cursor-team" } as const
const NATIVE_CODEX = { kind: "native", harnessId: "codex" } as const
const NATIVE_PI = { kind: "native", harnessId: "pi" } as const

const harnessId = (type: HarnessType | undefined) => type ? harnessSelectionId(type) : ""

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
    harness: CLAUDE_CONNECTION,
    selectedModel: "sonnet",
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
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
  hostKind?: "self" | "provisioner" | "machine" | null
  resolvedKind?: "self" | "provisioner" | "machine"
  sessionConfig?: unknown
  sessionConfigs?: unknown[]
  statusBody?: unknown
  statusOk?: boolean
}) {
  const calls: string[] = []
  const statusUrls: string[] = []
  const cache = createCache()
  const state = new Map<string, HarnessStoreState>([["scope", input?.state ?? harnessState()]])
  const hydrator = createHarnessHydrator<ScopeInput>({
    base: "http://127.0.0.1:3001",
    seed: (scope) => calls.push(`seed:${scope}`),
    state: (scope) => state.get(scope),
    applyStatus: async (_scope, data) => calls.push(`apply:${harnessId(data.type)}:${data.model ?? ""}`),
    setPollingHydration: (_scope, type) => calls.push(`polling:${harnessId(type)}`),
    setReadyHydration: (_scope, type) => calls.push(`ready:${harnessId(type)}`),
    fetchConfigOptions: (_scope, type) => calls.push(`options:${harnessId(type)}`),
    refresh: async (directory, harness, opts) => calls.push(`refresh:${directory ?? ""}:${harness ?? ""}:${opts?.draft ? "draft" : ""}`),
    workspaceRuntime: () => input?.workspaceRuntime ?? false,
    runtime: {
      useLocalHarnessConfig: () => input?.local ?? true,
      hostKind: () => input?.hostKind,
      workspace: async () => {
        calls.push("resolve-workspace")
        return input?.resolvedKind ? { kind: input.resolvedKind, workspaceId: "5f39af3e-75c4-4392-baaf-574acbbf9db9" } : undefined
      },
      harnessSessionFetch: () => async () => response(
        input?.sessionConfigs?.length
          ? input.sessionConfigs.shift()
          : input?.sessionConfig ?? {
            harness: { id: "codex-team", access: "connection" },
            model: { modelID: "gpt-5.5" },
          },
      ),
      localHarnessConfigFetch: () => async (url: RequestInfo | URL) => {
        statusUrls.push(requestUrl(url))
        return response(input?.statusBody ?? {
          harness: { id: "claude-team", access: "connection" },
          model: "sonnet",
          activeHarness: { id: "claude-team", access: "connection" },
        }, { status: input?.statusOk === false ? 500 : 200 })
      },
    },
    cache,
  })
  return { cache, calls, hydrator, state, statusUrls }
}

describe("harness hydrator", () => {
  test("reads existing session config before falling back to local status", async () => {
    const subject = createSubject()

    await expect(subject.hydrator.status({ directory: "/repo", sessionId: "ses_1" })).resolves.toMatchObject({
      type: CODEX_CONNECTION,
      model: "gpt-5.5",
      ready: true,
    })
  })

  test("reads native Pi config from its machine runtime", async () => {
    const subject = createSubject({
      local: false,
      workspaceRuntime: true,
      sessionConfig: { harness: { id: "pi", access: "native" }, model: { modelID: "default" } },
    })

    await expect(subject.hydrator.status({
      directory: "/repo",
      sessionId: "ses_pi",
      sessionRef: {
        host: "workspace",
        sessionId: "ses_pi",
        toolSandbox: { kind: "local", cwd: "/repo" },
        harness: NATIVE_PI,
      },
    })).resolves.toMatchObject({ type: NATIVE_PI, model: "default", ready: true })
  })

  test("hydrates draft status through the local bridge and marks the scope seen", async () => {
    const subject = createSubject()

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:claude-team:sonnet",
    ])
    expect(subject.cache.seen.get("scope")).toBe("/repo\nnew")
  })

  test("hydrates local workspace-runtime drafts through local harness status", async () => {
    const subject = createSubject({ workspaceRuntime: true, hostKind: "self" })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:claude-team:sonnet",
    ])
  })

  test("a user-hosted draft the inventory has not described yet resolves its workspace and hydrates from the machine's status", async () => {
    const subject = createSubject({
      local: false,
      workspaceRuntime: false,
      hostKind: undefined,
      resolvedKind: "machine",
      statusBody: { harness: { id: "claude", access: "native" }, activeHarness: { id: "claude", access: "native" }, activeType: "claude", status: "ready", ready: true },
    })

    await subject.hydrator.hydrate("scope", { directory: "workspace:5f39af3e-75c4-4392-baaf-574acbbf9db9", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "resolve-workspace",
      "apply:claude:",
    ])
    expect(subject.cache.getSeen("scope")).toBeDefined()
    // The status request names the workspace by id; the directory is only what the client shows.
    expect(new URL(subject.statusUrls[0]).searchParams.get("workspaceId")).toBe("5f39af3e-75c4-4392-baaf-574acbbf9db9")
  })

  test("a draft in a filesystem directory never resolves a workspace record", async () => {
    const subject = createSubject({ local: false, workspaceRuntime: false, hostKind: undefined, resolvedKind: "machine" })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).not.toContain("resolve-workspace")
  })

  test("does not hydrate remote workspace-runtime drafts through local harness status", async () => {
    const subject = createSubject({ workspaceRuntime: true, hostKind: "provisioner" })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "ready:claude-team",
      "options:claude-team",
      "refresh:/repo::draft",
    ])
  })

  test("falls back to ready hydration and options load when draft status is unavailable", async () => {
    const subject = createSubject({ local: true, statusOk: false, state: harnessState({ harness: CLAUDE_CONNECTION }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.statusUrls).toHaveLength(1)
    expect(subject.calls).toEqual([
      "seed:scope",
      "ready:claude-team",
      "options:claude-team",
      "refresh:/repo::draft",
    ])
  })

  test("hydrates canonical config for existing sessions", async () => {
    const subject = createSubject({ state: harnessState({ harness: CURSOR_CONNECTION }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:codex-team:gpt-5.5",
    ])
    expect(subject.cache.seen.get("scope")).toBe("session:ses_1")
  })

  test("keeps an existing session polling and retries when canonical config is temporarily unavailable", async () => {
    const subject = createSubject({
      state: harnessState({ harnessMode: "unknown", harness: undefined, selectedModel: "" }),
      sessionConfigs: [null, {
        harness: { id: "codex", access: "native" },
        model: { modelID: "gpt-5.5" },
      }],
      // A directory default is not authoritative for an existing session and
      // must never replace its persisted Codex ownership.
      statusBody: { harness: { id: "pi", access: "native" }, model: "" },
    })
    const params: ScopeInput = {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "workspace",
        sessionId: "ses_1",
        toolSandbox: { kind: "local", cwd: "/repo" },
        harness: NATIVE_CODEX,
      },
    }

    await subject.hydrator.hydrate("scope", params)

    expect(subject.calls).toEqual(["seed:scope", "polling:codex"])
    expect(subject.cache.seen.has("scope")).toBe(false)

    await subject.hydrator.reprobe("scope", params)

    expect(subject.calls).toEqual([
      "seed:scope",
      "polling:codex",
      "seed:scope",
      "apply:codex:gpt-5.5",
    ])
    expect(subject.cache.seen.get("scope")).toContain("session:ses_1")
  })

  test("settles a successful config missing harness identity against the authoritative session ref", async () => {
    const subject = createSubject({
      state: harnessState({ harnessMode: "unknown", harness: undefined, selectedModel: "" }),
      sessionConfig: {},
    })

    const params: ScopeInput = {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "workspace",
        sessionId: "ses_1",
        toolSandbox: { kind: "local", cwd: "/repo" },
        harness: NATIVE_CODEX,
      },
    }

    await expect(subject.hydrator.status(params)).resolves.toMatchObject({
      type: NATIVE_CODEX,
      status: "error",
      ready: false,
    })
    await subject.hydrator.hydrate("scope", params)

    expect(subject.calls).toEqual(["seed:scope", "apply:codex:"])
    expect(subject.cache.seen.get("scope")).toContain("session:ses_1")
  })

  test("rehydrates an existing session when its authoritative ref is upgraded", async () => {
    const subject = createSubject({
      sessionConfig: { harness: { id: "pi", access: "native" }, model: { modelID: "default" } },
    })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })
    await subject.hydrator.hydrate("scope", {
      directory: "/repo",
      sessionId: "ses_1",
      sessionRef: {
        host: "workspace",
        sessionId: "ses_1",
        toolSandbox: { kind: "local", cwd: "/repo" },
        harness: NATIVE_PI,
      },
    })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:pi:default",
      "seed:scope",
      "apply:pi:default",
    ])
    expect(subject.cache.seen.get("scope")).toContain("\nworkspace\n")
    expect(subject.cache.seen.get("scope")).toEndWith(`\n${JSON.stringify(NATIVE_PI)}`)
  })

  test("dedupes concurrent hydrate calls through the injected cache", async () => {
    let release: (() => void) | undefined
    const subject = createSubject()
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: (scope) => subject.calls.push(`seed:${scope}`),
      state: (scope) => subject.state.get(scope),
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
        localHarnessConfigFetch: () => async () => response({ type: CLAUDE_CONNECTION }),
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
          return response({ harness: { id: "pi", access: "native" } })
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
        saved: { version: 1, harness: CODEX_CONNECTION, model: { providerID: "acp:codex", modelID: "gpt-5.5" } },
      }),
      applyStatus: async () => subject.calls.push("status-selection"),
      setPollingHydration: () => {},
      setReadyHydration: (_scope, type) => subject.calls.push(`ready:${harnessId(type)}`),
      fetchConfigOptions: (_scope, type) => subject.calls.push(`options:${harnessId(type)}`),
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({ type: CLAUDE_CONNECTION }),
      },
      cache: subject.cache,
    })
    subject.state.set("scope", harnessState({ harness: CODEX_CONNECTION }))

    await hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual(["seed:scope", "ready:codex-team", "options:codex-team"])
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
      applyStatus: async (_scope, data) => subject.calls.push(`apply:${harnessId(data.type)}:${data.model ?? ""}`),
      setPollingHydration: () => {},
      setReadyHydration: (_scope, type) => subject.calls.push(`ready:${harnessId(type)}`),
      fetchConfigOptions: (_scope, type) => subject.calls.push(`options:${harnessId(type)}`),
      refresh: async (directory, harness, opts) => subject.calls.push(`refresh:${directory ?? ""}:${harness ?? ""}:${opts?.draft ? "draft" : ""}`),
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({
          harness: { id: "claude-team", access: "connection" },
          model: "sonnet",
          activeHarness: { id: "claude-team", access: "connection" },
        }),
      },
      cache: subject.cache,
    })

    await hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual(["seed:scope", "apply:claude-team:sonnet"])
  })

  test("marks existing sessions server-owned before asynchronous hydration", async () => {
    const subject = createSubject()
    const marks: string[] = []
    let release!: (response: Response) => void
    const config = new Promise<Response>((resolve) => { release = resolve })
    const hydrator = createHarnessHydrator<ScopeInput>({
      base: "http://127.0.0.1:3001",
      seed: () => {},
      state: (scope) => subject.state.get(scope),
      markServer: (scope) => marks.push(scope),
      applyStatus: async () => {},
      setPollingHydration: () => {},
      setReadyHydration: () => {},
      fetchConfigOptions: () => {},
      refresh: async () => {},
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => await config,
        localHarnessConfigFetch: () => async () => response({}),
      },
      cache: subject.cache,
    })

    const pending = hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })
    expect(marks).toEqual(["scope"])
    release(response({}))
    await pending
  })

})
