import { describe, expect, test } from "bun:test"
import {
  harnessHealthReadiness,
  harnessStatusPatch,
  harnessSwitchStartPatch,
  initialHarnessStoreState,
  pollingHarnessHydrationPatch,
  readyHarnessHydrationPatch,
} from "./store-state"
import { connectionHarness, nativeHarness } from "@/platform/identity/harness-selection"

const codex = nativeHarness("codex")
const pi = nativeHarness("pi")
const openCode = connectionHarness("opencode")

test("connection observations survive config hydration but cannot cross connection switches", () => {
  const current = { ...initialHarnessStoreState({ scope: "session:one" }), harness: openCode, connectionState: { connectionId: "opencode", state: "disconnected" as const } }
  expect(harnessStatusPatch({ data: { type: openCode }, current }).connectionState).toEqual(current.connectionState)
  expect(harnessStatusPatch({ data: { type: connectionHarness("other") }, current }).connectionState).toBeUndefined()
  expect(harnessStatusPatch({ data: { type: codex }, current }).connectionState).toBeUndefined()
  expect(harnessSwitchStartPatch({ type: openCode }).connectionState).toBeUndefined()
  const observed = { connectionId: "opencode", state: "configured" as const }
  expect(harnessStatusPatch({ data: { type: openCode, connectionState: observed }, current }).connectionState).toEqual(observed)
})

