import { describe, expect, test } from "bun:test"
import { applyHarnessOptionsResponse } from "./options-state"

describe("harness options state", () => {
  test("uses returned selectable models and current model", () => {
    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: {
        source: "harness",
        stale: false,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "opus",
            selectOptions: [
              { id: "sonnet", name: "Sonnet" },
              { id: "opus", name: "Opus" },
            ],
          },
        ],
      },
    })).toEqual({
      patch: {
        optionsSource: "harness",
        optionsStale: false,
        optionsLoading: false,
        dynamicModels: [
          { id: "sonnet", name: "Sonnet" },
          { id: "opus", name: "Opus" },
        ],
        selectedModel: "sonnet",
        configError: undefined,
      },
      saveModel: "sonnet",
      retry: false,
      clearTries: true,
    })
  })

  test("uses payload current model when selected model is absent", () => {
    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "missing",
      tries: 0,
      payload: {
        source: "harness",
        stale: false,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "opus",
            selectOptions: [{ id: "opus", name: "Opus" }],
          },
        ],
      },
    }).patch.selectedModel).toBe("opus")
  })

  test("does not substitute a protected explicit model removed from live options", () => {
    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "removed",
      preserveSelectedModel: true,
      tries: 0,
      payload: {
        source: "harness",
        stale: false,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          selectOptions: [{ id: "sonnet", name: "Sonnet" }],
        }],
      },
    })).toEqual({
      patch: {
        optionsSource: "harness",
        optionsStale: false,
        optionsLoading: false,
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
        selectedModel: "removed",
        configError: "Selected model unavailable",
      },
      retry: false,
      clearTries: true,
    })
  })

  test("keeps stale usable models loading for bounded retry without warning dot", () => {
    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: {
        source: "catalog",
        stale: true,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "sonnet",
            selectOptions: [{ id: "sonnet", name: "Sonnet" }],
          },
        ],
      },
    })).toEqual({
      patch: {
        optionsSource: "catalog",
        optionsStale: false,
        optionsLoading: true,
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
        selectedModel: "sonnet",
        configError: undefined,
      },
      saveModel: "sonnet",
      retry: true,
      clearTries: false,
    })
  })

  test("reports stale empty options until retry budget is exhausted", () => {
    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: { source: "empty", stale: true, options: [] },
    })).toEqual({
      patch: {
        optionsSource: "empty",
        optionsStale: true,
        optionsLoading: true,
        dynamicModels: [],
        configError: "Loading model options...",
      },
      retry: true,
      clearTries: false,
    })

    expect(applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 5,
      payload: { source: "empty", stale: true, options: [] },
    })).toEqual({
      patch: {
        optionsSource: "empty",
        optionsStale: true,
        optionsLoading: false,
        dynamicModels: [],
        configError: "Model options unavailable",
      },
      retry: false,
      clearTries: false,
    })
  })

  test("uses fallback model for fresh empty configurable harness options", () => {
    expect(applyHarnessOptionsResponse({
      type: "codex-acp",
      selectedModel: "",
      tries: 0,
      payload: { source: "harness", stale: false, options: [] },
    })).toEqual({
      patch: {
        optionsSource: "harness",
        optionsStale: false,
        optionsLoading: false,
        dynamicModels: [],
        selectedModel: "default",
        configError: "No model options available",
      },
      saveModel: "default",
      retry: false,
      clearTries: true,
    })
  })

  test("falls back without retry when model options contain no usable next id", () => {
    expect(applyHarnessOptionsResponse({
      type: "codex-acp",
      selectedModel: "",
      tries: 0,
      payload: {
        source: "harness",
        stale: true,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "",
            selectOptions: [{ id: "", name: "Empty" }],
          },
        ],
      },
    })).toEqual({
      patch: {
        optionsSource: "harness",
        optionsStale: true,
        optionsLoading: true,
        dynamicModels: [{ id: "", name: "Empty" }],
        selectedModel: "default",
        configError: "Loading model options...",
      },
      saveModel: "default",
      retry: false,
      clearTries: false,
    })
  })

  test("stays pure and out of runtime/query/UI layers", async () => {
    const source = await Bun.file(new URL("./options-state.ts", import.meta.url)).text()

    expect(source).not.toContain("solid-js")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("localStorage")
  })
})
