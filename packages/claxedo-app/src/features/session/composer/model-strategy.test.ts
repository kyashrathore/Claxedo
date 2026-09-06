import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  firstValidSelectionModel,
  getConfiguredAgentVariant,
  promptModelResolutionState,
  promptModelState,
  resolveModelVariant,
} from "./model-strategy"

describe("model-strategy", () => {
  test("picks the first valid saved selection model from restore candidates", () => {
    expect(firstValidSelectionModel({
      selections: [
        undefined,
        { model: { providerID: "opencode", modelID: "north-mini-code-free" } },
        { model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" } },
      ],
      valid: (model) => model.modelID === "deepseek-v4-flash-free",
    })).toEqual({ providerID: "opencode", modelID: "deepseek-v4-flash-free" })
  })

  test("allows provider-mode submit when model is resolved", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      model: { name: "Nano Banana Pro" },
      agent: { name: "build" },
    })).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("blocks provider-mode submit while provider models are loading", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: true,
      agent: { name: "build" },
    })).toEqual({
      blocked: true,
      disabled: true,
      label: "Loading models",
    })
  })

  test("blocks provider-mode submit while an existing session model is restoring", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      restoreLoading: true,
      agent: { name: "build" },
    })).toEqual({
      blocked: true,
      disabled: true,
      label: "Loading models",
    })
  })

  test("blocks provider-mode submit when no model can be resolved", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      agent: { name: "build" },
    })).toEqual({
      blocked: true,
      disabled: true,
      label: "Select model",
    })
  })

  test("uses the model label when live agent options are unavailable", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      model: { name: "Nano Banana Pro" },
    })).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("allows provider-mode submit with an explicit agent override", () => {
    expect(promptModelState({
      harnessMode: false,
      providerLoading: false,
      model: { name: "Nano Banana Pro" },
      agentOverride: "doc",
    })).toEqual({
      blocked: false,
      disabled: false,
      label: "Nano Banana Pro",
    })
  })

  test("leaves runner mode to the runner readiness state machine", () => {
    expect(promptModelState({
      harnessMode: true,
      providerLoading: true,
    })).toEqual({
      blocked: false,
      disabled: false,
      label: undefined,
    })
  })

  test("prompt model resolution never enables catalog fallback", () => {
    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: false,
    })).toEqual({ type: "uninitialized" })

    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: true,
      providerLoading: false,
    })).toEqual({ type: "invalid-selected" })

    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: true,
    })).toEqual({ type: "hydrating" })

    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: false,
      restoreLoading: true,
    })).toEqual({ type: "hydrating" })

    expect(promptModelResolutionState({
      harnessMode: false,
      existingSession: true,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: false,
      restoreLoading: false,
    })).toEqual({ type: "needs-selection" })

    expect(promptModelResolutionState({
      harnessMode: true,
      hasCurrentModel: false,
      hasSelection: false,
      providerLoading: false,
    })).toEqual({ type: "harness-owned" })

    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: true,
      hasSelection: false,
      providerLoading: false,
    })).toEqual({ type: "resolved" })
  })

  test("selected model wins while provider data catches up", () => {
    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: true,
      providerLoading: true,
    })).toEqual({ type: "selected" })

  })

  test("saved non-default selection waits for provider detail without falling back", () => {
    expect(promptModelResolutionState({
      harnessMode: false,
      hasCurrentModel: false,
      hasSelection: true,
      providerLoading: false,
      selectionCatalogPending: true,
    })).toEqual({ type: "selected" })

  })

  test("resolves configured agent variant when model matches", () => {
    expect(getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })).toBe("xhigh")
  })

  test("ignores configured agent variant when model does not match", () => {
    expect(getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    expect(resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    expect(resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    expect(cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    expect(cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    expect(cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })).toBe("low")
  })

  test("keeps the strategy free of UI and reactive imports", async () => {
    const source = await Bun.file(new URL("./model-strategy.ts", import.meta.url)).text()

    expect(source).not.toMatch(/from "solid-js"/)
    expect(source).not.toMatch(/from "@tanstack\/solid-query"/)
    expect(source).not.toMatch(/from ["'].*components\//)
  })
})
