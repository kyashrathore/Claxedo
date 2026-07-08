import { describe, expect, test } from "bun:test"
import {
  harnessStatusPatch,
  harnessSwitchStartPatch,
  initialHarnessStoreState,
  readyHarnessFallbackPatch,
  readyHarnessHydrationPatch,
  workspaceDraftHarnessResetPatch,
} from "./store-state"

describe("harness store state projectors", () => {
  test("builds initial state from scoped preferences and legacy fallbacks", () => {
    expect(initialHarnessStoreState({
      scope: "session:ses_1",
      legacyHarness: "claude-acp",
      legacyModel: "sonnet",
      legacyAgent: "build",
    })).toMatchObject({
      harnessMode: "harness",
      harness: "claude-acp",
      selectedModel: "sonnet",
      selectedAgent: "build",
      readiness: "ready",
      optionsSource: "empty",
    })

    expect(initialHarnessStoreState({
      scope: "draft:/repo:route",
      legacyHarness: "claude-acp",
      legacyModel: "sonnet",
    })).toMatchObject({
      harnessMode: "opencode",
      harness: "opencode",
      selectedModel: "",
    })
  })

  test("projects workspace draft reset state without touching persistence", () => {
    expect(workspaceDraftHarnessResetPatch()).toEqual({
      harness: "opencode",
      harnessMode: "opencode",
      selectedModel: "",
      dynamicModels: null,
      readiness: "ready",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    })
  })

  test("projects harness status onto current state", () => {
    expect(harnessStatusPatch({
      current: initialHarnessStoreState({
        scope: "draft:/repo:route",
        savedHarness: "codex-acp",
        savedModel: "gpt-5.5",
      }),
      data: {
        type: "claude-acp",
        activeType: "claude-acp",
        activeBinary: "/bin/claude",
        model: "sonnet",
        workspaceId: "ws_1",
      },
    })).toMatchObject({
      harnessMode: "harness",
      harnessBinary: "/bin/claude",
      harness: "claude-acp",
      selectedModel: "sonnet",
      readiness: "ready",
      configError: undefined,
      workspaceId: "ws_1",
    })

    expect(harnessStatusPatch({
      data: {
        type: "opencode",
        activeType: "opencode",
        error: "runner failed",
      },
    })).toMatchObject({
      harnessMode: "opencode",
      harness: "opencode",
      selectedModel: "",
      dynamicModels: null,
      readiness: "error",
      configError: "runner failed",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
  })

  test("keeps hydration and switch patches aligned with options policy", () => {
    expect(readyHarnessHydrationPatch("claude-acp")).toEqual({
      harnessMode: "harness",
      readiness: "ready",
    })
    expect(readyHarnessHydrationPatch("opencode")).toEqual({
      harnessMode: "opencode",
      readiness: "ready",
      dynamicModels: null,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
    expect(readyHarnessFallbackPatch("claude-acp")).toEqual({
      harnessMode: "harness",
      readiness: "ready",
      dynamicModels: null,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
    expect(harnessSwitchStartPatch({
      type: "claude-acp",
      useLocalHarnessConfig: true,
    })).toMatchObject({
      harness: "claude-acp",
      harnessMode: "harness",
      selectedModel: "default",
      optionsLoading: true,
    })
  })

  test("stays pure and out of runtime/query/UI layers", async () => {
    const source = await Bun.file(new URL("./store-state.ts", import.meta.url)).text()

    expect(source).not.toContain("solid-js")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("localStorage")
  })
})
