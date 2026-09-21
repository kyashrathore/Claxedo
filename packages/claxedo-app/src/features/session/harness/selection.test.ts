import { describe, expect, test } from "bun:test"
import {
  connectionAllowsNoModel,
  draftConnectionAllowsNoModel,
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessMode,
  harnessReadyForSubmit,
  type HarnessSelectionState,
} from "./selection"

const base = {
  selectedModel: "",
  dynamicModels: null,
  readiness: "ready",
  optionsLoading: false,
} satisfies Omit<HarnessSelectionState, "harness">

describe("harness selection", () => {
  test("resolves display names from structured identities, not binaries", () => {
    expect(harnessDisplayName({ harness: { kind: "native", harnessId: "codex" } })).toBe("Codex")
    expect(harnessDisplayName({ harness: { kind: "native", harnessId: "claude" } })).toBe("Claude Code")
    expect(harnessDisplayName({ harness: { kind: "connection", connectionId: "team-agent" } })).toBe("Team Agent")
    expect(harnessDisplayName({})).toBe("Select agent")
  })

  test("classifies harness mode from harness type", () => {
    expect(harnessMode({ kind: "connection", connectionId: "opencode" })).toBe("harness")
    expect(harnessMode({ kind: "connection", connectionId: "acp:codex" })).toBe("harness")
    expect(harnessMode()).toBe("unknown")
  })

  test("keeps selected model visible when options refresh without that row", () => {
    expect(
      harnessModels({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "opus",
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
      }),
    ).toEqual([
      { id: "opus", name: "opus" },
      { id: "sonnet", name: "Sonnet" },
    ])
  })

  test("requires a concrete provider/model selection for Pi", () => {
    const state = { ...base, harness: { kind: "native", harnessId: "pi" } } satisfies HarnessSelectionState

    expect(harnessModelKeyForSubmit(state)).toBeUndefined()
    expect(harnessModelNameForSubmit(state)).toBeUndefined()
    expect(harnessReadyForSubmit(state)).toBe(false)
  })

  test("submits the Pi runtime's provider-qualified model ID", () => {
    const state = { ...base, harness: { kind: "native", harnessId: "pi" } as const,
      selectedModel: "anthropic/claude-sonnet-4-5",
      dynamicModels: [{ id: "anthropic/claude-sonnet-4-5", name: "Sonnet 4.5" }],
    }
    expect(harnessModelKeyForSubmit(state)).toEqual({ providerID: "pi", modelID: "anthropic/claude-sonnet-4-5" })
    expect(harnessModelNameForSubmit(state)).toBe("Sonnet 4.5")
  })

  test("does not submit Pi's unselected native placeholder", () => {
    expect(harnessModelKeyForSubmit({ ...base, harness: { kind: "native", harnessId: "pi" }, selectedModel: "default" })).toBeUndefined()
  })

  test("blocks submit until live model options arrive", () => {
    expect(
      harnessModelKeyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "",
        dynamicModels: [],
      }),
    ).toBeUndefined()
  })

  test("does not fabricate a submit model from an undeclared ACP default", () => {
    const state = {
      ...base,
      harness: { kind: "connection", connectionId: "openclaw" },
      selectedModel: "default",
      dynamicModels: [],
      selectedThoughtLevel: "adaptive",
    } satisfies HarnessSelectionState

    expect(harnessModels(state)).toEqual([])
    expect(harnessModelKeyForSubmit(state)).toBeUndefined()
    expect(harnessReadyForSubmit(state)).toBe(false)
  })

  test("does not fabricate a default row after option discovery fails", () => {
    expect(
      harnessModels({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "",
        dynamicModels: [],
        configError: "Authentication required. Please run 'agent login' first.",
      }),
    ).toEqual([])
    expect(
      harnessModels({
        ...base,
        harness: { kind: "native", harnessId: "cursor" },
        selectedModel: "default",
        dynamicModels: [],
        configError: "Cursor SDK requires an explicit cursor-sdk API key.",
      }),
    ).toEqual([])
    expect(
      harnessModelKeyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "",
        dynamicModels: [],
        configError: "Authentication required. Please run 'agent login' first.",
      }),
    ).toBeUndefined()
    expect(
      harnessModelKeyForSubmit({
        ...base,
        harness: { kind: "native", harnessId: "cursor" },
        selectedModel: "default",
        dynamicModels: [{ id: "default", name: "Default (recommended)" }],
      }),
    ).toEqual({ providerID: "cursor", modelID: "default" })
  })

  test("blocks submit while model options are loading or errored", () => {
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "sonnet",
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
        optionsLoading: true,
      }),
    ).toBe(false)
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "sonnet",
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
        readiness: "error",
      }),
    ).toBe(false)
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "acp:claude" },
        selectedModel: "sonnet",
        dynamicModels: [{ id: "sonnet", name: "Sonnet" }],
        configError: "Authentication required. Please run 'agent login' first.",
      }),
    ).toBe(false)
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "native", harnessId: "codex" },
        selectedModel: "gpt-5.5",
        dynamicModels: [],
        readiness: "error",
      }),
    ).toBe(false)
    // A degraded harness (process lost / recovering) blocks Send even with a
    // valid model, so the composer health peek can name the condition first.
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "native", harnessId: "codex" },
        selectedModel: "gpt-5.5",
        dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        readiness: "degraded",
      }),
    ).toBe(false)
    // Connections do not bypass health gating.
    expect(
      harnessReadyForSubmit({
        ...base,
        harness: { kind: "connection", connectionId: "external-opencode" },
        readiness: "degraded",
      }),
    ).toBe(false)
  })

  test("returns canonical ModelKey for selectable harness models", () => {
    const state = {
      ...base,
      harness: { kind: "connection", connectionId: "acp:codex" },
      selectedModel: "gpt-5.5",
      dynamicModels: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    } satisfies HarnessSelectionState

    expect(harnessModelKeyForSubmit(state)).toEqual({ providerID: "acp:codex", modelID: "gpt-5.5" })
    expect(harnessModelNameForSubmit(state)).toBe("GPT-5.5")
    expect(harnessReadyForSubmit(state)).toBe(true)
  })
})

