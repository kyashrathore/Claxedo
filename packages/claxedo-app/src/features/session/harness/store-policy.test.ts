import { describe, expect, test } from "bun:test"
import {
  harnessChangeKey,
  harnessChangeRequestKey,
  harnessHydrateRequestKey,
  harnessHydrateSeenKey,
  harnessOptionsSeqKey,
  harnessOptionsTriesKey,
  harnessPreparedSessionKey,
  harnessPreparedSessionSeqKey,
  harnessPreparingSessionKey,
  harnessStateFromSessionConfig,
  initialHarness,
  isDraftScope,
  modelOptionsUnavailableMessage,
  refreshHarnessTypeForScope,
  sessionModelSyncKey,
  shouldFetchConfigOptionsForScope,
  shouldHydrateDraftFromHarnessStatus,
  shouldRefreshDirectoryAfterHarnessStatus,
  shouldRetryModelOptions,
  shouldShowModelOptionsStaleWarning,
  shouldUseLocalHarnessConfigApi,
} from "./store-policy"

describe("harness store policy", () => {
  test("keeps draft defaults isolated from legacy harness settings", () => {
    expect(initialHarness("draft:/tmp/proj:route", undefined, "claude-acp")).toBe("opencode")
    expect(initialHarness("draft:/tmp/proj:route", "codex-acp", "claude-acp")).toBe("codex-acp")
    expect(initialHarness("session:ses_1", undefined, "claude-acp")).toBe("claude-acp")
  })

  test("classifies model-option fetch and retry policy", () => {
    expect(shouldShowModelOptionsStaleWarning({
      stale: true,
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    })).toBe(false)
    expect(shouldShowModelOptionsStaleWarning({ stale: true, models: [] })).toBe(true)
    expect(shouldFetchConfigOptionsForScope("claude-acp", false, { sessionId: "ses_1" })).toBe(false)
    expect(shouldFetchConfigOptionsForScope("claude-acp", false, { sessionId: "new" })).toBe(true)
    expect(shouldFetchConfigOptionsForScope("opencode", false)).toBe(false)
    expect(shouldFetchConfigOptionsForScope("claude-acp", true)).toBe(false)
    expect(shouldRetryModelOptions({ stale: true, tries: 0, limit: 2 })).toBe(true)
    expect(shouldRetryModelOptions({ stale: true, tries: 2, limit: 2 })).toBe(false)
    expect(shouldRetryModelOptions({ stale: false, tries: 0, limit: 2 })).toBe(false)
    expect(modelOptionsUnavailableMessage({ stale: true })).toBe("Model options unavailable")
    expect(modelOptionsUnavailableMessage({ stale: false })).toBe("No model options available")
  })

  test("keeps query ownership keys stable", () => {
    expect(harnessChangeKey("draft:/tmp/project:route", "codex-acp")).toBe("draft:/tmp/project:route\ncodex-acp\n")
    expect(harnessChangeRequestKey("key")).toEqual(["shell", "harness-config", "harness-change", "key"])
    expect(harnessHydrateRequestKey("session:ses_1")).toEqual(["shell", "harness-config", "hydrate", "session:ses_1"])
    expect(harnessHydrateSeenKey("session:ses_1")).toEqual([
      "shell",
      "harness-config",
      "hydrate",
      "session:ses_1",
      "seen",
    ])
    expect(harnessPreparedSessionKey("draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      "draft:/repo:route",
    ])
    expect(harnessPreparedSessionSeqKey("draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      "draft:/repo:route",
      "seq",
    ])
    expect(harnessPreparingSessionKey("draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      "draft:/repo:route",
      "prepare",
    ])
    expect(harnessOptionsSeqKey("draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "options",
      "draft:/repo:route",
      "seq",
    ])
    expect(harnessOptionsTriesKey("draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "options",
      "draft:/repo:route",
      "tries",
    ])
    expect(sessionModelSyncKey("http://127.0.0.1:3001", {
      directory: "/tmp/project",
      sessionId: "ses_1",
    })).toBe("http://127.0.0.1:3001\nses_1")
  })

  test("keeps workspace runtime scope policy stable", () => {
    expect(isDraftScope("draft:/tmp/proj:route")).toBe(true)
    expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project", sessionId: "ses_1" })).toBe(false)
    expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project" })).toBe(true)
    expect(shouldHydrateDraftFromHarnessStatus({
      useLocalHarnessConfig: true,
      workspaceRuntime: true,
      workspaceKind: "local",
    })).toBe(true)
    expect(shouldHydrateDraftFromHarnessStatus({
      useLocalHarnessConfig: true,
      workspaceRuntime: true,
      workspaceKind: "cloud",
    })).toBe(false)
    expect(shouldHydrateDraftFromHarnessStatus({
      useLocalHarnessConfig: false,
      workspaceRuntime: false,
      workspaceKind: "local",
    })).toBe(false)
    expect(shouldHydrateDraftFromHarnessStatus({
      useLocalHarnessConfig: true,
      workspaceRuntime: false,
      workspaceKind: "cloud",
    })).toBe(true)
    expect(refreshHarnessTypeForScope({ directory: "workspace:ws_1", harness: "opencode" })).toBe("opencode")
    expect(refreshHarnessTypeForScope({ directory: "/tmp/project", harness: "opencode" })).toBeUndefined()
    expect(refreshHarnessTypeForScope({ directory: "/tmp/project", harness: "claude-acp" })).toBe("claude-acp")
  })

  test("hydrates harness state from session config", () => {
    expect(harnessStateFromSessionConfig({
      harness: { type: "codex-acp", binary: "/tmp/codex-acp" },
      model: { modelID: "gpt-5.5" },
    })).toEqual({
      type: "codex-acp",
      binary: "/tmp/codex-acp",
      model: "gpt-5.5",
      status: "ready",
      ready: true,
      activeType: "codex-acp",
      activeBinary: "/tmp/codex-acp",
    })
  })

  test("keeps local harness config access scoped to loopback filesystem directories", () => {
    expect(shouldUseLocalHarnessConfigApi({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/project",
    })).toBe(true)
    expect(shouldUseLocalHarnessConfigApi({
      baseUrl: "https://claxedo.example.test",
      directory: "/tmp/project",
    })).toBe(false)
    expect(shouldUseLocalHarnessConfigApi({
      baseUrl: "http://127.0.0.1:3001",
      directory: "workspace:ws_1",
    })).toBe(false)
    expect(shouldUseLocalHarnessConfigApi({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_1",
      workspaceKind: "user-hosted",
    })).toBe(false)
  })

  test("stays out of Solid state, query ownership, SDK, and localStorage", async () => {
    const source = await Bun.file(new URL("./store-policy.ts", import.meta.url)).text()

    expect(source).not.toContain("solid-js")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("localStorage")
  })
})
