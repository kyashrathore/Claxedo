import { describe, expect, test } from "bun:test"
import { createPromptToolbarState } from "./toolbar-state"
import {
  promptModelResolutionState,
  selectRuntimeModel,
  shouldUsePromptFallbackModel,
} from "./model-strategy"
import { resolveSubmittedConfig } from "@/features/session/submit/resolve"
import { submitBlockReason } from "./submit-block-reason"
import {
  SIGNED_WORKSPACE_DEFAULT_MODEL_ID,
  SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER,
} from "./signed-workspace-model"

const sonnet = { id: "sonnet", name: "Claude Sonnet", provider: { id: "anthropic" } }
const placeholder = {
  id: SIGNED_WORKSPACE_DEFAULT_MODEL_ID,
  name: "Big Pickle",
  provider: { id: SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER },
}

function toolbar(input: Partial<Parameters<typeof createPromptToolbarState>[0]> = {}) {
  return createPromptToolbarState({
    agentList: () => [{ name: "build" }],
    currentAgent: () => ({ name: "build" }),
    fallbackAgent: () => undefined,
    agentOverride: () => undefined,
    providerLoading: () => false,
    currentModel: () => undefined,
    currentModelSource: () => undefined,
    hasSelectedModel: () => false,
    modelRestorePending: () => false,
    selectionCatalogPending: () => false,
    harnessMode: () => false,
    isOpenCodeHarness: () => true,
    existingSession: () => false,
    variantList: () => [],
    selectedVariant: () => undefined,
    configuredVariant: () => undefined,
    ...input,
  })
}

describe("model selection policy", () => {
  test("selectRuntimeModel never substitutes provider catalog defaults", () => {
    expect(
      selectRuntimeModel(
        {
          all: [{ id: "openai", models: { "gpt-5.3-chat-latest": { name: "GPT 5.3 Chat" } } }],
          connected: ["openai"],
          default: { openai: "gpt-5.3-chat-latest" },
        },
        undefined,
      ),
    ).toBeUndefined()
  })

  test("selectRuntimeModel rejects the signed-workspace placeholder even when explicitly selected", () => {
    expect(selectRuntimeModel({}, placeholder)).toBeUndefined()
  })

  test("shouldUsePromptFallbackModel is permanently disabled", () => {
    expect(
      shouldUsePromptFallbackModel({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: false,
        providerLoading: false,
      }),
    ).toBe(false)
    expect(
      shouldUsePromptFallbackModel({
        harnessMode: false,
        hasCurrentModel: false,
        hasSelection: true,
        providerLoading: false,
      }),
    ).toBe(false)
  })

  test("prompt model resolution never exposes a fallback flag", () => {
    const state = promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: false,
    })
    expect(state).toEqual({ type: "uninitialized" })
    expect("fallback" in state).toBe(false)
  })

  test("toolbar blocks submit until an explicit model is resolved", () => {
    const blocked = toolbar()
    expect(blocked.currentModel()).toBeUndefined()
    expect(blocked.modelSubmitBlocked()).toBe(true)
    expect(blocked.readiness().label).toBe("Select model")

    const ready = toolbar({
      currentModel: () => sonnet,
      currentModelSource: () => "selected",
      hasSelectedModel: () => true,
    })
    expect(ready.currentModel()).toEqual(sonnet)
    expect(ready.modelSubmitBlocked()).toBe(false)
    expect(ready.readiness().label).toBe("Claude Sonnet")
  })

  test("toolbar ignores legacy fallback source models", () => {
    const state = toolbar({
      currentModel: () => sonnet,
      currentModelSource: () => "fallback",
      hasSelectedModel: () => true,
    })
    expect(state.currentModel()).toBeUndefined()
    expect(state.modelSubmitBlocked()).toBe(true)
  })

  test("toolbar treats the signed-workspace placeholder as missing", () => {
    const state = toolbar({
      currentModel: () => placeholder,
      currentModelSource: () => "selected",
      hasSelectedModel: () => true,
    })
    expect(state.modelSubmitBlocked()).toBe(true)
    expect(state.readiness().label).toBe("Select model")
  })

  test("resolveSubmittedConfig refuses to submit without an explicit selected model", async () => {
    let calls = 0
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      currentAgent: { name: "build" },
      modelForSubmit: async (model) => {
        calls++
        return model
      },
    })
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("resolveSubmittedConfig keeps an explicit selected model", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      currentAgent: { name: "build" },
      modelForSubmit: async (model) => model,
    })
    expect(result).toEqual({
      model: { providerID: "anthropic", modelID: "sonnet" },
      agent: "build",
    })
  })

  test("stale draft-default choose-model does not block after toolbar resolves a model", () => {
    expect(submitBlockReason({
      roleBlocked: false,
      harnessMode: false,
      harnessReadiness: "ready",
      harnessConfigError: false,
      harnessOptionsLoading: false,
      harnessReadyForSubmit: true,
      needsModelSelection: true,
      modelBlocked: false,
      modelBlockLabel: "HY3 Free",
      providerLoading: false,
      booting: false,
      stoppable: false,
      blank: false,
    })).toBeNull()
  })
})
