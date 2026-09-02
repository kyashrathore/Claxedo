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
  harnessDisplayLabel,
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
    test("infers a builtin harness id from native access + type", () => {
      expect(pickHarness("claude", null, "native")).toBe("claude-sdk")
      expect(pickHarness("codex", null, "native")).toBe("codex-app-server")
      expect(pickHarness("cursor", null, "native")).toBe("cursor-sdk")
      expect(pickHarness("opencode", null, "native")).toBe("opencode")
      expect(pickHarness("pi", null, "native")).toBe("pi")
    })

    test("infers an open acp:<slug> id from acp access + type", () => {
      expect(pickHarness("claude", null, "acp")).toBe("acp:claude")
      expect(pickHarness("codex", null, "acp")).toBe("acp:codex")
    })

    test("passes through an already-qualified acp:<slug> id regardless of access", () => {
      expect(pickHarness("acp:claude")).toBe("acp:claude")
    })

    test("ignores the binary argument entirely — selection flows through type + access only", () => {
      expect(pickHarness(undefined, "/tmp/codex-acp")).toBeUndefined()
      expect(pickHarness("opencode", "/tmp/unknown-binary")).toBe("opencode")
      expect(pickHarness("claude-sdk", "/tmp/codex-acp")).toBe("claude-sdk")
    })

    test("returns valid HarnessType from a bare builtin type string", () => {
      expect(pickHarness("claude-sdk")).toBe("claude-sdk")
      expect(pickHarness("codex-app-server")).toBe("codex-app-server")
      expect(pickHarness("cursor-sdk")).toBe("cursor-sdk")
      expect(pickHarness("opencode")).toBe("opencode")
      expect(pickHarness("pi")).toBe("pi")
    })

    test("returns undefined for unknown type without a matching access", () => {
      expect(pickHarness("unknown")).toBeUndefined()
      expect(pickHarness(undefined)).toBeUndefined()
      expect(pickHarness(null)).toBeUndefined()
    })
  })

  // ── desiredHarness / activeHarness ─────────────────────────────────────

  describe("desiredHarness vs activeHarness during switch", () => {
    test("separates desired from active while a switch is in flight", () => {
      const data = {
        type: "codex-app-server",
        activeType: "claude-sdk",
      } as const

      expect(desiredHarness(data)).toBe("codex-app-server")
      expect(activeHarness(data)).toBe("claude-sdk")
    })

    test("desired and active match when no switch is happening", () => {
      const data = {
        type: "claude-sdk",
        activeType: "claude-sdk",
      } as const

      expect(desiredHarness(data)).toBe("claude-sdk")
      expect(activeHarness(data)).toBe("claude-sdk")
    })

    test("activeHarness falls back to type when activeType is missing", () => {
      const data = {
        type: "codex-app-server",
      } as const

      expect(activeHarness(data)).toBe("codex-app-server")
    })
  })

  describe("session config runner state", () => {
    test("uses persisted session runner instead of falling back to workspace default", () => {
      expect(harnessStateFromSessionConfig({
        harness: { type: "codex-app-server" },
        model: { modelID: "gpt-5.5" },
      })).toEqual({
        type: "codex-app-server",
        model: "gpt-5.5",
        status: "ready",
        ready: true,
        activeType: "codex-app-server",
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
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-app-server")).toBe("draft:/tmp/project:route\ncodex-app-server\n")
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-app-server", "/usr/local/bin/codex")).toBe("draft:/tmp/project:route\ncodex-app-server\n/usr/local/bin/codex")
      expect(harnessChangeKey("draft:/tmp/project:route", "codex-app-server")).not.toBe(harnessChangeKey("draft:/tmp/project:route", "claude-sdk"))
    })

    test("stores runner switch in-flight state under a Query request key", () => {
      const key = harnessChangeKey("draft:/tmp/project:route", "codex-app-server")
      expect(harnessChangeRequestKey(key)).toEqual([
        "shell",
        "harness-config",
        "harness-change",
        "draft:/tmp/project:route\ncodex-app-server\n",
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
      expect(failedHarness({ type: "codex-app-server", status: "error" })).toBe(true)
    })

    test("treats error message as terminal", () => {
      expect(failedHarness({ type: "claude-sdk", error: "binary not found" })).toBe(true)
    })

    test("ready state is not failed", () => {
      expect(failedHarness({ type: "claude-sdk", status: "ready" })).toBe(false)
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
      expect(initialHarness("draft:/tmp/proj:route", undefined, "claude-sdk")).toBe("opencode")
      expect(initialHarness("draft:/tmp/proj:route", "codex-app-server", "claude-sdk")).toBe("codex-app-server")
    })

    test("session scopes still honor legacy runner defaults", () => {
      expect(initialHarness("session:ses_1", undefined, "claude-sdk")).toBe("claude-sdk")
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
      expect(effectiveHarnessModel("codex-app-server", "")).toBe(DEFAULT_HARNESS_MODEL.id)
      expect(effectiveHarnessModel("claude-sdk", undefined)).toBe(DEFAULT_HARNESS_MODEL.id)
    })

    test("preserves explicit runner model selections", () => {
      expect(effectiveHarnessModel("codex-app-server", "gpt-5.1")).toBe("gpt-5.1")
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

    test("loads selectable models when an active existing session hydrates", () => {
      expect(shouldFetchConfigOptionsForScope("claude-sdk", false, {
        directory: "/tmp/project",
        sessionId: "ses_1",
      })).toBe(true)
    })

    test("allows draft sessions to load selectable models", () => {
      expect(shouldFetchConfigOptionsForScope("claude-sdk", false, {
        directory: "/tmp/project",
        sessionId: "new",
      })).toBe(true)
    })

    test("does not fetch options for opencode or failed runners", () => {
      expect(shouldFetchConfigOptionsForScope("opencode", false, { directory: "/tmp/project" })).toBe(false)
      expect(shouldFetchConfigOptionsForScope("claude-sdk", true, { directory: "/tmp/project" })).toBe(false)
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
        harness: "cursor-sdk",
      })).toBe("cursor-sdk")
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
    test("maps all builtin harness ids and legacy binary names to display names", () => {
      expect(HARNESS_DISPLAY_NAMES["claude-sdk"]).toBe("Claude SDK")
      expect(HARNESS_DISPLAY_NAMES["codex-app-server"]).toBe("Codex App Server")
      expect(HARNESS_DISPLAY_NAMES["cursor-sdk"]).toBe("Cursor SDK")
      expect(HARNESS_DISPLAY_NAMES["agent"]).toBe("Cursor")
      expect(HARNESS_DISPLAY_NAMES["cursor-agent"]).toBe("Cursor")
      expect(HARNESS_DISPLAY_NAMES["opencode"]).toBe("OpenCode")
      expect(HARNESS_DISPLAY_NAMES["pi"]).toBe("Pi")
    })

    test("all builtin harness types have a display name", () => {
      const types: HarnessType[] = ["claude-sdk", "codex-app-server", "cursor-sdk", "opencode", "pi"]
      for (const t of types) {
        expect(HARNESS_DISPLAY_NAMES[t]).toBeTruthy()
      }
    })

    // The fixed ACP-id table entries (`claude-acp`, `codex-acp`, `cursor-acp`)
    // were replaced by the open `acp:<slug>` scheme — an operator connection has
    // no fixed table row, so its display name falls back to a title-cased slug.
    test("title-cases an open acp:<slug> id that has no table entry", () => {
      expect(harnessDisplayLabel("acp:claude")).toBe("Claude")
      expect(harnessDisplayLabel("acp:codex")).toBe("Codex")
      expect(harnessDisplayLabel("acp:my-custom-agent")).toBe("My Custom Agent")
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