describe("harnessModelKeyForSubmit — thought level", () => {
  const base = {
    harness: { kind: "connection", connectionId: "acp:claude" },
    selectedModel: "opus",
    readiness: "ready" as const,
    optionsLoading: false,
    dynamicModels: [{ id: "opus", name: "Opus" }],
  } satisfies HarnessSelectionState

  test("carries the selected level as the model key's variant", () => {
    expect(harnessModelKeyForSubmit({ ...base, selectedThoughtLevel: "high" })).toEqual({
      providerID: "acp:claude",
      modelID: "opus",
      variant: "high",
    })
  })

  test("omits variant entirely when no level is selected", () => {
    expect(harnessModelKeyForSubmit(base)).toEqual({
      providerID: "acp:claude",
      modelID: "opus",
    })
  })
})


test("an explicitly disconnected native model cannot become a submit key", () => {
  const state: HarnessSelectionState = {
    ...base, harness: { kind: "native", harnessId: "pi" },
    selectedModel: "openai/gpt", dynamicModels: [{ id: "openai/gpt", name: "GPT", connected: false }],
  }
  expect(harnessModelKeyForSubmit(state)).toBeUndefined()
  expect(harnessReadyForSubmit(state)).toBe(false)
  expect(harnessModelKeyForSubmit({ ...state, dynamicModels: [{ id: "openai/gpt", name: "GPT", connected: true }] })).toEqual({ providerID: "pi", modelID: "openai/gpt" })
})

test("only declared optional or unsupported ACP drafts bypass failed discovery without a synthetic model", () => {
  const state: HarnessSelectionState = { ...base, harness: { kind: "connection", connectionId: "remote" }, selectedModel: "default", readiness: "error", configError: "Discovery initialization needs user input", connectionDeclaration: {
    connectionId: "remote", label: "Remote", enabled: true, readiness: "configured", modelSelection: { status: "unsupported" },
    capabilities: { abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false },
  } }
  expect(draftConnectionAllowsNoModel("draft:one", state)).toBe(true)
  expect(draftConnectionAllowsNoModel("session:existing", state)).toBe(false)
  expect(harnessModelKeyForSubmit(state)).toBeUndefined()
  expect(harnessReadyForSubmit(state)).toBe(false)
  expect(connectionAllowsNoModel({ ...state, connectionDeclaration: { ...state.connectionDeclaration!, enabled: false } })).toBe(false)
  expect(connectionAllowsNoModel({ ...state, connectionDeclaration: { ...state.connectionDeclaration!, modelSelection: { status: "required" } } })).toBe(false)
  const optional = { ...state, connectionDeclaration: { ...state.connectionDeclaration!, modelSelection: { status: "optional" as const } } }
  expect(connectionAllowsNoModel(optional)).toBe(true)
  expect(connectionAllowsNoModel({ ...optional, selectedModel: "explicit-unavailable" })).toBe(false)
  expect(connectionAllowsNoModel({ ...state, harness: { kind: "native", harnessId: "codex" } })).toBe(false)
})
