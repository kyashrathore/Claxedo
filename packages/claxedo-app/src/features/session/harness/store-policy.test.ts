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
  test("a scope's transient seed is OpenCode and carries no remembered choice", () => {
    expect(initialHarness()).toBe("opencode")
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
    const server = "http://127.0.0.1:3001"
    expect(harnessChangeRequestKey("key")).toEqual(["shell", "harness-config", "harness-change", "key"])
    expect(harnessHydrateRequestKey(server, "session:ses_1")).toEqual([
      "shell",
      "harness-config",
      "hydrate",
      server,
      "session:ses_1",
    ])
    expect(harnessHydrateSeenKey(server, "session:ses_1")).toEqual([
      "shell",
      "harness-config",
      "hydrate",
      server,
      "session:ses_1",
      "seen",
    ])
    expect(harnessPreparedSessionKey(server, "draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      server,
      "draft:/repo:route",
    ])
    expect(harnessPreparedSessionSeqKey(server, "draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      server,
      "draft:/repo:route",
      "seq",
    ])
    expect(harnessPreparingSessionKey(server, "draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "prepared-session",
      server,
      "draft:/repo:route",
      "prepare",
    ])
    expect(harnessOptionsSeqKey(server, "draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "options",
      server,
      "draft:/repo:route",
      "seq",
    ])
    expect(harnessOptionsTriesKey(server, "draft:/repo:route")).toEqual([
      "shell",
      "harness-config",
      "options",
      server,
      "draft:/repo:route",
      "tries",
    ])
  })

  // The defect the shape fixes: a pane scope is a directory string, so two
  // servers exposing the same worktree named ONE entry for two runtimes.
  test("two servers exposing the same worktree never share a harness-config entry", () => {
    const scope = "draft:/repo:route"
    expect(harnessHydrateRequestKey("http://127.0.0.1:3001", scope))
      .not.toEqual(harnessHydrateRequestKey("https://app.claxedo.test", scope))
    expect(harnessPreparedSessionKey("http://127.0.0.1:3001", scope))
      .not.toEqual(harnessPreparedSessionKey("https://app.claxedo.test", scope))
    expect(harnessOptionsTriesKey("http://127.0.0.1:3001", scope))
      .not.toEqual(harnessOptionsTriesKey("https://app.claxedo.test", scope))
  })

  // The change key and the session-model key carry the full authority — the
  // same tuple `session-capabilities-query.ts` keys on, from the same builder.
  test("the harness-change and session-model keys carry server, workspace and harness", () => {
    const local = { serverUrl: "http://127.0.0.1:3001", directory: "/tmp/project", sessionId: "ses_1" }
    const cloud = { ...local, workspaceId: "ws_1", workspaceKind: "cloud" as const }

    expect(harnessChangeKey(local, "acp:codex")).not.toEqual(harnessChangeKey(cloud, "acp:codex"))
    expect(harnessChangeKey(local, "acp:codex")).not.toEqual(harnessChangeKey(local, "acp:claude"))
    expect(harnessChangeKey(local, "acp:codex")).not.toEqual(harnessChangeKey(local, "acp:codex", "/usr/bin/codex"))
    expect(harnessChangeKey(local, "acp:codex")).toBe(harnessChangeKey(local, "acp:codex"))

    expect(sessionModelSyncKey(local)).toBe(sessionModelSyncKey(local))
    expect(sessionModelSyncKey(local)).not.toBe(sessionModelSyncKey(cloud))
    expect(sessionModelSyncKey({ ...local, serverUrl: "https://app.claxedo.test" })).not.toBe(sessionModelSyncKey(local))
    expect(sessionModelSyncKey({ ...local, sessionId: "new" })).toBeUndefined()
    expect(sessionModelSyncKey({ serverUrl: local.serverUrl, sessionId: "ses_1" })).toBeUndefined()
    expect(sessionModelSyncKey({ serverUrl: local.serverUrl, directory: "/tmp/project" })).toBeUndefined()
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
