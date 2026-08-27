import { describe, expect, test } from "bun:test"
import {
  harnessHealthReadiness,
  harnessStatusPatch,
  harnessSwitchStartPatch,
  initialHarnessStoreState,
  pollingHarnessHydrationPatch,
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

  test("seeds a fresh scope with the un-confirmed opencode placeholder", () => {
    // Contract relied on by claxedo-ui/harness/harness-status-actions.ts's
    // applyStatus guard (core-harness-ownership-local:468): a scope with no
    // saved/legacy harness MUST seed harness "opencode". The guard treats that
    // seed as NOT-user-confirmed, so a later failed status for the harness the
    // scope is really configured with is applied (red dot) rather than silently
    // swallowed. If this seed ever changed to a real harness id, that guard
    // would misfire — hence pinning it here.
    const seeded = initialHarnessStoreState({ scope: "draft:/repo:route" })
    expect(seeded.harness).toBe("opencode")
    expect(seeded.harnessMode).toBe("opencode")
    expect(seeded.selectedModel).toBe("")
  })

  test("projects workspace draft reset state without touching persistence", () => {
    expect(workspaceDraftHarnessResetPatch()).toEqual({
      harness: "opencode",
      harnessMode: "opencode",
      selectedModel: "",
      dynamicModels: null,
      thoughtLevels: null,
      selectedThoughtLevel: undefined,
      readiness: "ready",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    })
  })

  test("restores the complete persisted Pi model key", () => {
    expect(initialHarnessStoreState({
      scope: "draft:/repo:route",
      savedHarness: "pi",
      savedModel: '{"providerID":"anthropic","modelID":"claude-sonnet-4-5"}',
    })).toMatchObject({
      harness: "pi",
      selectedModelProvider: "anthropic",
      selectedModel: "claude-sonnet-4-5",
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
      thoughtLevels: null,
      selectedThoughtLevel: undefined,
      readiness: "error",
      configError: "runner failed",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })

    // A harness that is configured/applying but not yet ready is still
    // CONNECTING, not failed — it must report "polling" so the selector shows a
    // "Connecting" pill instead of a red "Unavailable" at startup (bug: the
    // error/ready binary made the polling UI unreachable).
    expect(harnessStatusPatch({
      data: {
        type: "codex-app-server",
        status: "configured",
        ready: false,
      },
    })).toMatchObject({
      harnessMode: "harness",
      harness: "codex-app-server",
      readiness: "polling",
    })
    expect(harnessStatusPatch({
      data: {
        type: "codex-app-server",
        status: "applying",
        ready: false,
      },
    })).toMatchObject({ readiness: "polling" })

    // A hard failure (status "error" or an error message) stays "error".
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "error" },
    })).toMatchObject({ readiness: "error" })
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", error: "spawn failed", ready: false },
    })).toMatchObject({ readiness: "error" })

    // `settled: true` marks a COMPLETED switch response (not a startup/in-flight
    // probe). A completed response that still reports ready:false is a definitive
    // failure — the harness finished configuring and came back unavailable — so
    // it is "error", not "polling". This is the harness-switcher applyPostedStatus
    // path (core-harness-ownership-local, harness-switcher.test.ts:144).
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "configured", ready: false },
      settled: true,
    })).toMatchObject({ readiness: "error" })
    // Without `settled`, the same frame is an in-flight probe → still "polling".
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "configured", ready: false },
    })).toMatchObject({ readiness: "polling" })
    // A settled ready:true response is still "ready".
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "ready", ready: true },
      settled: true,
    })).toMatchObject({ readiness: "ready" })

    // A ready harness is ready.
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "ready", ready: true },
    })).toMatchObject({ readiness: "ready" })

    // OpenCode is the always-available local default: never "polling" even if a
    // status frame arrives with ready:false.
    expect(harnessStatusPatch({
      data: { type: "opencode", ready: false },
    })).toMatchObject({ harnessMode: "opencode", readiness: "ready" })

    // A live-but-degraded harness (`/api/wr/health` reports ok:true while
    // harnessHealth.status is degraded/unavailable — process lost + recovering)
    // maps to the "degraded" readiness that drives the composer health peek +
    // Send gate (T4). This finally exercises the union member at selection.ts:9.
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "ready", ready: true, harnessHealth: { status: "degraded", reason: "harness_process_lost" } },
    })).toMatchObject({ harness: "codex-app-server", readiness: "degraded" })
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "ready", ready: true, harnessHealth: { status: "unavailable" } },
    })).toMatchObject({ readiness: "degraded" })
    // A healthy harnessHealth report does not degrade a ready harness.
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "ready", ready: true, harnessHealth: { status: "ok" } },
    })).toMatchObject({ readiness: "ready" })
    // A hard failure still wins over degraded health.
    expect(harnessStatusPatch({
      data: { type: "codex-app-server", status: "error", harnessHealth: { status: "degraded" } },
    })).toMatchObject({ readiness: "error" })
    // OpenCode never degrades even if a stray health frame arrives.
    expect(harnessStatusPatch({
      data: { type: "opencode", ready: true, harnessHealth: { status: "degraded" } },
    })).toMatchObject({ harnessMode: "opencode", readiness: "ready" })
  })

  test("derives the standing health-probe readiness transition (T4)", () => {
    // Degraded/unavailable health degrades a settled harness.
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "ready", health: "degraded" })).toBe("degraded")
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "ready", health: "unavailable" })).toBe("degraded")
    // Recovery: healthy health clears a prior degraded state back to ready.
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "degraded", health: "ok" })).toBe("ready")
    // No-op transitions leave readiness untouched (undefined).
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "ready", health: "ok" })).toBeUndefined()
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "degraded", health: "degraded" })).toBe("degraded")
    // The probe never stomps a state owned by hydration / hard failure.
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "error", health: "degraded" })).toBeUndefined()
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "polling", health: "degraded" })).toBeUndefined()
    // OpenCode never degrades.
    expect(harnessHealthReadiness({ harness: "opencode", current: "ready", health: "degraded" })).toBeUndefined()
    // Missing health is a no-op.
    expect(harnessHealthReadiness({ harness: "codex-app-server", current: "ready" })).toBeUndefined()
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
      thoughtLevels: null,
      selectedThoughtLevel: undefined,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
    expect(pollingHarnessHydrationPatch("claude-acp")).toEqual({
      harness: "claude-acp",
      harnessMode: "harness",
      selectedModel: "",
      selectedModelProvider: undefined,
      dynamicModels: null,
      thoughtLevels: null,
      selectedThoughtLevel: undefined,
      readiness: "polling",
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
      configError: undefined,
    })
    expect(harnessSwitchStartPatch({
      type: "claude-acp",
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