describe("harness store state projectors", () => {
  // The seed carries no remembered choice for ANY scope kind: a draft's comes
  // from the per-(server, workspace, harness) defaults, a session's from its
  // own config. Nothing is pane-scoped any more.
  test("starts with no choice while assigning session authority and awaiting draft authority", () => {
    for (const [scope, authority] of [["session:ses_1", "server"], ["draft:/repo:route", "unresolved"]]) {
      expect(initialHarnessStoreState({ scope })).toMatchObject({
        harnessMode: "unknown",
        harness: undefined,
        selectedModel: "",
        readiness: "unresolved",
        optionsSource: "empty",
        draftDefaultAuthority: authority,
      })
    }
  })



  test("projects harness status onto current state", () => {
    expect(
      harnessStatusPatch({
        current: initialHarnessStoreState({ scope: "draft:/repo:route" }),
        data: {
          type: { kind: "connection", connectionId: "acp:claude" },
          activeType: { kind: "connection", connectionId: "acp:claude" },
          model: "sonnet",
          modelProviderID: "claude",
          workspaceId: "ws_1",
        },
      }),
    ).toMatchObject({
      harnessMode: "harness",
      harness: { kind: "connection", connectionId: "acp:claude" },
      selectedModel: "sonnet",
      selectedModelProvider: "claude",
      readiness: "ready",
      configError: undefined,
      workspaceId: "ws_1",
    })

    expect(
      harnessStatusPatch({
        data: {
          type: openCode,
          activeType: openCode,
          error: "runner failed",
        },
      }),
    ).toMatchObject({
      harnessMode: "harness",
      harness: openCode,
      readiness: "error",
      configError: "runner failed",
    })

    // A harness that is configured/applying but not yet ready is still
    // CONNECTING, not failed — it must report "polling" so the selector shows a
    // "Connecting" pill instead of a red "Unavailable" at startup.
    expect(
      harnessStatusPatch({
        data: {
          type: codex,
          status: "configured",
          ready: false,
        },
      }),
    ).toMatchObject({
      harnessMode: "harness",
      harness: codex,
      readiness: "polling",
    })
    expect(
      harnessStatusPatch({
        data: {
          type: codex,
          status: "applying",
          ready: false,
        },
      }),
    ).toMatchObject({ readiness: "polling" })

    // A hard failure (status "error" or an error message) stays "error".
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "error" },
      }),
    ).toMatchObject({ readiness: "error" })
    expect(
      harnessStatusPatch({
        data: { type: codex, error: "spawn failed", ready: false },
      }),
    ).toMatchObject({ readiness: "error" })

    // `settled: true` marks a COMPLETED switch response (not a startup/in-flight
    // probe). A completed response that still reports ready:false is a definitive
    // failure — the harness finished configuring and came back unavailable — so
    // it is "error", not "polling". This is the harness-switcher applyPostedStatus
    // path (core-harness-ownership-local, harness-switcher.test.ts:144).
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "configured", ready: false },
        settled: true,
      }),
    ).toMatchObject({ readiness: "error" })
    // Without `settled`, the same frame is an in-flight probe → still "polling".
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "configured", ready: false },
      }),
    ).toMatchObject({ readiness: "polling" })
    // A settled ready:true response is still "ready".
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "ready", ready: true },
        settled: true,
      }),
    ).toMatchObject({ readiness: "ready" })

    // A ready harness is ready.
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "ready", ready: true },
      }),
    ).toMatchObject({ readiness: "ready" })

    // A live-but-degraded harness (ready:true while harnessHealth.status is
    // degraded/unavailable — process lost and recovering) maps to "degraded".
    expect(
      harnessStatusPatch({
        data: {
          type: codex,
          status: "ready",
          ready: true,
          harnessHealth: { status: "degraded", reason: "harness_process_lost" },
        },
      }),
    ).toMatchObject({ harness: codex, readiness: "degraded" })
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "ready", ready: true, harnessHealth: { status: "unavailable" } },
      }),
    ).toMatchObject({ readiness: "degraded" })
    // A healthy harnessHealth report does not degrade a ready harness.
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "ready", ready: true, harnessHealth: { status: "ok" } },
      }),
    ).toMatchObject({ readiness: "ready" })
    // A hard failure still wins over degraded health.
    expect(
      harnessStatusPatch({
        data: { type: codex, status: "error", harnessHealth: { status: "degraded" } },
      }),
    ).toMatchObject({ readiness: "error" })
    // Connection-backed harnesses use the same health contract as native SDKs.
    expect(
      harnessStatusPatch({
        data: { type: openCode, ready: true, harnessHealth: { status: "degraded" } },
      }),
    ).toMatchObject({ harnessMode: "harness", readiness: "degraded" })
  })

  test("derives the standing health-probe readiness transition", () => {
    // Degraded/unavailable health degrades a settled harness.
    expect(harnessHealthReadiness({ harness: codex, current: "ready", health: "degraded" })).toBe("degraded")
    expect(harnessHealthReadiness({ harness: codex, current: "ready", health: "unavailable" })).toBe("degraded")
    // Recovery: healthy health clears a prior degraded state back to ready.
    expect(harnessHealthReadiness({ harness: codex, current: "degraded", health: "ok" })).toBe("ready")
    // No-op transitions leave readiness untouched (undefined).
    expect(harnessHealthReadiness({ harness: codex, current: "ready", health: "ok" })).toBeUndefined()
    expect(harnessHealthReadiness({ harness: codex, current: "degraded", health: "degraded" })).toBe("degraded")
    // The probe never stomps a state owned by hydration / hard failure.
    expect(harnessHealthReadiness({ harness: codex, current: "error", health: "degraded" })).toBeUndefined()
    expect(harnessHealthReadiness({ harness: codex, current: "polling", health: "degraded" })).toBeUndefined()
    expect(harnessHealthReadiness({ harness: openCode, current: "ready", health: "degraded" })).toBe("degraded")
    // Missing health is a no-op.
    expect(harnessHealthReadiness({ harness: codex, current: "ready" })).toBeUndefined()
  })

  test("keeps hydration and switch patches aligned with options policy", () => {
    expect(readyHarnessHydrationPatch({ kind: "connection", connectionId: "acp:claude" })).toEqual({
      harness: { kind: "connection", connectionId: "acp:claude" },
      harnessMode: "harness",
      readiness: "ready",
    })
    expect(readyHarnessHydrationPatch(pi)).toEqual({ harness: pi, harnessMode: "harness", readiness: "ready" })
    expect(pollingHarnessHydrationPatch({ kind: "connection", connectionId: "acp:claude" })).toEqual({
      harness: { kind: "connection", connectionId: "acp:claude" },
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
    expect(
      harnessSwitchStartPatch({
        type: { kind: "connection", connectionId: "acp:claude" },
      }),
    ).toMatchObject({
      harness: { kind: "connection", connectionId: "acp:claude" },
      harnessMode: "harness",
      selectedModel: "",
      optionsLoading: true,
    })
  })


})
