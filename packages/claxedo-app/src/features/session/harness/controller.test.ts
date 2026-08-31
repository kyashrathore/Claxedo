import { describe, expect, test } from "bun:test"
import {
  createHarnessSelectionController,
  createHarnessSubmitController,
  type HarnessSelectionControllerStore,
  type HarnessSubmitControllerStore,
} from "./controller"

function selectionStore(overrides: Partial<HarnessSelectionControllerStore> = {}): HarnessSelectionControllerStore {
  return {
    hydrate: () => undefined,
    reprobe: () => undefined,
    probeHealth: () => undefined,
    markUnavailable: () => undefined,
    setHarness: () => undefined,
    setModel: () => undefined,
    rememberDraftModel: () => undefined,
    resolveDraftDefault: () => false,
    harness: () => ({ kind: "connection", connectionId: "codex-team" }),
    isHarnessMode: () => true,
    readiness: () => "ready",
    models: () => [{ id: "gpt-5.5", name: "GPT-5.5" }],
    thoughtLevels: () => [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
    selectedThoughtLevel: () => "high",
    setThoughtLevel: () => {},
    selectedModel: () => "gpt-5.5",
    selectedModelKey: () => ({ providerID: "codex-team", modelID: "gpt-5.5" }),
    optionsStale: () => false,
    optionsLoading: () => false,
    configError: () => undefined,
    draftDefaultState: () => undefined,
    draftDefaultLabels: () => undefined,
    draftDefaultModel: () => undefined,
    ...overrides,
  }
}

function submitStore(overrides: Partial<HarnessSubmitControllerStore> = {}): HarnessSubmitControllerStore {
  return {
    ...selectionStore(),
    claimSession: async () => undefined,
    promote: () => undefined,
    harnessReadyForSubmit: () => true,
    harnessModelKeyForSubmit: () => ({ providerID: "codex-team", modelID: "gpt-5.5" }),
    ...overrides,
  }
}

describe("harness controller facade", () => {
  const sessionConfig = {
    agent: "build",
    model: { providerID: "codex-team", modelID: "gpt-5.5" },
    variant: "high",
  }

  test("reads selector state from the backing store", () => {
    expect(createHarnessSelectionController(selectionStore()).read("scope")).toEqual({
      harness: { kind: "connection", connectionId: "codex-team" },
      isHarnessMode: true,
      readiness: "ready",
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      thoughtLevels: [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
      selectedThoughtLevel: "high",
      selectedModel: "gpt-5.5",
      selectedModelProvider: "codex-team",
      selectedModelKey: { providerID: "codex-team", modelID: "gpt-5.5" },
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
      draftDefaultState: undefined,
      draftDefaultLabels: undefined,
      draftDefaultModel: undefined,
    })
  })

  test("forwards selector mutations with scope input", async () => {
    const calls: unknown[] = []
    const controller = createHarnessSelectionController(selectionStore({
      hydrate: (...args) => calls.push(["hydrate", ...args]),
      setHarness: (...args) => calls.push(["setHarness", ...args]),
      setModel: (...args) => calls.push(["setModel", ...args]),
      rememberDraftModel: (...args) => calls.push(["rememberDraftModel", ...args]),
      resolveDraftDefault: (...args) => {
        calls.push(["resolveDraftDefault", ...args])
        return true
      },
    }))

    await controller.hydrate("scope", { directory: "/repo", sessionId: "new" })
    await controller.setHarness("scope", { kind: "native", harnessId: "claude" }, { directory: "/repo" })
    await controller.setModel("scope", { providerID: "claude", modelID: "sonnet" }, { sessionId: "ses_1" }, { model: "Sonnet" })
    controller.rememberDraftModel("scope", { providerID: "openai", modelID: "gpt-5.5" }, { directory: "/repo" }, { provider: "OpenAI" })
    controller.resolveDraftDefault("scope", {
      supportedHarnesses: [
        { kind: "connection", connectionId: "external-opencode" },
        { kind: "native", harnessId: "pi" },
      ],
      eligibleModels: [{ providerID: "openai", modelID: "gpt-5.5" }],
    })

    expect(calls).toEqual([
      ["hydrate", "scope", { directory: "/repo", sessionId: "new" }],
      ["setHarness", "scope", { kind: "native", harnessId: "claude" }, { directory: "/repo" }],
      ["setModel", "scope", { providerID: "claude", modelID: "sonnet" }, { sessionId: "ses_1" }, { model: "Sonnet" }],
      ["rememberDraftModel", "scope", { providerID: "openai", modelID: "gpt-5.5" }, { directory: "/repo" }, { provider: "OpenAI" }],
      ["resolveDraftDefault", "scope", {
        supportedHarnesses: [
          { kind: "connection", connectionId: "external-opencode" },
          { kind: "native", harnessId: "pi" },
        ],
        eligibleModels: [{ providerID: "openai", modelID: "gpt-5.5" }],
      }],
    ])
  })

  test("submit controller remains unresolved when the backing store is absent", async () => {
    const controller = createHarnessSubmitController(undefined)

    expect(controller.harness("scope")).toBeUndefined()
    expect(controller.isHarnessMode("scope")).toBe(false)
    expect(controller.readiness("scope")).toBe("unresolved")
    expect(controller.readyForSubmit("scope")).toBe(false)
    expect(controller.modelKeyForSubmit("scope")).toBeUndefined()
    expect(await controller.claimSession("scope", {
      harness: { kind: "native", harnessId: "pi" },
      sessionConfig,
    })).toBeUndefined()
    await expect(controller.setHarness("scope", { kind: "connection", connectionId: "external-opencode" })).resolves.toBeUndefined()
  })

  test("submit controller forwards claim, model, and promotion operations", async () => {
    const calls: unknown[] = []
    const controller = createHarnessSubmitController(submitStore({
      claimSession: async (...args) => {
        calls.push(["claimSession", ...args])
        return { id: "ses_harness" }
      },
      promote: (...args) => calls.push(["promote", ...args]),
    }))

    expect(controller.modelKeyForSubmit("scope")).toEqual({ providerID: "codex-team", modelID: "gpt-5.5" })
    expect(await controller.claimSession("scope", {
      directory: "/repo",
      harness: { kind: "native", harnessId: "pi" },
      sessionConfig,
    })).toEqual({ id: "ses_harness" })
    controller.promote("draft", "session")

    expect(calls).toEqual([
      ["claimSession", "scope", {
        directory: "/repo",
        harness: { kind: "native", harnessId: "pi" },
        sessionConfig,
      }],
      ["promote", "draft", "session"],
    ])
  })
})
