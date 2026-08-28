import { beforeEach, describe, expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { createHarnessStore } from "./harness-store"
import { createDraftDefaultPreferences } from "./draft-defaults"

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
})

describe("harness store facade", () => {
  test("reads session state from scoped preferences and legacy fallback without seeding", () => {
    storage.setItem("claxedo:runner", "claude-acp")
    storage.setItem("claxedo:acp-model", "legacy-model")
    storage.setItem("claxedo:harness-map", JSON.stringify({ "session:ses_1": "codex-acp" }))
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "session:ses_1": "gpt-5.5" }))

    const store = createHarnessStore(storage)

    expect(store.state("session:ses_1")).toBeUndefined()
    expect(store.read("session:ses_1")).toMatchObject({
      harness: "codex-acp",
      selectedModel: "gpt-5.5",
    })
    expect(store.read("session:ses_2")).toMatchObject({
      harness: "claude-acp",
      selectedModel: "legacy-model",
    })
    expect(store.state("session:ses_1")).toBeUndefined()
    expect(store.state("session:ses_2")).toBeUndefined()
  })

  test("reuses one immutable initial projection for repeated unseeded reads", () => {
    storage.setItem("claxedo:runner", "claude-acp")
    const store = createHarnessStore(storage)
    const first = store.read("session:ses_1")
    const readsAfterFirst = storage.getCount

    for (let index = 0; index < 1_000; index++) {
      expect(store.read("session:ses_1")).toBe(first)
    }

    expect(storage.getCount).toBe(readsAfterFirst)
    expect(store.state("session:ses_1")).toBeUndefined()
  })

  test("touch seeds live state and seed does not overwrite patches", () => {
    storage.setItem("claxedo:harness-map", JSON.stringify({ "draft:one": "codex-acp" }))

    const store = createHarnessStore(storage)
    const state = store.touch("draft:one")

    expect(state.harness).toBe("codex-acp")
    expect(store.state("draft:one")).toBe(state)

    store.applyPatch("draft:one", {
      harness: "claude-acp",
      selectedModel: "opus",
    })
    store.seed("draft:one")

    expect(store.read("draft:one")).toMatchObject({
      harness: "claude-acp",
      selectedModel: "opus",
    })
  })

  test("seed preserves live state even when preferences change", () => {
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "draft:one": "sonnet" }))

    const store = createHarnessStore(storage)
    store.seed("draft:one")
    store.applyPatch("draft:one", { selectedModel: "opus" })
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "draft:one": "haiku" }))
    store.seed("draft:one")

    expect(store.read("draft:one").selectedModel).toBe("opus")
  })

  test("applies patches and derives submit selectors from the current state", () => {
    const store = createHarnessStore(storage)

    store.seed("draft:/repo:route")
    store.applyPatch("draft:/repo:route", {
      harness: "claude-acp",
      harnessMode: "harness",
      selectedModel: "opus",
      dynamicModels: [{ id: "opus", name: "Opus" }],
      optionsLoading: false,
      readiness: "ready",
    })

    expect(store.harness("draft:/repo:route")).toBe("claude-acp")
    expect(store.selectedModel("draft:/repo:route")).toBe("opus")
    expect(store.models("draft:/repo:route")).toEqual([{ id: "opus", name: "Opus" }])
    expect(store.harnessModelKeyForSubmit("draft:/repo:route")).toEqual({
      providerID: "claude-acp",
      modelID: "opus",
    })
    expect(store.harnessModelNameForSubmit("draft:/repo:route")).toBe("Opus")
    expect(store.harnessReadyForSubmit("draft:/repo:route")).toBe(true)
  })

  test("applies falsy patch values without truthy filtering", () => {
    const store = createHarnessStore(storage)

    store.applyPatch("draft:/repo:route", {
      harness: "claude-acp",
      harnessMode: "harness",
      selectedModel: "opus",
      dynamicModels: [{ id: "opus", name: "Opus" }],
      optionsLoading: true,
      optionsStale: true,
      configError: "missing binary",
    })
    store.applyPatch("draft:/repo:route", {
      selectedModel: "",
      dynamicModels: null,
      optionsLoading: false,
      optionsStale: false,
      configError: undefined,
    })

    expect(store.read("draft:/repo:route")).toMatchObject({
      harness: "claude-acp",
      selectedModel: "",
      dynamicModels: null,
      optionsLoading: false,
      optionsStale: false,
    })
    expect(store.read("draft:/repo:route").configError).toBeUndefined()
    expect(store.selectedModel("draft:/repo:route")).toBe("")
  })

  test("applyPatch seeds missing scopes before applying falsy values", () => {
    const store = createHarnessStore(storage)

    store.applyPatch("draft:/repo:route", {
      harness: "codex-acp",
      harnessMode: "harness",
      selectedModel: "",
      optionsLoading: false,
      optionsStale: false,
      configError: "",
    })

    expect(store.state("draft:/repo:route")).toMatchObject({
      harness: "codex-acp",
      selectedModel: "",
      optionsLoading: false,
      optionsStale: false,
      configError: "",
    })
    expect(store.selectedModel("draft:/repo:route")).toBe("")
  })

  test("promotes full transient state without writing harness preference maps", () => {
    const store = createHarnessStore(storage)

    store.seed("draft:one")
    store.applyPatch("draft:one", {
      harness: "codex-acp",
      harnessMode: "harness",
      harnessBinary: "/bin/codex-acp",
      selectedModel: "gpt-5.5",
      selectedAgent: "build",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      readiness: "error",
      optionsSource: "harness",
      optionsStale: true,
      optionsLoading: true,
      configError: "missing binary",
      workspaceId: "ws_1",
    })
    store.save("draft:one", "harness", "codex-acp")
    store.save("draft:one", "model", "gpt-5.5")
    store.save("draft:one", "agent", "build")
    storage.setItem("claxedo:model-variant-map", JSON.stringify({ "draft:one": "fast" }))

    store.promote("draft:one", "session:ses_1")

    // read() returns the live reactive store proxy (production needs that for
    // reactivity); unwrap to a plain snapshot so bun:test's toMatchObject can
    // recurse the nested dynamicModels array (a nested solid proxy otherwise
    // trips the matcher — the promoted content itself is correct).
    expect(unwrap(store.read("session:ses_1"))).toMatchObject({
      harness: "codex-acp",
      harnessBinary: "/bin/codex-acp",
      selectedModel: "gpt-5.5",
      selectedAgent: "build",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      readiness: "error",
      optionsSource: "harness",
      optionsStale: true,
      optionsLoading: true,
      configError: "missing binary",
      workspaceId: "ws_1",
    })
    expect(storage.getItem("claxedo:harness-map")).toBeNull()
    expect(storage.getItem("claxedo:acp-model-map")).toBeNull()
    expect(storage.getItem("claxedo:agent-mode-map")).toBeNull()
    expect(JSON.parse(storage.getItem("claxedo:model-variant-map")!)).toEqual({ "draft:one": "fast" })
  })

  test("restores a saved pair only through its captured exact-eligibility revision", () => {
    createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: "codex-acp", model: { providerID: "codex-acp", modelID: "gpt-5.5" } },
    )
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })!

    expect(store.read("draft:one")).toMatchObject({
      harness: "codex-acp",
      selectedModel: "gpt-5.5",
      draftDefaultAuthority: "unresolved",
      optionsLoading: true,
    })
    expect(store.draftDefaultModel("draft:one")).toEqual({
      providerID: "codex-acp",
      modelID: "gpt-5.5",
    })
    expect(store.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "codex-acp"],
      eligibleModels: [{ providerID: "codex-acp", modelID: "gpt-5.5" }],
    })).toBe(true)
    expect(store.read("draft:one")).toMatchObject({
      draftDefaultAuthority: "defaulted",
      draftDefaultState: "ready",
      selectedModel: "gpt-5.5",
    })
    expect(store.read("draft:one").configError).toBeUndefined()
  })

  test("keeps the existing OpenCode draft behavior when no workspace default exists", () => {
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })

    expect(begun?.saved).toBeUndefined()
    expect(store.read("draft:one")).toMatchObject({
      harness: "opencode",
      selectedModel: "",
      draftDefaultAuthority: "defaulted",
      draftDefaultState: "ready",
      optionsLoading: false,
    })
    expect(store.read("draft:one").configError).toBeUndefined()
  })

  test("keeps a stale saved model selected but blocked", () => {
    createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      {
        harness: "claude-acp",
        model: { providerID: "claude-acp", modelID: "removed" },
        labels: { model: "Claude Opus" },
      },
    )
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })!

    store.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "claude-acp"],
      eligibleModels: [{ providerID: "claude-acp", modelID: "sonnet" }],
    })
    expect(store.read("draft:one")).toMatchObject({
      harness: "claude-acp",
      selectedModel: "removed",
      draftDefaultState: "saved-model-unavailable",
      configError: "Saved model unavailable",
    })
    expect(store.draftDefaultLabels("draft:one")).toEqual({ model: "Claude Opus" })
    expect(store.harnessReadyForSubmit("draft:one")).toBe(false)

    store.applyPatch("draft:one", { dynamicModels: [{ id: "sonnet", name: "Sonnet" }] })
    expect(store.rememberDraftModel(
      "draft:one",
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { providerID: "claude-acp", modelID: "sonnet" },
    )).toBe(true)
    expect(store.read("draft:one")).toMatchObject({
      draftDefaultState: "ready",
      draftDefaultAuthority: "explicit",
    })
    expect(store.read("draft:one").configError).toBeUndefined()
  })

  test("server-owned sessions clear draft-only model errors before hydration", () => {
    const store = createHarnessStore(storage)
    store.applyPatch("session:one", {
      draftDefault: {
        harness: "pi",
        model: { providerID: "anthropic", modelID: "removed" },
      },
      draftDefaultState: "saved-model-unavailable",
      configError: "Saved model unavailable",
    })

    store.markServer("session:one")

    expect(store.read("session:one")).toMatchObject({
      draftDefaultAuthority: "server",
      draftDefaultWritePending: false,
    })
    expect(store.read("session:one").draftDefault).toBeUndefined()
    expect(store.read("session:one").draftDefaultState).toBeUndefined()
    expect(store.read("session:one").configError).toBeUndefined()
  })

  test("explicit selection and promotion invalidate captured default work", () => {
    createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } },
    )
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })!
    expect(store.rememberDraftModel(
      "draft:one",
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { providerID: "anthropic", modelID: "opus" },
    )).toBe(true)
    expect(store.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "pi"],
      eligibleModels: [{ providerID: "openai", modelID: "gpt-5.5" }],
    })).toBe(false)

    store.promote("draft:one", "session:ses_1")
    expect(store.read("session:ses_1").draftDefaultAuthority).toBe("server")
    expect(store.read("session:ses_1").draftDefaultRevision).toBeGreaterThan(begun.application.revision)
  })

  test("persists config-option harness-only intent until live options complete it", () => {
    const store = createHarnessStore(storage)
    store.applyPatch("draft:one", { harness: "codex-acp", selectedModel: "default" })
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }

    expect(store.rememberDraftHarness("draft:one", identity, "codex-acp")).toBe(true)
    expect(createDraftDefaultPreferences(storage).read(identity)).toEqual({
      version: 1,
      harness: "codex-acp",
    })
    expect(store.completeRememberedHarness(
      "draft:one",
      "codex-acp",
      { providerID: "codex-acp", modelID: "gpt-5.5" },
    )).toBe(true)
    expect(createDraftDefaultPreferences(storage).read(identity)?.model).toEqual({
      providerID: "codex-acp",
      modelID: "gpt-5.5",
    })
  })

  test("persists friendly recovery labels with an explicit model pair", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    store.applyPatch("draft:one", { harness: "pi" })

    expect(store.rememberDraftModel(
      "draft:one",
      identity,
      { providerID: "openai-codex", modelID: "gpt-5.5" },
      { provider: "OpenAI Codex", model: "GPT-5.5" },
    )).toBe(true)
    expect(createDraftDefaultPreferences(storage).read(identity)?.labels).toEqual({
      provider: "OpenAI Codex",
      model: "GPT-5.5",
    })
  })

  test("rejects a model that does not belong to the current config harness", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    store.applyPatch("draft:one", {
      harness: "codex-acp",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      draftDefaultState: "choose-model",
    })

    expect(store.rememberDraftModel(
      "draft:one",
      identity,
      { providerID: "anthropic", modelID: "gpt-5.5" },
    )).toBe(false)
    expect(store.read("draft:one").draftDefaultState).toBe("choose-model")
    expect(createDraftDefaultPreferences(storage).read(identity)).toBeUndefined()
  })

})

class MemoryStorage implements PanePreferenceStorage {
  private values: Record<string, string> = {}
  getCount = 0

  getItem(key: string) {
    this.getCount++
    return this.values[key] ?? null
  }

  setItem(key: string, value: string) {
    this.values[key] = value
  }
}
