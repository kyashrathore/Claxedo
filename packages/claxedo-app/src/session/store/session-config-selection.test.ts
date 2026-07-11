import { describe, expect, test } from "bun:test"
import { shellDataKeys } from "@/shell/data/keys"
import {
  localSelectionStateFromSessionConfig,
  sessionConfigPatchFromLocalSelection,
  sessionConfigRawQueryKey,
  sessionConfigSelectionQueryKey,
  sessionConfigSelectionSyncQueryKey,
  shouldExposeDefaultLocalModelFallback,
} from "./session-config-selection"

describe("session config selection", () => {
  test("uses a root session-scoped query key", () => {
    expect(sessionConfigSelectionQueryKey("ses_1")).toEqual(shellDataKeys.sessionId("ses_1", "config-selection"))
    expect(sessionConfigRawQueryKey("ses_1")).toEqual(shellDataKeys.sessionId("ses_1", "config-raw"))
    expect(sessionConfigSelectionSyncQueryKey("ses_1")).toEqual(shellDataKeys.sessionId("ses_1", "config-selection-sync"))
  })

  test("decodes model, agent, and variant from session config", () => {
    expect(localSelectionStateFromSessionConfig({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      variant: "fast",
    })).toEqual({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      variant: "fast",
    })
  })

  test("keeps a null variant because session config uses it as explicit default", () => {
    expect(localSelectionStateFromSessionConfig({
      agent: "build",
      model: { providerID: "nvidia", modelID: "nemotron" },
      variant: null,
    })).toEqual({
      agent: "build",
      model: { providerID: "nvidia", modelID: "nemotron" },
      variant: null,
    })
  })

  test("ignores malformed model config instead of inventing a fallback", () => {
    expect(localSelectionStateFromSessionConfig({
      agent: "build",
      model: { providerID: "deepseek" },
    })).toEqual({ agent: "build" })
  })

  test("builds an opencode session-config patch from an explicit local selection", () => {
    expect(sessionConfigPatchFromLocalSelection({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })).toEqual({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })
  })

  test("uses null model and variant when clearing explicit opencode selection", () => {
    expect(sessionConfigPatchFromLocalSelection({ agent: "build" })).toEqual({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: null,
      variant: null,
    })
  })

  test("only exposes the default model fallback for uninitialized drafts", () => {
    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: false,
      restoreLoading: false,
    })).toBe(true)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: true,
      hasSelection: false,
      restoreLoading: false,
    })).toBe(false)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: true,
      hasValidSelection: true,
      restoreLoading: false,
    })).toBe(false)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: true,
      hasSelection: true,
      hasValidSelection: false,
      restoreLoading: false,
    })).toBe(true)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: false,
      restoreLoading: true,
    })).toBe(false)
  })
})
