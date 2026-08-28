import { createRoot } from "solid-js"
import { describe, expect, test } from "bun:test"
import { createPromptToolbarState } from "./toolbar-state"

function toolbar(input: {
  restorePending: boolean
  model?: { id: string; name?: string; provider: { id: string } }
}) {
  return createRoot((dispose) => {
    const state = createPromptToolbarState({
      agentList: () => [{ name: "build" }],
      currentAgent: () => ({ name: "build" }),
      fallbackAgent: () => undefined,
      agentOverride: () => undefined,
      providerConnected: () => [],
      providerDefaults: () => ({}),
      providerLoading: () => false,
      currentModel: () => input.model,
      currentModelSource: () => input.model ? "selected" : undefined,
      hasSelectedModel: () => !!input.model,
      modelRestorePending: () => input.restorePending,
      fallbackModel: () => undefined,
      harnessMode: () => false,
      isOpenCodeHarness: () => true,
      existingSession: () => true,
      variantList: () => [],
      selectedVariant: () => undefined,
      configuredVariant: () => undefined,
    })
    const result = state.readiness()
    dispose()
    return result
  })
}

describe("prompt toolbar model restore", () => {
  test("keeps an existing session inert while its authoritative model is hydrating", () => {
    expect(toolbar({ restorePending: true })).toEqual({
      blocked: true,
      disabled: true,
      label: "Loading models",
    })
  })

  test("a restored model is immediately ready even before the pending flag settles", () => {
    expect(toolbar({
      restorePending: true,
      model: { id: "gpt-5", name: "GPT-5", provider: { id: "openai" } },
    })).toEqual({
      blocked: false,
      disabled: false,
      label: "GPT-5",
    })
  })
})
