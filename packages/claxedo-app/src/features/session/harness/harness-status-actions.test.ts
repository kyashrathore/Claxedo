import { beforeEach, describe, expect, test } from "bun:test"
import type { HarnessType } from "./profile"
import type {
  HarnessStorePatch,
  HarnessStoreState,
} from "./store-state"
import { createHarnessStatusActions } from "./harness-status-actions"

const scope = "draft:/repo:route"

let state: HarnessStoreState
let patches: HarnessStorePatch[]
let optionFetches: { scope: string; type: HarnessType; directory?: string; sessionId?: string }[]
let bootstraps: { harnessType?: string }[]
let ensures: { directory: string; harnessType?: string; quiet: boolean }[]
let refreshes: { directory: string; harnessType?: string }[]

beforeEach(() => {
  state = {
    harnessMode: "harness",
    harness: "acp:claude",
    harnessBinary: "",
    selectedModel: "sonnet",
    dynamicModels: null,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
  }
  patches = []
  optionFetches = []
  bootstraps = []
  ensures = []
  refreshes = []
})

describe("harness status actions", () => {
  test("routes refreshes to bootstrap, draft ensure, or ordinary directory refresh", async () => {
    const subject = actions()

    await subject.refresh(undefined, "acp:codex")
    await subject.refresh(undefined, "acp:cursor", { draft: true })
    await subject.refresh("/repo", "acp:claude", { draft: true })
    await subject.refresh("/repo", "acp:cursor")

    expect(bootstraps).toEqual([{ harnessType: "acp:codex" }, { harnessType: "acp:cursor" }])
    expect(ensures).toEqual([{ directory: "/repo", harnessType: "acp:claude", quiet: true }])
    expect(refreshes).toEqual([{ directory: "/repo", harnessType: "acp:cursor" }])
  })

  test("applies status, fetches options, and refreshes draft directories", async () => {
    const order: string[] = []
    const subject = actions({
      fetchConfigOptions: (scope, type, params) => {
        order.push("options")
        optionFetches.push({ scope, type, directory: params?.directory, sessionId: params?.sessionId })
      },
      ensureDirectory: async (params) => {
        order.push("ensure")
        ensures.push(params)
      },
    })

    await subject.applyStatus(scope, {
      type: "acp:codex",
      activeType: "acp:codex",
      model: "gpt-5.5",
    }, { directory: "/repo", sessionId: "new" })

    expect(patches[0]).toMatchObject({
      harness: "acp:codex",
      harnessMode: "harness",
      selectedModel: "gpt-5.5",
      readiness: "ready",
    })
    expect(optionFetches).toEqual([{ scope, type: "acp:codex", directory: "/repo", sessionId: "new" }])
    expect(ensures).toEqual([{ directory: "/repo", harnessType: "acp:codex", quiet: true }])
    expect(order).toEqual(["options", "ensure"])
    expect(refreshes).toEqual([])
  })

  test("does not fetch options or refresh directory for failed existing-session status", async () => {
    await actions().applyStatus("session:ses_1", {
      type: "acp:claude",
      activeType: "acp:claude",
      error: "binary missing",
    }, { directory: "/repo", sessionId: "ses_1" })

    expect(patches[0]).toMatchObject({
      harness: "acp:claude",
      readiness: "error",
      configError: "binary missing",
    })
    expect(optionFetches).toEqual([])
    expect(ensures).toEqual([])
    expect(refreshes).toEqual([])
  })

  test("fetches model options without refreshing the directory for a healthy existing session", async () => {
    await actions().applyStatus("session:ses_1", {
      type: "codex-app-server",
      activeType: "codex-app-server",
      model: "gpt-5.6-sol",
    }, { directory: "/repo", sessionId: "ses_1" })

    expect(optionFetches).toEqual([{
      scope: "session:ses_1",
      type: "codex-app-server",
      directory: "/repo",
      sessionId: "ses_1",
    }])
    expect(ensures).toEqual([])
    expect(refreshes).toEqual([])
  })

  test("ignores failed status for a different harness in the same scope", async () => {
    state.harness = "acp:cursor"

    await actions().applyStatus(scope, {
      type: "cursor-sdk",
      activeType: "cursor-sdk",
      error: "Cursor SDK requires an explicit cursor-sdk API key",
    }, { directory: "/repo", sessionId: "new" })

    expect(patches).toEqual([])
    expect(optionFetches).toEqual([])
  })

  test("applies a failed harness status over the seeded opencode placeholder so the error surfaces", async () => {
    // The store seeds `harness: "opencode"` before any user confirmation. A
    // failed status for the harness this scope is actually configured with
    // (e.g. acp:claude with a missing binary) must be applied — treating the
    // seed as a confirmed different selection would silently swallow the error,
    // leaving submit unblocked with no red dot (core-harness-ownership-local).
    state.harness = "opencode"

    await actions().applyStatus(scope, {
      type: "acp:claude",
      activeType: "acp:claude",
      error: "claude binary not found",
    }, { directory: "/repo", sessionId: "new" })

    expect(patches[0]).toMatchObject({
      harness: "acp:claude",
      readiness: "error",
      configError: "claude binary not found",
    })
  })

  // Third stranding path behind the Tier R "Loading models" hang. When a
  // status says the harness hard-failed, `shouldFetchConfigOptionsForScope`
  // correctly declines to fetch options — but `harnessStatusPatch` does not
  // touch `optionsLoading`, so a flag raised earlier (by a switch, or by the
  // store's own seed for a scope with a saved harness) is never lowered and the
  // model control renders "Loading models" behind the error state forever. A
  // status that will not fetch options must settle the flag itself.
  test("settles the loading flag when a failed status skips the options fetch", async () => {
    const subject = actions()

    await subject.applyStatus(scope, {
      type: "acp:claude",
      status: "error",
      ready: false,
      error: "claude binary not found",
    }, { directory: "/repo", sessionId: "new" })

    expect(optionFetches).toEqual([])
    expect(patches.at(-1)).toMatchObject({ optionsLoading: false })
  })

  test("applies ready and polling hydration patches", () => {
    const subject = actions()

    subject.setReadyHydration(scope, "acp:claude")
    subject.setPollingHydration(scope, "codex-app-server")

    expect(patches[0]).toMatchObject({
      harnessMode: "harness",
      readiness: "ready",
    })
    expect("dynamicModels" in patches[0]).toBe(false)
    expect("optionsSource" in patches[0]).toBe(false)
    expect("optionsLoading" in patches[0]).toBe(false)
    expect(patches[1]).toMatchObject({
      harnessMode: "harness",
      harness: "codex-app-server",
      readiness: "polling",
      dynamicModels: null,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
  })

})

function actions(overrides?: {
  fetchConfigOptions?: Parameters<typeof createHarnessStatusActions<{ directory?: string; sessionId?: string }>>[0]["fetchConfigOptions"]
  ensureDirectory?: Parameters<typeof createHarnessStatusActions<{ directory?: string; sessionId?: string }>>[0]["ensureDirectory"]
}) {
  return createHarnessStatusActions<{ directory?: string; sessionId?: string }>({
    applyPatch: (_scope, patch) => patches.push(patch),
    state: () => state,
    fetchConfigOptions: overrides?.fetchConfigOptions ?? ((scope, type, params) => {
      optionFetches.push({ scope, type, directory: params?.directory, sessionId: params?.sessionId })
    }),
    bootstrap: async (params) => {
      bootstraps.push(params)
    },
    ensureDirectory: overrides?.ensureDirectory ?? (async (params) => {
      ensures.push(params)
    }),
    refreshDirectory: async (params) => {
      refreshes.push(params)
    },
  })
}
