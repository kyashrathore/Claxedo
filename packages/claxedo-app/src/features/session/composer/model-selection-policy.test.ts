import { describe, expect, test } from "bun:test"
import { createPromptToolbarState } from "./toolbar-state"
import { resolveSubmittedConfig } from "@/features/session/submit/resolve"
import { submitBlockReason } from "./submit-block-reason"
const sonnet = { id: "sonnet", name: "Claude Sonnet", provider: { id: "anthropic" } }

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
    existingSession: () => false,
    variantList: () => [],
    selectedVariant: () => undefined,
    configuredVariant: () => undefined,
    ...input,
  })
}

describe("model selection policy", () => {
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

  test("resolveSubmittedConfig refuses to submit without an explicit selected model", async () => {
    const result = await resolveSubmittedConfig({ currentAgent: { name: "build" } })
    expect(result).toBeUndefined()
  })

  test("resolveSubmittedConfig keeps an explicit selected model", async () => {
    const result = await resolveSubmittedConfig({
      harnessModelKey: { providerID: sonnet.provider.id, modelID: sonnet.id },
      currentAgent: { name: "build" },
    })
    expect(result).toEqual({
      model: { providerID: "anthropic", modelID: "sonnet" },
      agent: "build",
    })
  })

  test("stale draft-default choose-model does not block after toolbar resolves a model", () => {
    expect(submitBlockReason({
      authorityBlock: undefined,
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
