import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  HARNESS_DISPLAY_NAMES,
  activeHarness,
  DEFAULT_HARNESS_MODEL,
  desiredHarness,
  effectiveHarnessModel,
  extractModelsFromConfigOptions,
  failedHarness,
  pickHarness,
} from "./profile"
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
  harnessScope,
  harnessStateFromSessionConfig,
  initialHarness,
  isDraftScope,
  modelOptionsUnavailableMessage,
  refreshHarnessTypeForScope,
  sessionModelSyncKey,
  sessionModelSyncRequestKey,
  sessionModelSyncStateKey,
  shouldFetchConfigOptionsForScope,
  shouldHydrateDraftFromHarnessStatus,
  shouldRefreshDirectoryAfterHarnessStatus,
  shouldRetryModelOptions,
  shouldShowModelOptionsStaleWarning,
  shouldUseLocalHarnessConfigApi,
} from "./store-policy"
import { syncHarnessSessionModel } from "./harness-query-cache"
import { createHarnessConfigStore } from "./harness-config-store"
import { connectionHarness, nativeHarness } from "@/platform/identity/harness-selection"

const codex = nativeHarness("codex")
const pi = nativeHarness("pi")
const externalOpenCode = connectionHarness("external-opencode")

afterEach(() => {
  queryClient.clear()
})

