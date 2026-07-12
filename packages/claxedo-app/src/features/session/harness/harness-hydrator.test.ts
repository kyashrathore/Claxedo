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
    harness: "claude-acp",
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
  quiet?: boolean
  sessionConfig?: unknown
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
    setReadyHydration: (_scope, type) => calls.push(`ready:${type}`),
    setReadyFallback: (_scope, type) => calls.push(`fallback:${type}`),
    fetchConfigOptions: (_scope, type) => calls.push(`options:${type}`),
    refresh: async (directory, harness, opts) => calls.push(`refresh:${directory ?? ""}:${harness ?? ""}:${opts?.draft ? "draft" : ""}`),
    fastSessionSwitchQuiet: () => input?.quiet ?? false,
    workspaceRuntime: () => input?.workspaceRuntime ?? false,
    runtime: {
      useLocalHarnessConfig: () => input?.local ?? true,
      harnessSessionFetch: () => async () => response(input?.sessionConfig ?? {
        harness: { type: "codex-acp" },
        model: { modelID: "gpt-5.5" },
      }),
      localHarnessConfigFetch: () => async () =>
        response(input?.statusBody ?? {
          type: "claude-acp",
          model: "sonnet",
          activeType: "claude-acp",
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
      type: "codex-acp",
      model: "gpt-5.5",
      ready: true,
    })
  })

  test("hydrates draft status through the local bridge and marks the scope seen", async () => {
    const subject = createSubject()

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "apply:claude-acp:sonnet",
    ])
    expect(subject.cache.seen.get("scope")).toBe("/repo\nnew")
  })

  test("falls back to ready hydration and options load when draft status is unavailable", async () => {
    const subject = createSubject({ local: false, statusOk: false, state: harnessState({ harness: "claude-acp" }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "new" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "ready:claude-acp",
      "options:claude-acp",
      "refresh:/repo:claude-acp:draft",
    ])
  })

  test("uses ready fallback for quiet existing sessions", async () => {
    const subject = createSubject({ quiet: true, state: harnessState({ harness: "cursor-acp" }) })

    await subject.hydrator.hydrate("scope", { directory: "/repo", sessionId: "ses_1" })

    expect(subject.calls).toEqual([
      "seed:scope",
      "fallback:cursor-acp",
    ])
    expect(subject.cache.seen.get("scope")).toBe("session:ses_1")
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
      setReadyHydration: () => {},
      setReadyFallback: () => {},
      fetchConfigOptions: () => {},
      refresh: async () => {},
      fastSessionSwitchQuiet: () => false,
      workspaceRuntime: () => false,
      runtime: {
        useLocalHarnessConfig: () => true,
        harnessSessionFetch: () => async () => response({}),
        localHarnessConfigFetch: () => async () => response({ type: "claude-acp" }),
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

})
