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
  harnessScope,
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


  test("classifies model-option fetch and retry policy", () => {
    expect(
      shouldShowModelOptionsStaleWarning({
        stale: true,
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      }),
    ).toBe(false)
    expect(shouldShowModelOptionsStaleWarning({ stale: true, models: [] })).toBe(true)
    expect(
      shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, false, {
        sessionId: "ses_1",
      }),
    ).toBe(true)
    expect(
      shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, false, { sessionId: "new" }),
    ).toBe(true)
    expect(shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "opencode" }, false)).toBe(true)
    expect(shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, true)).toBe(false)
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
    expect(harnessHydrateRequestKey("http://127.0.0.1:3001", scope)).not.toEqual(
      harnessHydrateRequestKey("https://app.claxedo.test", scope),
    )
    expect(harnessPreparedSessionKey("http://127.0.0.1:3001", scope)).not.toEqual(
      harnessPreparedSessionKey("https://app.claxedo.test", scope),
    )
    expect(harnessOptionsTriesKey("http://127.0.0.1:3001", scope)).not.toEqual(
      harnessOptionsTriesKey("https://app.claxedo.test", scope),
    )
  })

  // The change key and the session-model key carry the full authority — the
  // same tuple `session-capabilities-query.ts` keys on, from the same builder.
  test("the harness-change and session-model keys carry server, workspace and harness", () => {
    const local = { serverUrl: "http://127.0.0.1:3001", directory: "/tmp/project", sessionId: "ses_1" }
    const cloud = { ...local, workspaceId: "ws_1", hostKind: "provisioner" as const }

    expect(harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" })).not.toEqual(
      harnessChangeKey(cloud, { kind: "connection", connectionId: "acp:codex" }),
    )
    expect(harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" })).not.toEqual(
      harnessChangeKey(local, { kind: "connection", connectionId: "acp:claude" }),
    )
    expect(harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" })).not.toEqual(
      harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" }, "/usr/bin/codex"),
    )
    expect(harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" })).toBe(
      harnessChangeKey(local, { kind: "connection", connectionId: "acp:codex" }),
    )

    expect(sessionModelSyncKey(local)).not.toBe(sessionModelSyncKey({ ...local, directory: "/other" }))
    expect(sessionModelSyncKey(local)).not.toBe(sessionModelSyncKey(cloud))
    expect(sessionModelSyncKey({ ...local, serverUrl: "https://app.claxedo.test" })).not.toBe(
      sessionModelSyncKey(local),
    )
    expect(sessionModelSyncKey({ ...local, sessionId: "new" })).toBeUndefined()
    expect(sessionModelSyncKey({ serverUrl: local.serverUrl, sessionId: "ses_1" })).toBeUndefined()
    expect(sessionModelSyncKey({ serverUrl: local.serverUrl, directory: "/tmp/project" })).toBeUndefined()
  })

  test("keeps workspace runtime scope policy stable", () => {
    expect(isDraftScope("draft:/tmp/proj:route")).toBe(true)
    expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project", sessionId: "ses_1" })).toBe(false)
    expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project" })).toBe(true)
    expect(
      shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceRuntime: true,
        hostKind: "self",
      }),
    ).toBe(true)
    expect(
      shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceRuntime: true,
        hostKind: "provisioner",
      }),
    ).toBe(false)
    expect(
      shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: false,
        workspaceRuntime: false,
        hostKind: "self",
      }),
    ).toBe(false)
    expect(
      shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceRuntime: false,
        hostKind: "provisioner",
      }),
    ).toBe(true)
    // A user-hosted workspace is a machine's workspace: its draft starts from
    // that machine's harness, even though its config API is never loopback.
    expect(
      shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: false,
        workspaceRuntime: true,
        hostKind: "machine",
      }),
    ).toBe(true)
    expect(
      refreshHarnessTypeForScope({
        directory: "workspace:ws_1",
        harness: { kind: "connection", connectionId: "opencode" },
      }),
    ).toBeUndefined()
    expect(
      refreshHarnessTypeForScope({
        directory: "/tmp/project",
        harness: { kind: "connection", connectionId: "opencode" },
      }),
    ).toBeUndefined()
    expect(
      refreshHarnessTypeForScope({ directory: "/tmp/project", harness: { kind: "native", harnessId: "claude" } }),
    ).toBe("claude")
  })

  test("isolates native and connection change requests even when their IDs collide", () => {
    const authority = { serverUrl: "https://control.example", directory: "/repo", sessionId: "ses_1" }
    const native = { kind: "native", harnessId: "codex" } as const
    const connection = { kind: "connection", connectionId: "codex" } as const
    expect(harnessChangeKey(authority, native)).not.toBe(harnessChangeKey(authority, connection))
    expect(harnessChangeKey(authority, connection)).toBe(harnessChangeKey(authority, { ...connection }))
  })

  test("hydrates harness state from session config", () => {
    expect(
      harnessStateFromSessionConfig({
        harness: { type: { kind: "connection", connectionId: "acp:codex" } },
        model: { providerID: "backend-provider", modelID: "gpt-5.5" },
      }),
    ).toEqual({
      type: { kind: "connection", connectionId: "acp:codex" },
      model: "gpt-5.5",
      modelProviderID: "backend-provider",
      status: "ready",
      ready: true,
      activeType: { kind: "connection", connectionId: "acp:codex" },
    })
  })

  test("keeps local harness config access scoped to loopback filesystem directories", () => {
    expect(
      shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "/tmp/project",
      }),
    ).toBe(true)
    expect(shouldUseLocalHarnessConfigApi({ baseUrl: "https://localhost:3001", directory: "/tmp/project" })).toBe(true)
    expect(shouldUseLocalHarnessConfigApi({ baseUrl: "ftp://127.0.0.1:3001", directory: "/tmp/project" })).toBe(false)
    expect(
      shouldUseLocalHarnessConfigApi({
        baseUrl: "https://claxedo.example.test",
        directory: "/tmp/project",
      }),
    ).toBe(false)
    expect(
      shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "workspace:ws_1",
      }),
    ).toBe(false)
    expect(
      shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "/repo/.claxedo/user-hosted/workspaces/ws_1",
        hostKind: "machine",
      }),
    ).toBe(false)
  })

  test("resolves the workspace runtime ref for a signed user-hosted directory only when the inventory is passed in", () => {
    const projects = [
      {
        worktree: "/repo",
        workspaces: {
          ws_uh1: {
            id: "ws_uh1",
            workspaceId: "ws_uh1",
            kind: "user-hosted" as const,
            directory: "/repo/user-hosted/ws_uh1-dir",
          },
        },
      },
    ]

    // Without the signed inventory, a plain filesystem-path directory can't be
    // told apart from an ordinary local one — the ref stays unresolved.
    expect(harnessWorkspaceRuntimeRef({ directory: "/repo/user-hosted/ws_uh1-dir" })).toBeUndefined()

    // Threading the inventory through lets the directory match the signed
    // user-hosted workspace and resolve to its real workspaceId.
    expect(harnessWorkspaceRuntimeRef({ directory: "/repo/user-hosted/ws_uh1-dir" }, projects)).toEqual({
      workspaceId: "ws_uh1",
      kind: "machine",
    })
  })


})

  describe("harnessScope", () => {
    test("session scope: sessionId", () => {
      const scope = harnessScope({ directory: "/tmp/proj", sessionId: "ses_abc" })
      expect(scope).toBe("session:ses_abc")
    })

    test("draft scope: directory + surfaceId (no session)", () => {
      const scope = harnessScope({ directory: "/tmp/proj", surfaceId: "tab_1" })
      expect(scope).toBe("draft:/tmp/proj:tab_1")
    })

    test("new session treated as draft", () => {
      const scope = harnessScope({ directory: "/tmp/proj", sessionId: "new", surfaceId: "tab_2" })
      expect(scope).toBe("draft:/tmp/proj:tab_2")
    })

    test("draftId takes precedence for draft scopes", () => {
      const scope = harnessScope({ directory: "/tmp/proj", sessionId: "new", surfaceId: "tab_2", draftId: "draft_2" })
      expect(scope).toBe("draft:draft_2")
    })

    test("missing directory still produces valid scope", () => {
      const scope = harnessScope({ sessionId: "ses_123" })
      expect(scope).toBe("session:ses_123")
    })

    test("missing surfaceId defaults to 'route'", () => {
      const scope = harnessScope({ directory: "/tmp/proj" })
      expect(scope).toBe("draft:/tmp/proj:route")
    })

    test("same session keeps one scope across directories", () => {
      const a = harnessScope({ directory: "/a", sessionId: "s1" })
      const b = harnessScope({ directory: "/b", sessionId: "s1" })
      expect(a).toBe(b)
    })

    test("same directory but different sessions produce different scopes", () => {
      const a = harnessScope({ directory: "/tmp", sessionId: "s1" })
      const b = harnessScope({ directory: "/tmp", sessionId: "s2" })
      expect(a).not.toBe(b)
    })
  })
