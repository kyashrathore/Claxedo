import { describe, expect, test } from "bun:test"
import {
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessMode,
  harnessReadyForSubmit,
  type HarnessSelectionState,
} from "./selection"

const base = {
  harnessBinary: "",
  selectedModel: "",
  dynamicModels: null,
  readiness: "ready",
  optionsLoading: false,
} satisfies Omit<HarnessSelectionState, "harness">

describe("harness selection", () => {
  test("resolves display names from harness ids and binaries", () => {
    expect(harnessDisplayName({ harness: "codex-acp", harnessBinary: "" })).toBe("Codex")
    expect(harnessDisplayName({ harness: "claude-acp", harnessBinary: "/tmp/claude-agent-acp" })).toBe("Claude")
    expect(harnessDisplayName({ harness: "opencode", harnessBinary: "custom-binary" })).toBe("custom-binary")
  })

  test("classifies harness mode from harness type", () => {
    expect(harnessMode("opencode")).toBe("opencode")
    expect(harnessMode("codex-acp")).toBe("harness")
    expect(harnessMode()).toBe("unknown")
  })

  test("keeps selected model visible when options refresh without that row", () => {
    expect(harnessModels({
      ...base,
      harness: "claude-acp",
      selectedModel: "opus",
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
    })).toEqual([
      { id: "opus", name: "opus" },
      { id: "sonnet", name: "Sonnet" },
    ])
  })

  test("requires a concrete provider/model selection for Pi", () => {
    const state = { ...base, harness: "pi" } satisfies HarnessSelectionState

    expect(harnessModelKeyForSubmit(state)).toBeUndefined()
    expect(harnessModelNameForSubmit(state)).toBeUndefined()
    expect(harnessReadyForSubmit(state)).toBe(false)
  })

  test("preserves Pi's backend provider ID independently of the harness ID", () => {
    const state = {
      ...base,
      harness: "pi",
      selectedModel: "claude-sonnet-4-5",
      selectedModelProvider: "anthropic",
      dynamicModels: [{ id: "claude-sonnet-4-5", name: "Sonnet 4.5", providerID: "anthropic" }],
    } satisfies HarnessSelectionState

    expect(harnessModelKeyForSubmit(state)).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    expect(harnessModelNameForSubmit(state)).toBe("Sonnet 4.5")
    expect(harnessReadyForSubmit(state)).toBe(true)
  })

  test("does not submit a Pi model ID without its provider identity", () => {
    expect(harnessModelKeyForSubmit({
      ...base,
      harness: "pi",
      selectedModel: "claude-sonnet-4-5",
      dynamicModels: [{ id: "claude-sonnet-4-5", name: "Sonnet 4.5" }],
    })).toBeUndefined()
  })

  test("allows the default harness model when no dynamic options have arrived", () => {
    expect(harnessModelKeyForSubmit({
      ...base,
      harness: "claude-acp",
      selectedModel: "",
      dynamicModels: [],
    })).toEqual({ providerID: "claude-acp", modelID: "default" })
  })

  test("blocks submit while model options are loading or errored", () => {
    expect(harnessReadyForSubmit({
      ...base,
      harness: "claude-acp",
      selectedModel: "sonnet",
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      optionsLoading: true,
    })).toBe(false)
    expect(harnessReadyForSubmit({
      ...base,
      harness: "claude-acp",
      selectedModel: "sonnet",
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      readiness: "error",
    })).toBe(false)
    expect(harnessReadyForSubmit({
      ...base,
      harness: "claude-acp",
      selectedModel: "sonnet",
      dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      configError: "Authentication required. Please run 'agent login' first.",
    })).toBe(false)
    expect(harnessReadyForSubmit({
      ...base,
      harness: "codex-app-server",
      selectedModel: "gpt-5.5",
      dynamicModels: [],
      readiness: "error",
    })).toBe(false)
    // A degraded harness (process lost / recovering) blocks Send (T4) even with a
    // valid model, so the composer health peek can name the condition first.
    expect(harnessReadyForSubmit({
      ...base,
      harness: "codex-app-server",
      selectedModel: "gpt-5.5",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      readiness: "degraded",
    })).toBe(false)
    // OpenCode short-circuits to ready even if a degraded readiness leaks in.
    expect(harnessReadyForSubmit({
      ...base,
      harness: "opencode",
      readiness: "degraded",
    })).toBe(true)
  })

  test("returns canonical ModelKey for selectable harness models", () => {
    const state = {
      ...base,
      harness: "codex-acp",
      selectedModel: "gpt-5.5",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    } satisfies HarnessSelectionState

    expect(harnessModelKeyForSubmit(state)).toEqual({ providerID: "codex-acp", modelID: "gpt-5.5" })
    expect(harnessModelNameForSubmit(state)).toBe("GPT-5.5")
    expect(harnessReadyForSubmit(state)).toBe(true)
  })
})