describe("harness config helpers", () => {
  describe("composition root", () => {
    test("exposes the composed store factory and shared helpers as callable exports", () => {
      // Smoke-check that the store facade and the helpers it composes are
      // reachable through their real modules (the legacy harness-config barrel
      // was deleted; these imports would fail to resolve if it were needed).
      expect(typeof createHarnessConfigStore).toBe("function")
      expect(typeof syncHarnessSessionModel).toBe("function")
      expect(typeof pickHarness).toBe("function")
      expect(typeof harnessScope).toBe("function")
      expect(HARNESS_DISPLAY_NAMES.pi).toBe("Pi")
    })
  })

  // ── desiredHarness / activeHarness ─────────────────────────────────────

  describe("desiredHarness vs activeHarness during switch", () => {
    test("separates desired from active while a switch is in flight", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:codex" },
        binary: "/tmp/codex-acp",
        activeType: { kind: "connection", connectionId: "acp:claude" },
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toEqual({ kind: "connection", connectionId: "acp:codex" })
      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
    })

    test("desired and active match when no switch is happening", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:claude" },
        binary: "/tmp/claude-agent-acp",
        activeType: { kind: "connection", connectionId: "acp:claude" },
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:claude" })
    })

    test("activeHarness falls back to type when activeType is missing", () => {
      const data = {
        type: { kind: "connection", connectionId: "acp:codex" },
        binary: "/tmp/codex-acp",
      } as const

      expect(activeHarness(data)).toEqual({ kind: "connection", connectionId: "acp:codex" })
    })
  })

  describe("session config runner state", () => {
    test("uses persisted session runner instead of falling back to workspace default", () => {
      expect(
        harnessStateFromSessionConfig({
          harness: { type: { kind: "connection", connectionId: "acp:codex" } },
          model: { providerID: "remote-provider", modelID: "gpt-5.5" },
        }),
      ).toEqual({
        type: { kind: "connection", connectionId: "acp:codex" },
        model: "gpt-5.5",
        modelProviderID: "remote-provider",
        status: "ready",
        ready: true,
        activeType: { kind: "connection", connectionId: "acp:codex" },
      })
    })
  })

  describe("session model sync", () => {
    test("keys existing sessions by the authority that answers for them", () => {
      const server = "http://127.0.0.1:3001"
      expect(sessionModelSyncKey({ serverUrl: server, directory: "/repo/a", sessionId: "ses_1" })).not.toBe(
        sessionModelSyncKey({ serverUrl: server, directory: "/repo/b", sessionId: "ses_1" }),
      )
      expect(sessionModelSyncKey({ serverUrl: server, directory: "/repo/a", sessionId: "ses_1" })).not.toBe(
        sessionModelSyncKey({
          serverUrl: server,
          directory: "/repo/a",
          sessionId: "ses_1",
          workspaceId: "ws_1",
          workspaceKind: "cloud",
        }),
      )
      expect(sessionModelSyncKey({ serverUrl: server, directory: "/repo/a", sessionId: "new" })).toBeUndefined()
    })

    test("dedupes an in-flight model write through Query", async () => {
      let calls = 0
      let release: (res: Response) => void
      const request = () => {
        calls += 1
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }

      const first = syncHarnessSessionModel({ key: "server\nses_1", model: "sonnet", request })
      const second = syncHarnessSessionModel({ key: "server\nses_1", model: "sonnet", request })

      expect(second).toBe(first)
      expect(calls).toBe(1)
      expect(queryClient.getQueryData(sessionModelSyncStateKey("server\nses_1"))).toEqual({
        desired: "sonnet",
      })
      expect(queryClient.getQueryData(sessionModelSyncRequestKey("server\nses_1", "sonnet"))).toBe(first)

      release!(new Response(null, { status: 204 }))
      await first

      expect(queryClient.getQueryData(sessionModelSyncStateKey("server\nses_1"))).toEqual({
        desired: "sonnet",
        synced: "sonnet",
      })
      expect(queryClient.getQueryData(sessionModelSyncRequestKey("server\nses_1", "sonnet"))).toBeUndefined()
    })

    test("does not mark an older write synced after a newer model is desired", async () => {
      let releaseOld: (res: Response) => void
      let releaseNew: (res: Response) => void

      const oldWrite = syncHarnessSessionModel({
        key: "server\nses_1",
        model: "sonnet",
        request: () =>
          new Promise<Response>((resolve) => {
            releaseOld = resolve
          }),
      })
      const newWrite = syncHarnessSessionModel({
        key: "server\nses_1",
        model: "opus",
        request: () =>
          new Promise<Response>((resolve) => {
            releaseNew = resolve
          }),
      })

      releaseOld!(new Response(null, { status: 204 }))
      await oldWrite
      expect(queryClient.getQueryData(sessionModelSyncStateKey("server\nses_1"))).toEqual({
        desired: "opus",
      })

      releaseNew!(new Response(null, { status: 204 }))
      await newWrite
      expect(queryClient.getQueryData(sessionModelSyncStateKey("server\nses_1"))).toEqual({
        desired: "opus",
        synced: "opus",
      })
    })
  })

  describe("harnessChangeKey", () => {
    const target = { serverUrl: "http://127.0.0.1:3001", directory: "/tmp/project" }

    test("uses the authority, harness type, and binary for in-flight dedupe", () => {
      expect(harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" })).toBe(
        harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" }),
      )
      expect(harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" })).not.toBe(
        harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" }, "/usr/local/bin/codex"),
      )
      expect(harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" })).not.toBe(
        harnessChangeKey(target, { kind: "connection", connectionId: "acp:claude" }),
      )
      expect(harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" })).not.toBe(
        harnessChangeKey(
          { ...target, serverUrl: "https://app.claxedo.test" },
          { kind: "connection", connectionId: "acp:codex" },
        ),
      )
    })

    test("stores harness switch in-flight state under a Query request key", () => {
      const key = harnessChangeKey(target, { kind: "connection", connectionId: "acp:codex" })
      expect(harnessChangeRequestKey(key)).toEqual(["shell", "harness-config", "harness-change", key])
    })
  })

  describe("harness hydrate request ownership", () => {
    const server = "http://127.0.0.1:3001"

    test("stores hydrate in-flight state under a server-scoped Query request key", () => {
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
    })
  })

  describe("prepared runtime-session ownership", () => {
    const server = "http://127.0.0.1:3001"

    test("stores prepared harness sessions under server-scoped Query keys", () => {
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
    })
  })

  describe("harness option request metadata ownership", () => {
    const server = "http://127.0.0.1:3001"

    test("stores option sequencing and retry metadata under server-scoped Query keys", () => {
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
  })

  // ── failedHarness ────────────────────────────────────────────────────

  describe("failedHarness", () => {
    test("treats error status as terminal", () => {
      expect(failedHarness({ type: { kind: "connection", connectionId: "acp:codex" }, status: "error" })).toBe(true)
    })

    test("treats error message as terminal", () => {
      expect(
        failedHarness({ type: { kind: "connection", connectionId: "acp:claude" }, error: "binary not found" }),
      ).toBe(true)
    })

    test("ready state is not failed", () => {
      expect(failedHarness({ type: { kind: "connection", connectionId: "acp:claude" }, status: "ready" })).toBe(false)
    })

    test("no status and no error is not failed", () => {
      expect(failedHarness({ type: externalOpenCode })).toBe(false)
    })
  })

  // ── harnessScope ─────────────────────────────────────────────────────────

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

  describe("draft defaults", () => {
    test("a scope's transient seed carries no remembered harness", () => {
      expect(initialHarness()).toBeUndefined()
    })

    test("recognizes draft scopes", () => {
      expect(isDraftScope("draft:/tmp/proj:route")).toBe(true)
      expect(isDraftScope("session:ses_1")).toBe(false)
    })
  })

  describe("runner model fallback", () => {
    test("uses default model for non-opencode harnesses with no selected model", () => {
      expect(effectiveHarnessModel({ kind: "connection", connectionId: "acp:codex" }, "")).toBe(
        DEFAULT_HARNESS_MODEL.id,
      )
      expect(effectiveHarnessModel({ kind: "connection", connectionId: "acp:claude" }, undefined)).toBe(
        DEFAULT_HARNESS_MODEL.id,
      )
    })

    test("preserves explicit runner model selections", () => {
      expect(effectiveHarnessModel({ kind: "connection", connectionId: "acp:codex" }, "gpt-5.1")).toBe("gpt-5.1")
    })

    test("does not invent a model for provider-backed Pi", () => {
      expect(effectiveHarnessModel(pi, "gpt-5.1")).toBe("gpt-5.1")
      expect(effectiveHarnessModel(pi, undefined)).toBe("")
    })
  })

  describe("config option fetching", () => {
    test("does not show the stale warning dot when cached models are usable", () => {
      expect(
        shouldShowModelOptionsStaleWarning({
          stale: true,
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        }),
      ).toBe(false)
    })

    test("keeps the stale warning for empty model options", () => {
      expect(
        shouldShowModelOptionsStaleWarning({
          stale: true,
          models: [],
        }),
      ).toBe(true)
    })

    test("loads selectable models when an active existing session hydrates", () => {
      expect(
        shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, false, {
          directory: "/tmp/project",
          sessionId: "ses_1",
        }),
      ).toBe(true)
    })

    test("allows draft sessions to load selectable models", () => {
      expect(
        shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, false, {
          directory: "/tmp/project",
          sessionId: "new",
        }),
      ).toBe(true)
    })

    test("fetches options for connections but not failed harnesses", () => {
      expect(shouldFetchConfigOptionsForScope(externalOpenCode, false, { directory: "/tmp/project" })).toBe(true)
      expect(
        shouldFetchConfigOptionsForScope({ kind: "connection", connectionId: "acp:claude" }, true, {
          directory: "/tmp/project",
        }),
      ).toBe(false)
    })

    test("retries stale model options only within the bounded retry budget", () => {
      expect(shouldRetryModelOptions({ stale: true, tries: 0, limit: 2 })).toBe(true)
      expect(shouldRetryModelOptions({ stale: true, tries: 2, limit: 2 })).toBe(false)
      expect(shouldRetryModelOptions({ stale: false, tries: 0, limit: 2 })).toBe(false)
    })

    test("uses an unavailable message after stale model option retries are exhausted", () => {
      expect(modelOptionsUnavailableMessage({ stale: true })).toBe("Model options unavailable")
      expect(modelOptionsUnavailableMessage({ stale: false })).toBe("No model options available")
    })
  })

  describe("directory refresh after runner status", () => {
    test("does not bootstrap a directory just because an existing session selector hydrates", () => {
      expect(
        shouldRefreshDirectoryAfterHarnessStatus({
          directory: "/tmp/project",
          sessionId: "ses_1",
        }),
      ).toBe(false)
    })

    test("keeps draft session hydration able to refresh runner-scoped directory config", () => {
      expect(
        shouldRefreshDirectoryAfterHarnessStatus({
          directory: "/tmp/project",
          sessionId: "new",
        }),
      ).toBe(true)
      expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project" })).toBe(true)
    })

    test("keeps native harness hints for workspace refresh", () => {
      expect(
        refreshHarnessTypeForScope({
          directory: "ws_123",
          harness: codex,
        }),
      ).toBe("codex")
    })

    test("omits connection ids from native refresh hints", () => {
      expect(
        refreshHarnessTypeForScope({
          directory: "/tmp/project",
          harness: externalOpenCode,
        }),
      ).toBeUndefined()
    })

    test("does not treat connection ids as native refresh hints", () => {
      expect(
        refreshHarnessTypeForScope({
          directory: "ws_123",
          harness: { kind: "connection", connectionId: "acp:cursor" },
        }),
      ).toBeUndefined()
    })
  })

  describe("draft runner status hydration", () => {
    test("uses loopback runner status for cloud and user-hosted draft selectors", () => {
      expect(
        shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig: true,
          workspaceKind: "cloud",
        }),
      ).toBe(true)
      expect(
        shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig: true,
          workspaceKind: "user-hosted",
        }),
      ).toBe(true)
    })

    test("skips runner status when the local bridge is not available", () => {
      expect(
        shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig: false,
          workspaceKind: "cloud",
        }),
      ).toBe(false)
    })

    test("skips runner status for synthetic workspace-runtime drafts", () => {
      expect(
        shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig: false,
          workspaceRuntime: true,
        }),
      ).toBe(false)
      expect(
        shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig: true,
          workspaceRuntime: true,
        }),
      ).toBe(false)
    })
  })

  describe("local runner config API usage", () => {
    test("allows loopback filesystem workspaces to use unsigned local runner config", () => {
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "http://127.0.0.1:3001",
          directory: "/tmp/project",
        }),
      ).toBe(true)
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "https://localhost:3001",
          directory: "/tmp/project",
        }),
      ).toBe(true)
    })

    test("does not use local runner config for hosted control planes", () => {
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "https://claxedo.example.test",
          directory: "/tmp/project",
        }),
      ).toBe(false)
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "ftp://127.0.0.1:3001",
          directory: "/tmp/project",
        }),
      ).toBe(false)
    })

    test("does not use local runner config for synthetic workspace selectors", () => {
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "http://127.0.0.1:3001",
          directory: "workspace:ws_1",
        }),
      ).toBe(false)
    })

    test("does not use local runner config for user-hosted workspace directories", () => {
      expect(
        shouldUseLocalHarnessConfigApi({
          baseUrl: "http://127.0.0.1:3001",
          directory: "/repo/.claxedo/user-hosted/workspaces/ws_1",
          workspaceKind: "user-hosted",
        }),
      ).toBe(false)
    })
  })

  describe("extractModelsFromConfigOptions", () => {
    test("returns models from a model select option", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
      ])

      expect(result).toEqual({
        currentModel: "opus",
        models: [
          { id: "sonnet", name: "Sonnet" },
          { id: "opus", name: "Opus" },
        ],
      })
    })

    test("returns null when no model option exists", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ])

      expect(result).toBeNull()
    })

    test("returns null when model option has no choices", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "",
          options: [],
        },
      ])

      expect(result).toBeNull()
    })
  })
})
