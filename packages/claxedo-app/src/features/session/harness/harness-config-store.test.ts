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
  type HarnessType,
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
  initialValue,
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
      expect(HARNESS_DISPLAY_NAMES.opencode).toBe("OpenCode")
    })
  })

  // ── pickHarness ───────────────────────────────────────────────────────

  describe("pickHarness", () => {
    test("infers harness from acp binary name", () => {
      expect(pickHarness(undefined, "/tmp/codex-acp")).toBe("codex-acp")
      expect(pickHarness(undefined, "/tmp/claude-agent-acp")).toBe("claude-acp")
      expect(pickHarness(undefined, "/tmp/agent")).toBe("cursor-acp")
      expect(pickHarness(undefined, "/tmp/cursor-agent")).toBe("cursor-acp")
    })

    test("extracts basename from full path before matching", () => {
      expect(pickHarness(undefined, "/usr/local/bin/codex-acp")).toBe("codex-acp")
      expect(pickHarness(undefined, "/home/user/.local/bin/claude-agent-acp")).toBe("claude-acp")
      expect(pickHarness(undefined, "/opt/agents/cursor-agent")).toBe("cursor-acp")
    })

    test("strips .exe suffix when binary has forward slashes", () => {
      expect(pickHarness(undefined, "C:/agents/codex-acp.exe")).toBe("codex-acp")
      expect(pickHarness(undefined, "C:/agents/agent.exe")).toBe("cursor-acp")
    })

    test("matches substring in full path when no forward slash present", () => {
      // backslash paths don't get basename-extracted, but substring match still works
      expect(pickHarness(undefined, "C:\\agents\\codex-acp.exe")).toBe("codex-acp")
      expect(pickHarness(undefined, "C:\\agents\\claude-agent-acp")).toBe("claude-acp")
      // "agent" alone doesn't match via substring since "cursor" not in path
      expect(pickHarness(undefined, "C:\\agents\\agent.exe")).toBeUndefined()
    })

    test("falls back to type when binary does not match any known pattern", () => {
      expect(pickHarness("claude-acp", "/tmp/unknown-binary")).toBe("claude-acp")
      expect(pickHarness("opencode", "/tmp/unknown-binary")).toBe("opencode")
    })

    test("returns valid HarnessType from type string", () => {
      expect(pickHarness("claude-acp")).toBe("claude-acp")
      expect(pickHarness("codex-acp")).toBe("codex-acp")
      expect(pickHarness("cursor-acp")).toBe("cursor-acp")
      expect(pickHarness("claude-sdk")).toBe("claude-sdk")
      expect(pickHarness("codex-app-server")).toBe("codex-app-server")
      expect(pickHarness("opencode")).toBe("opencode")
    })

    test("returns undefined for unknown type without binary", () => {
      expect(pickHarness("unknown")).toBeUndefined()
      expect(pickHarness(undefined)).toBeUndefined()
      expect(pickHarness(null)).toBeUndefined()
    })

    test("binary takes priority over type for classification", () => {
      // binary says codex, type says claude → codex wins
      expect(pickHarness("claude-acp", "/tmp/codex-acp")).toBe("codex-acp")
    })
  })

  // ── desiredHarness / activeHarness ─────────────────────────────────────

  describe("desiredHarness vs activeHarness during switch", () => {
    test("separates desired from active while a switch is in flight", () => {
      const data = {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
        activeType: "claude-acp",
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toBe("codex-acp")
      expect(activeHarness(data)).toBe("claude-acp")
    })

    test("desired and active match when no switch is happening", () => {
      const data = {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        activeType: "claude-acp",
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredHarness(data)).toBe("claude-acp")
      expect(activeHarness(data)).toBe("claude-acp")
    })

    test("activeHarness falls back to type when activeType is missing", () => {
      const data = {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
      } as const

      expect(activeHarness(data)).toBe("codex-acp")
    })
  })

  describe("session config runner state", () => {
    test("uses persisted session runner instead of falling back to workspace default", () => {
      expect(harnessStateFromSessionConfig({
        harness: { type: "codex-acp" },
        model: { modelID: "gpt-5.5" },
      })).toEqual({
        type: "codex-acp",
        model: "gpt-5.5",
        status: "ready",
        ready: true,
        activeType: "codex-acp",
        activeBinary: null,
      })
    })
  })

  describe("session model sync", () => {
    test("keys existing sessions by session id and base URL, not directory", () => {
      expect(sessionModelSyncKey("http://127.0.0.1:3001", {
        directory: "/repo/a",
        sessionId: "ses_1",
      })).toBe("http://127.0.0.1:3001\nses_1")
      expect(sessionModelSyncKey("http://127.0.0.1:3001", {
        directory: "/repo/b",
        sessionId: "ses_1",
      })).toBe("http://127.0.0.1:3001\nses_1")
      expect(sessionModelSyncKey("http://127.0.0.1:3001", {
        directory: "/repo/a",
        sessionId: "new",
      })).toBeUndefined()
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
    test("uses scope, runner type, and binary for in-flight dedupe", () => {
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-acp")).toBe("draft:/tmp/project:route\ncodex-acp\n")
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-acp", "/usr/local/bin/codex")).toBe("draft:/tmp/project:route\ncodex-acp\n/usr/local/bin/codex")
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-acp")).not.toBe(harnessChangeKey("draft:/tmp/project:route", "claude-acp"))
    })

    test("stores runner switch in-flight state under a Query request key", () => {
      const key = harnessChangeKey("draft:/tmp/project:route", "codex-acp")
      expect(harnessChangeRequestKey(key)).toEqual([
        "shell",
        "harness-config",
        "harness-change",
        "draft:/tmp/project:route\ncodex-acp\n",
      ])
    })
  })

  describe("runner hydrate request ownership", () => {
    test("stores hydrate in-flight state under a Query request key", () => {
      expect(harnessHydrateRequestKey("session:ses_1")).toEqual([
        "shell",
        "harness-config",
        "hydrate",
        "session:ses_1",
      ])
      expect(harnessHydrateSeenKey("session:ses_1")).toEqual([
        "shell",
        "harness-config",
        "hydrate",
        "session:ses_1",
        "seen",
      ])
    })
  })

  describe("prepared runtime-session ownership", () => {
    test("stores prepared runner sessions under Query keys", () => {
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
    })
  })

  describe("runner option request metadata ownership", () => {
    test("stores option sequencing and retry metadata under Query keys", () => {
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
    })
  })

  // ── failedHarness ────────────────────────────────────────────────────

  describe("failedHarness", () => {
    test("treats error status as terminal", () => {
      expect(failedHarness({ type: "codex-acp", status: "error" })).toBe(true)
    })

    test("treats error message as terminal", () => {
      expect(failedHarness({ type: "claude-acp", error: "binary not found" })).toBe(true)
    })

    test("ready state is not failed", () => {
      expect(failedHarness({ type: "claude-acp", status: "ready" })).toBe(false)
    })

    test("no status and no error is not failed", () => {
      expect(failedHarness({ type: "opencode" })).toBe(false)
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
    test("draft scopes ignore legacy runner defaults", () => {
      expect(initialHarness("draft:/tmp/proj:route", undefined, "claude-acp")).toBe("opencode")
      expect(initialHarness("draft:/tmp/proj:route", "codex-acp", "claude-acp")).toBe("codex-acp")
    })

    test("session scopes still honor legacy runner defaults", () => {
      expect(initialHarness("session:ses_1", undefined, "claude-acp")).toBe("claude-acp")
    })

    test("draft scopes ignore legacy model and agent values", () => {
      expect(initialValue("draft:/tmp/proj:route", undefined, "opus")).toBe("")
      expect(initialValue("draft:/tmp/proj:route", "sonnet", "opus")).toBe("sonnet")
    })

    test("recognizes draft scopes", () => {
      expect(isDraftScope("draft:/tmp/proj:route")).toBe(true)
      expect(isDraftScope("session:ses_1")).toBe(false)
    })
  })

  describe("runner model fallback", () => {
    test("uses default model for non-opencode harnesses with no selected model", () => {
      expect(effectiveHarnessModel("codex-acp", "")).toBe(DEFAULT_HARNESS_MODEL.id)
      expect(effectiveHarnessModel("claude-acp", undefined)).toBe(DEFAULT_HARNESS_MODEL.id)
    })

    test("preserves explicit runner model selections", () => {
      expect(effectiveHarnessModel("codex-acp", "gpt-5.1")).toBe("gpt-5.1")
    })

    test("does not invent a model for opencode provider mode", () => {
      expect(effectiveHarnessModel("opencode", "gpt-5.1")).toBe("")
      expect(effectiveHarnessModel("opencode", undefined)).toBe("")
    })
  })

  describe("config option fetching", () => {
    test("does not show the stale warning dot when cached models are usable", () => {
      expect(shouldShowModelOptionsStaleWarning({
        stale: true,
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      })).toBe(false)
    })

    test("keeps the stale warning for empty model options", () => {
      expect(shouldShowModelOptionsStaleWarning({
        stale: true,
        models: [],
      })).toBe(true)
    })

    test("does not load selectable models when an active existing session hydrates", () => {
      expect(shouldFetchConfigOptionsForScope("claude-acp", false, {
        directory: "/tmp/project",
        sessionId: "ses_1",
      })).toBe(false)
    })

    test("allows draft sessions to load selectable models", () => {
      expect(shouldFetchConfigOptionsForScope("claude-acp", false, {
        directory: "/tmp/project",
        sessionId: "new",
      })).toBe(true)
    })

    test("does not fetch options for opencode or failed runners", () => {
      expect(shouldFetchConfigOptionsForScope("opencode", false, { directory: "/tmp/project" })).toBe(false)
      expect(shouldFetchConfigOptionsForScope("claude-acp", true, { directory: "/tmp/project" })).toBe(false)
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
      expect(shouldRefreshDirectoryAfterHarnessStatus({
        directory: "/tmp/project",
        sessionId: "ses_1",
      })).toBe(false)
    })

    test("keeps draft session hydration able to refresh runner-scoped directory config", () => {
      expect(shouldRefreshDirectoryAfterHarnessStatus({
        directory: "/tmp/project",
        sessionId: "new",
      })).toBe(true)
      expect(shouldRefreshDirectoryAfterHarnessStatus({ directory: "/tmp/project" })).toBe(true)
    })

    test("keeps OpenCode runner hint for raw workspace runtime scopes", () => {
      expect(refreshHarnessTypeForScope({
        directory: "ws_123",
        harness: "opencode",
      })).toBe("opencode")
    })

    test("keeps OpenCode runner hint for legacy workspace runtime scopes", () => {
      expect(refreshHarnessTypeForScope({
        directory: "workspace:ws_123",
        harness: "opencode",
      })).toBe("opencode")
    })

    test("omits OpenCode runner hint for filesystem scopes", () => {
      expect(refreshHarnessTypeForScope({
        directory: "/tmp/project",
        harness: "opencode",
      })).toBeUndefined()
    })

    test("keeps non-OpenCode runner hints unchanged", () => {
      expect(refreshHarnessTypeForScope({
        directory: "ws_123",
        harness: "cursor-acp",
      })).toBe("cursor-acp")
    })
  })

  describe("draft runner status hydration", () => {
    test("uses loopback runner status for cloud and user-hosted draft selectors", () => {
      expect(shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceKind: "cloud",
      })).toBe(true)
      expect(shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceKind: "user-hosted",
      })).toBe(true)
    })

    test("skips runner status when the local bridge is not available", () => {
      expect(shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: false,
        workspaceKind: "cloud",
      })).toBe(false)
    })

    test("skips runner status for synthetic workspace-runtime drafts", () => {
      expect(shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: false,
        workspaceRuntime: true,
      })).toBe(false)
      expect(shouldHydrateDraftFromHarnessStatus({
        useLocalHarnessConfig: true,
        workspaceRuntime: true,
      })).toBe(false)
    })
  })

  describe("local runner config API usage", () => {
    test("allows loopback filesystem workspaces to use unsigned local runner config", () => {
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "/tmp/project",
      })).toBe(true)
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "https://localhost:3001",
        directory: "/tmp/project",
      })).toBe(true)
    })

    test("does not use local runner config for hosted control planes", () => {
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "https://claxedo.example.test",
        directory: "/tmp/project",
      })).toBe(false)
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "ftp://127.0.0.1:3001",
        directory: "/tmp/project",
      })).toBe(false)
    })

    test("does not use local runner config for synthetic workspace selectors", () => {
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "workspace:ws_1",
      })).toBe(false)
    })

    test("does not use local runner config for user-hosted workspace directories", () => {
      expect(shouldUseLocalHarnessConfigApi({
        baseUrl: "http://127.0.0.1:3001",
        directory: "/repo/.claxedo/user-hosted/workspaces/ws_1",
        workspaceKind: "user-hosted",
      })).toBe(false)
    })

  })

  // ── HARNESS_DISPLAY_NAMES ───────────────────────────────────────────────

  describe("HARNESS_DISPLAY_NAMES", () => {
    test("maps all known binary names to display names", () => {
      expect(HARNESS_DISPLAY_NAMES["claude-agent-acp"]).toBe("Claude")
      expect(HARNESS_DISPLAY_NAMES["claude-acp"]).toBe("Claude")
      expect(HARNESS_DISPLAY_NAMES["codex-acp"]).toBe("Codex")
      expect(HARNESS_DISPLAY_NAMES["claude-sdk"]).toBe("Claude SDK")
      expect(HARNESS_DISPLAY_NAMES["codex-app-server"]).toBe("Codex App Server")
      expect(HARNESS_DISPLAY_NAMES["agent"]).toBe("Cursor")
      expect(HARNESS_DISPLAY_NAMES["cursor-agent"]).toBe("Cursor")
      expect(HARNESS_DISPLAY_NAMES["cursor-acp"]).toBe("Cursor")
      expect(HARNESS_DISPLAY_NAMES["opencode"]).toBe("OpenCode")
    })

    test("all runner types have a display name", () => {
      const types: HarnessType[] = ["claude-acp", "codex-acp", "cursor-acp", "claude-sdk", "codex-app-server", "cursor-sdk", "opencode"]
      for (const t of types) {
        expect(HARNESS_DISPLAY_NAMES[t]).toBeTruthy()
      }
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
