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
  harnessWorkspaceRuntimeRef,
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
    expect(initialHarness("draft:/tmp/proj:route", undefined, "claude-sdk")).toBe("opencode")
    expect(initialHarness("draft:/tmp/proj:route", "acp:codex", "claude-sdk")).toBe("acp:codex")
    expect(initialHarness("session:ses_1", undefined, "claude-sdk")).toBe("claude-sdk")
  })

  test("classifies model-option fetch and retry policy", () => {
    expect(shouldShowModelOptionsStaleWarning({
      stale: true,
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    })).toBe(false)
    expect(shouldShowModelOptionsStaleWarning({ stale: true, models: [] })).toBe(true)
    expect(shouldFetchConfigOptionsForScope("acp:claude", false, { sessionId: "ses_1" })).toBe(true)
    expect(shouldFetchConfigOptionsForScope("acp:claude", false, { sessionId: "new" })).toBe(true)
    expect(shouldFetchConfigOptionsForScope("opencode", false)).toBe(false)
    expect(shouldFetchConfigOptionsForScope("acp:claude", true)).toBe(false)
    expect(shouldRetryModelOptions({ stale: true, tries: 0, limit: 2 })).toBe(true)
    expect(shouldRetryModelOptions({ stale: true, tries: 2, limit: 2 })).toBe(false)
    expect(shouldRetryModelOptions({ stale: false, tries: 0, limit: 2 })).toBe(false)
    expect(modelOptionsUnavailableMessage({ stale: true })).toBe("Model options unavailable")
    expect(modelOptionsUnavailableMessage({ stale: false })).toBe("No model options available")
  })

  test("keeps query ownership keys stable", () => {
    expect(harnessChangeKey("draft:/tmp/project:route", "acp:codex")).toBe("draft:/tmp/project:route\nacp:codex\n")
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
    // A user-hosted workspace is a machine's workspace: its draft starts from
    // that machine's harness, even though its config API is never loopback.
    expect(shouldHydrateDraftFromHarnessStatus({
      useLocalHarnessConfig: false,
      workspaceRuntime: true,
      workspaceKind: "user-hosted",
    })).toBe(true)
    expect(refreshHarnessTypeForScope({ directory: "workspace:ws_1", harness: "opencode" })).toBe("opencode")
    expect(refreshHarnessTypeForScope({ directory: "/tmp/project", harness: "opencode" })).toBeUndefined()
    expect(refreshHarnessTypeForScope({ directory: "/tmp/project", harness: "acp:claude" })).toBe("acp:claude")
  })

  test("hydrates harness state from session config", () => {
    expect(harnessStateFromSessionConfig({
      harness: { type: "acp:codex", binary: "/tmp/codex-acp" },
      model: { modelID: "gpt-5.5" },
    })).toEqual({
      type: "acp:codex",
      binary: "/tmp/codex-acp",
      model: "gpt-5.5",
      status: "ready",
      ready: true,
      activeType: "acp:codex",
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

  test("resolves the workspace runtime ref for a signed user-hosted directory only when the inventory is passed in", () => {
    const projects = [{
      worktree: "/repo",
      workspaces: {
        ws_uh1: {
          id: "ws_uh1",
          workspaceId: "ws_uh1",
          kind: "user-hosted" as const,
          directory: "/repo/user-hosted/ws_uh1-dir",
        },
      },
    }]

    // Without the signed inventory, a plain filesystem-path directory can't be
    // told apart from an ordinary local one — the ref stays unresolved.
    expect(harnessWorkspaceRuntimeRef({ directory: "/repo/user-hosted/ws_uh1-dir" })).toBeUndefined()

    // Threading the inventory through lets the directory match the signed
    // user-hosted workspace and resolve to its real workspaceId.
    expect(harnessWorkspaceRuntimeRef({ directory: "/repo/user-hosted/ws_uh1-dir" }, projects)).toEqual({
      workspaceId: "ws_uh1",
      kind: "user-hosted",
    })
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
