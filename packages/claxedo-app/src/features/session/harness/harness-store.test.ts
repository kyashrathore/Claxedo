import { beforeEach, describe, expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { createHarnessStore } from "./harness-store"
import { createDraftDefaultPreferences } from "./draft-defaults"
import { applyHarnessOptionsResponse } from "./options-state"
import type { OptionsResponse } from "./profile"

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
})

describe("harness store facade", () => {
  test("reads an empty projection without seeding", () => {
    const store = createHarnessStore(storage)

    expect(store.state("session:ses_1")).toBeUndefined()
    for (const scope of ["session:ses_1", "session:ses_2"]) {
      expect(store.read(scope)).toMatchObject({
        harness: "opencode",
        selectedModel: "",
      })
    }
    expect(store.state("session:ses_1")).toBeUndefined()
    expect(store.state("session:ses_2")).toBeUndefined()
  })

  test("reuses one immutable initial projection for repeated unseeded reads", () => {
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
    const store = createHarnessStore(storage)
    const state = store.touch("draft:one")

    expect(state.harness).toBe("opencode")
    expect(store.state("draft:one")).toBe(state)

    store.applyPatch("draft:one", {
      harness: "acp:claude",
      selectedModel: "opus",
    })
    store.seed("draft:one")

    expect(store.read("draft:one")).toMatchObject({
      harness: "acp:claude",
      selectedModel: "opus",
    })
  })

  test("seed never overwrites live state on a second call", () => {
    const store = createHarnessStore(storage)
    store.seed("draft:one")
    store.applyPatch("draft:one", { selectedModel: "opus" })
    store.seed("draft:one")

    expect(store.read("draft:one").selectedModel).toBe("opus")
  })

  test("applies patches and derives submit selectors from the current state", () => {
    const store = createHarnessStore(storage)

    store.seed("draft:/repo:route")
    store.applyPatch("draft:/repo:route", {
      harness: "acp:claude",
      harnessMode: "harness",
      selectedModel: "opus",
      dynamicModels: [{ id: "opus", name: "Opus" }],
      optionsLoading: false,
      readiness: "ready",
    })

    expect(store.harness("draft:/repo:route")).toBe("acp:claude")
    expect(store.selectedModel("draft:/repo:route")).toBe("opus")
    expect(store.models("draft:/repo:route")).toEqual([{ id: "opus", name: "Opus" }])
    expect(store.harnessModelKeyForSubmit("draft:/repo:route")).toEqual({
      providerID: "acp:claude",
      modelID: "opus",
    })
    expect(store.harnessModelNameForSubmit("draft:/repo:route")).toBe("Opus")
    expect(store.harnessReadyForSubmit("draft:/repo:route")).toBe(true)
  })

  test("applies falsy patch values without truthy filtering", () => {
    const store = createHarnessStore(storage)

    store.applyPatch("draft:/repo:route", {
      harness: "acp:claude",
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
      harness: "acp:claude",
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
      harness: "acp:codex",
      harnessMode: "harness",
      selectedModel: "",
      optionsLoading: false,
      optionsStale: false,
      configError: "",
    })

    expect(store.state("draft:/repo:route")).toMatchObject({
      harness: "acp:codex",
      selectedModel: "",
      optionsLoading: false,
      optionsStale: false,
      configError: "",
    })
    expect(store.selectedModel("draft:/repo:route")).toBe("")
  })

  test("promotes full transient state to the session scope", () => {
    const store = createHarnessStore(storage)

    store.seed("draft:one")
    store.applyPatch("draft:one", {
      harness: "acp:codex",
      harnessMode: "harness",
      harnessBinary: "/bin/codex",
      selectedModel: "gpt-5.5",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      readiness: "error",
      optionsSource: "harness",
      optionsStale: true,
      optionsLoading: true,
      configError: "missing binary",
      workspaceId: "ws_1",
    })

    store.promote("draft:one", "session:ses_1")

    // read() returns the live reactive store proxy (production needs that for
    // reactivity); unwrap to a plain snapshot so bun:test's toMatchObject can
    // recurse the nested dynamicModels array (a nested solid proxy otherwise
    // trips the matcher — the promoted content itself is correct).
    expect(unwrap(store.read("session:ses_1"))).toMatchObject({
      harness: "acp:codex",
      harnessBinary: "/bin/codex",
      selectedModel: "gpt-5.5",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      readiness: "error",
      optionsSource: "harness",
      optionsStale: true,
      optionsLoading: true,
      configError: "missing binary",
      workspaceId: "ws_1",
    })
  })

  test("restores a saved pair only through its captured exact-eligibility revision", () => {
    createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: "acp:codex", model: { providerID: "acp:codex", modelID: "gpt-5.5" } },
    )
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })!

    expect(store.read("draft:one")).toMatchObject({
      harness: "acp:codex",
      selectedModel: "gpt-5.5",
      draftDefaultAuthority: "unresolved",
      optionsLoading: true,
    })
    expect(store.draftDefaultModel("draft:one")).toEqual({
      providerID: "acp:codex",
      modelID: "gpt-5.5",
    })
    expect(store.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "acp:codex"],
      eligibleModels: [{ providerID: "acp:codex", modelID: "gpt-5.5" }],
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
        harness: "acp:claude",
        model: { providerID: "acp:claude", modelID: "removed" },
        labels: { model: "Claude Opus" },
      },
    )
    const store = createHarnessStore(storage)
    const begun = store.beginDraftDefault("draft:one", {
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })!

    store.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "acp:claude"],
      eligibleModels: [{ providerID: "acp:claude", modelID: "sonnet" }],
    })
    expect(store.read("draft:one")).toMatchObject({
      harness: "acp:claude",
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
      { providerID: "acp:claude", modelID: "sonnet" },
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

  /**
   * A switch is a choice of HARNESS. The live selection belongs to the harness
   * being left, and the model the incoming harness resolves is a default — so
   * the switch remembers the harness and no model at all, and the draft keeps
   * showing whatever the harness resolves.
   */
  test("a switch to a harness with no pick remembers the harness with no model", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    // The live selection is the default `acp:codex` resolved for itself.
    store.applyPatch("draft:one", {
      harness: "acp:codex",
      selectedModel: "gpt-5.5",
      selectedModelProvider: "acp:codex",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    })

    // Pi routes to any provider, so nothing but the rule stops the codex model
    // from being filed as a Pi choice.
    expect(store.rememberDraftHarness("draft:one", identity, "pi")).toBe(true)

    expect(createDraftDefaultPreferences(storage).read(identity)).toEqual({ harness: "pi" })
    expect(store.draftDefaultModel("draft:one")).toBeUndefined()
    expect(store.protectDraftModel("draft:one")).toBe(false)
  })

  /**
   * The whole rule in one sequence: switch to a config-option harness without
   * picking anything, let the harness resolve its own model, then let the
   * catalog change under it. The resolved model is SHOWN every time and
   * remembered never, so no load and no reload can accuse the user of
   * selecting a model that is gone.
   */
  test("a harness-resolved model is shown, never remembered, and never reported unavailable", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    store.beginDraftHarnessChoice("draft:one", identity, "claude-sdk")
    // What `harnessSwitchStartPatch` writes alongside the choice.
    store.applyPatch("draft:one", { harness: "claude-sdk", harnessMode: "harness" })
    expect(store.rememberDraftHarness("draft:one", identity, "claude-sdk")).toBe(true)

    // The options load answers: `default` is the harness's own current value.
    store.applyPatch("draft:one", optionsPatch(store, "draft:one", ["default", "sonnet"], "default"))

    expect(store.read("draft:one").selectedModel).toBe("default")
    expect(store.draftDefaultModel("draft:one")).toBeUndefined()
    expect(createDraftDefaultPreferences(storage).read(identity)).toEqual({ harness: "claude-sdk" })

    // The harness stops offering `default`: the next load resolves the harness's
    // new default instead of reporting the old one unavailable.
    store.applyPatch("draft:one", optionsPatch(store, "draft:one", ["sonnet", "haiku"], "sonnet"))

    expect(store.read("draft:one").selectedModel).toBe("sonnet")
    expect(store.read("draft:one").configError).toBeUndefined()

    // A reload of the same workspace: the harness is remembered, the model is
    // whatever the harness resolves now.
    const reloaded = createHarnessStore(storage)
    const begun = reloaded.beginDraftDefault("draft:two", identity)!
    expect(begun.saved).toEqual({ harness: "claude-sdk" })
    expect(reloaded.applyDraftDefault(begun.application, {
      supportedHarnesses: ["opencode", "claude-sdk"],
      eligibleModels: [
        { providerID: "claude-sdk", modelID: "sonnet" },
        { providerID: "claude-sdk", modelID: "haiku" },
      ],
      declaredDefaultModel: { providerID: "claude-sdk", modelID: "sonnet" },
    })).toBe(true)
    expect(reloaded.read("draft:two")).toMatchObject({
      harness: "claude-sdk",
      selectedModel: "sonnet",
      draftDefaultState: "ready",
    })
    expect(reloaded.read("draft:two").configError).toBeUndefined()
  })

  test("a pick belongs to its own (workspace, harness) scope and survives a reload", () => {
    const store = createHarnessStore(storage)
    const workspaceOne = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    const workspaceTwo = { serverUrl: "http://localhost:4096", workspaceKey: "ws_2" }
    store.applyPatch("draft:one", {
      harness: "acp:codex",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    })

    expect(store.rememberDraftModel(
      "draft:one",
      workspaceOne,
      { providerID: "acp:codex", modelID: "gpt-5.5" },
    )).toBe(true)
    expect(store.protectDraftModel("draft:one")).toBe(true)

    // Another workspace remembers nothing, so it opens on the placement default.
    expect(store.beginDraftDefault("draft:two", workspaceTwo)?.saved).toBeUndefined()
    expect(store.read("draft:two")).toMatchObject({ harness: "opencode", selectedModel: "" })

    // The pick outlives the store that made it.
    const reloaded = createHarnessStore(storage)
    reloaded.beginDraftDefault("draft:three", workspaceOne)
    expect(reloaded.read("draft:three")).toMatchObject({
      harness: "acp:codex",
      selectedModel: "gpt-5.5",
      selectedModelProvider: "acp:codex",
    })
  })

  // D1: each harness owns its own slot in one workspace, so switching away and
  // back returns to the model that harness was on.
  test("restores the model the chosen harness was last on, leaving the other's alone", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(identity, { harness: "acp:codex", model: { providerID: "acp:codex", modelID: "gpt-5.5" } })
    preferences.save(identity, { harness: "acp:claude", model: { providerID: "acp:claude", modelID: "opus" } })

    store.beginDraftHarnessChoice("draft:one", identity, "acp:codex")

    expect(store.read("draft:one")).toMatchObject({
      draftDefaultAuthority: "explicit",
      draftDefaultState: "ready",
      selectedModel: "gpt-5.5",
      selectedModelProvider: "acp:codex",
    })
    expect(store.draftDefaultModel("draft:one")).toEqual({ providerID: "acp:codex", modelID: "gpt-5.5" })
    // The harness left behind keeps its own model.
    expect(preferences.readHarness(identity, "acp:claude")?.model?.modelID).toBe("opus")
  })

  test("a harness with nothing remembered opens unresolved rather than on another harness's model", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    createDraftDefaultPreferences(storage).save(identity, {
      harness: "acp:claude",
      model: { providerID: "acp:claude", modelID: "opus" },
    })

    store.beginDraftHarnessChoice("draft:one", identity, "acp:codex")

    expect(store.read("draft:one").selectedModel).toBe("")
    expect(store.draftDefaultModel("draft:one")).toBeUndefined()
    expect(store.read("draft:one").draftDefaultState).toBeUndefined()
    expect(store.protectDraftModel("draft:one")).toBe(false)
  })

  // Remembering a harness must not blank the slot it cannot fill: the live
  // selection belongs to the harness being left.
  test("remembering a harness keeps its own saved model when the live selection is another harness's", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(identity, { harness: "acp:codex", model: { providerID: "acp:codex", modelID: "gpt-5.5" } })
    store.applyPatch("draft:one", {
      harness: "acp:claude",
      selectedModel: "opus",
      selectedModelProvider: "acp:claude",
      dynamicModels: [{ id: "opus", name: "Opus" }],
    })

    expect(store.rememberDraftHarness("draft:one", identity, "acp:codex")).toBe(true)

    expect(preferences.readHarness(identity, "acp:codex")?.model).toEqual({
      providerID: "acp:codex",
      modelID: "gpt-5.5",
    })
    expect(store.read("draft:one").draftDefaultState).toBe("ready")
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
      harness: "acp:codex",
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

  /**
   * The rule the native SDK harnesses make visible: a harness that resolves a
   * model for itself (the real `claude` catalog's `default` sentinel is its own
   * `currentValue`) supplies the DEFAULT a scope shows, and an explicit pick
   * outranks it for that (server, workspace, harness) — including for the next
   * draft, which is what a reload of the same scope reads.
   */
  test("an explicit pick outranks the model the harness resolved, for this scope and the next draft", () => {
    const store = createHarnessStore(storage)
    const identity = { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" }
    store.beginDraftHarnessChoice("draft:one", identity, "claude-sdk")
    // What `harnessSwitchStartPatch` writes alongside the choice.
    store.applyPatch("draft:one", { harness: "claude-sdk", harnessMode: "harness" })
    // The live options answer: five rows, `default` resolved by the harness.
    store.applyPatch("draft:one", {
      selectedModel: "default",
      dynamicModels: [
        { id: "default", name: "Default (recommended)" },
        { id: "sonnet", name: "Sonnet" },
        { id: "haiku", name: "Haiku" },
      ],
    })
    expect(store.rememberDraftModel(
      "draft:one",
      identity,
      { providerID: "claude-sdk", modelID: "sonnet" },
      { provider: "Claude", model: "Sonnet" },
    )).toBe(true)
    store.setSelectedModel("draft:one", { providerID: "claude-sdk", modelID: "sonnet" })
    expect(store.read("draft:one")).toMatchObject({
      selectedModel: "sonnet",
      draftDefaultAuthority: "explicit",
      draftDefaultState: "ready",
    })
    expect(store.protectDraftModel("draft:one")).toBe(true)

    // A fresh scope on the same workspace — what a reload produces.
    store.beginDraftDefault("draft:two", identity)
    expect(store.read("draft:two")).toMatchObject({
      harness: "claude-sdk",
      selectedModel: "sonnet",
      selectedModelProvider: "claude-sdk",
    })

    // ...and choosing for one harness leaves the other's slot untouched.
    const preferences = createDraftDefaultPreferences(storage)
    expect(preferences.readHarness(identity, "codex-app-server")).toBeUndefined()
    store.beginDraftHarnessChoice("draft:two", identity, "codex-app-server")
    expect(store.read("draft:two").selectedModel).toBe("")
    expect(preferences.readHarness(identity, "claude-sdk")?.model).toEqual({
      providerID: "claude-sdk",
      modelID: "sonnet",
    })
  })

})

/**
 * One live options answer, run through the same policy the options loader
 * uses — including the `preserveSelectedModel` question this store answers, so
 * the test exercises the real path from a chosen/unchosen model to
 * "Selected model unavailable".
 */
function optionsPatch(
  store: ReturnType<typeof createHarnessStore>,
  scope: string,
  models: string[],
  currentValue: string,
) {
  const payload: OptionsResponse = {
    source: "harness",
    stale: false,
    options: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      selectOptions: models.map((id) => ({ id, name: id })),
    }],
  }
  return applyHarnessOptionsResponse({
    type: store.harness(scope),
    selectedModel: store.selectedModel(scope),
    preserveSelectedModel: store.protectDraftModel(scope),
    payload,
    tries: 0,
  }).patch
}

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
