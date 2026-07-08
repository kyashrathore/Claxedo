import { beforeEach, describe, expect, test } from "bun:test"
import type { HarnessType } from "../../session-client/harness/profile"
import type {
  HarnessStorePatch,
  HarnessStoreState,
} from "../../session-client/harness/store-state"
import { createHarnessStatusActions } from "./harness-status-actions"

const scope = "draft:/repo:route"

let state: HarnessStoreState
let dropped: string[]
let clearedTries: string[]
let patches: HarnessStorePatch[]
let saved: { scope: string; key: "harness" | "model" | "agent"; value: string }[]
let optionFetches: { scope: string; type: HarnessType; directory?: string; sessionId?: string }[]
let bootstraps: { harnessType?: string }[]
let ensures: { directory: string; harnessType?: string; quiet: boolean }[]
let refreshes: { directory: string; harnessType?: string }[]

beforeEach(() => {
  state = {
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
  }
  dropped = []
  clearedTries = []
  patches = []
  saved = []
  optionFetches = []
  bootstraps = []
  ensures = []
  refreshes = []
})

describe("harness status actions", () => {
  test("resets workspace drafts through store patch, prepared drop, retry cleanup, and saved preferences", () => {
    actions().resetWorkspaceDraftHarness(scope)

    expect(dropped).toEqual([scope])
    expect(clearedTries).toEqual([scope])
    expect(patches).toEqual([{
      harness: "opencode",
      harnessMode: "opencode",
      selectedModel: "",
      dynamicModels: null,
      readiness: "ready",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    }])
    expect("harnessBinary" in patches[0]).toBe(false)
    expect(saved).toEqual([
      { scope, key: "harness", value: "opencode" },
      { scope, key: "model", value: "" },
    ])
  })

  test("routes refreshes to bootstrap, draft ensure, or ordinary directory refresh", async () => {
    const subject = actions()

    await subject.refresh(undefined, "codex-acp")
    await subject.refresh(undefined, "cursor-acp", { draft: true })
    await subject.refresh("/repo", "claude-acp", { draft: true })
    await subject.refresh("/repo", "cursor-acp")

    expect(bootstraps).toEqual([{ harnessType: "codex-acp" }, { harnessType: "cursor-acp" }])
    expect(ensures).toEqual([{ directory: "/repo", harnessType: "claude-acp", quiet: true }])
    expect(refreshes).toEqual([{ directory: "/repo", harnessType: "cursor-acp" }])
  })

  test("applies status, persists harness and model, fetches options, and refreshes draft directories", async () => {
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
      type: "codex-acp",
      activeType: "codex-acp",
      model: "gpt-5.5",
    }, { directory: "/repo", sessionId: "new" })

    expect(patches[0]).toMatchObject({
      harness: "codex-acp",
      harnessMode: "harness",
      selectedModel: "gpt-5.5",
      readiness: "ready",
    })
    expect(saved).toEqual([
      { scope, key: "harness", value: "codex-acp" },
      { scope, key: "model", value: "gpt-5.5" },
    ])
    expect(optionFetches).toEqual([{ scope, type: "codex-acp", directory: "/repo", sessionId: "new" }])
    expect(ensures).toEqual([{ directory: "/repo", harnessType: "codex-acp", quiet: true }])
    expect(order).toEqual(["options", "ensure"])
    expect(refreshes).toEqual([])
  })

  test("does not fetch options or refresh directory for failed existing-session status", async () => {
    await actions().applyStatus("session:ses_1", {
      type: "claude-acp",
      activeType: "claude-acp",
      error: "binary missing",
    }, { directory: "/repo", sessionId: "ses_1" })

    expect(patches[0]).toMatchObject({
      harness: "claude-acp",
      readiness: "error",
      configError: "binary missing",
    })
    expect(optionFetches).toEqual([])
    expect(ensures).toEqual([])
    expect(refreshes).toEqual([])
  })

  test("does not clear saved model when status has no truthy model", async () => {
    await actions().applyStatus(scope, {
      type: "claude-acp",
      activeType: "claude-acp",
      model: "",
    }, { directory: "/repo", sessionId: "new" })

    expect(saved).toEqual([{ scope, key: "harness", value: "claude-acp" }])
  })

  test("applies ready hydration and fallback patches", () => {
    const subject = actions()

    subject.setReadyHydration(scope, "claude-acp")
    subject.setReadyFallback(scope, "codex-acp")

    expect(patches[0]).toMatchObject({
      harnessMode: "harness",
      readiness: "ready",
    })
    expect("dynamicModels" in patches[0]).toBe(false)
    expect("optionsSource" in patches[0]).toBe(false)
    expect("optionsLoading" in patches[0]).toBe(false)
    expect(patches[1]).toMatchObject({
      harnessMode: "harness",
      readiness: "ready",
      dynamicModels: null,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
  })

  test("stays out of direct query, store, and Solid ownership", async () => {
    const source = await Bun.file(new URL("./harness-status-actions.ts", import.meta.url)).text()

    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("setQueryData")
    expect(source).not.toContain("removeQueries")
    expect(source).not.toContain("createStore")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("solid-js")
  })
})

function actions(overrides?: {
  fetchConfigOptions?: Parameters<typeof createHarnessStatusActions<{ directory?: string; sessionId?: string }>>[0]["fetchConfigOptions"]
  ensureDirectory?: Parameters<typeof createHarnessStatusActions<{ directory?: string; sessionId?: string }>>[0]["ensureDirectory"]
}) {
  return createHarnessStatusActions<{ directory?: string; sessionId?: string }>({
    dropPrepared: (scope) => dropped.push(scope),
    clearOptionsTries: (scope) => clearedTries.push(scope),
    applyPatch: (_scope, patch) => patches.push(patch),
    state: () => state,
    save: (scope, key, value) => saved.push({ scope, key, value }),
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
