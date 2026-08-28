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
        thoughtLevels: [],
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
        thoughtLevels: [],
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
        thoughtLevels: [],
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
        thoughtLevels: [],
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
        thoughtLevels: [],
        dynamicModels: [],
        selectedModel: "",
        configError: "Model options unavailable",
      },
      retry: false,
      clearTries: false,
    })
  })

  test("clears the placeholder model for fresh empty configurable harness options", () => {
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
        thoughtLevels: [],
        dynamicModels: [],
        selectedModel: "",
        configError: "No model options available",
      },
      retry: false,
      clearTries: true,
    })
  })

  test("rejects native SDK static catalog backstops as a model load failure", () => {
    expect(applyHarnessOptionsResponse({
      type: "cursor-sdk",
      selectedModel: "",
      tries: 0,
      payload: {
        source: "catalog",
        stale: true,
        options: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "auto",
          selectOptions: [
            { id: "auto", name: "Auto" },
            { id: "gpt-5.5", name: "GPT-5.5" },
          ],
        }],
      },
    })).toEqual({
      patch: {
        optionsSource: "catalog",
        optionsStale: true,
        optionsLoading: false,
        thoughtLevels: [],
        dynamicModels: [],
        selectedModel: "",
        configError: "Model options unavailable",
      },
      retry: false,
      clearTries: false,
    })
  })

  test("keeps retrying when model options contain no usable next id while stale", () => {
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
        thoughtLevels: [],
        dynamicModels: [{ id: "", name: "Empty" }],
        configError: "Loading model options...",
      },
      retry: true,
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

describe("harness options state — thought level", () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "opus",
    selectOptions: [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }],
  }
  const effortOption = {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select" as const,
    currentValue: "high",
    options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
  }

  test("carries the harness's effort levels alongside its models", () => {
    const result = applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: { source: "harness", stale: false, options: [modelOption, effortOption] },
    })
    expect(result.patch.thoughtLevels).toEqual([
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
    ])
    expect(result.patch.selectedThoughtLevel).toBe("high")
  })

  /**
   * The effort payload must survive the branches that bail on the MODEL result.
   * A harness can legitimately answer with an effort option while its model list
   * is still loading, and dropping it there is how a control that "sometimes
   * disappears" gets built.
   */
  test("keeps effort levels when the model list comes back empty", () => {
    const result = applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: { source: "harness", stale: false, options: [effortOption] },
    })
    expect(result.patch.dynamicModels).toEqual([])
    expect(result.patch.thoughtLevels).toEqual([
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
    ])
  })

  test("clears effort levels for a harness that offers none", () => {
    const result = applyHarnessOptionsResponse({
      type: "claude-acp",
      selectedModel: "sonnet",
      tries: 0,
      payload: { source: "harness", stale: false, options: [modelOption] },
    })
    expect(result.patch.thoughtLevels).toEqual([])
    expect(result.patch.selectedThoughtLevel).toBeUndefined()
  })
})
