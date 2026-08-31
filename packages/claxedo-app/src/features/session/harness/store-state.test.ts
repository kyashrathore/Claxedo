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

const claude = nativeHarness("claude")
const codex = nativeHarness("codex")
const pi = nativeHarness("pi")
const openCode = connectionHarness("opencode")

describe("harness store state projectors", () => {
  // The seed carries no remembered choice for ANY scope kind: a draft's comes
  // from the per-(server, workspace, harness) defaults, a session's from its
  // own config. Nothing is pane-scoped any more.
  test("builds the same empty initial state for a draft and a session scope", () => {
    for (const scope of ["session:ses_1", "draft:/repo:route"]) {
      expect(initialHarnessStoreState({ scope })).toMatchObject({
        harnessMode: "opencode",
        harness: "opencode",
        selectedModel: "",
        readiness: "ready",
        optionsSource: "empty",
      })
    }
  })

  test("seeds a fresh scope unresolved without inventing a harness", () => {
    const seeded = initialHarnessStoreState({ scope: "draft:/repo:route" })
    expect(seeded.harness).toBeUndefined()
    expect(seeded.harnessMode).toBe("unknown")
    expect(seeded.readiness).toBe("unresolved")
    expect(seeded.selectedModel).toBe("")
  })

  test("projects harness status onto current state", () => {
    expect(harnessStatusPatch({
      current: initialHarnessStoreState({ scope: "draft:/repo:route" }),
      data: {
        type: "acp:claude",
        activeType: "acp:claude",
        activeBinary: "/bin/claude",
        model: "sonnet",
        modelProviderID: "claude",
        workspaceId: "ws_1",
      },
    })).toMatchObject({
      harnessMode: "harness",
      harnessBinary: "/bin/claude",
      harness: "acp:claude",
      selectedModel: "sonnet",
      selectedModelProvider: "claude",
      readiness: "ready",
      configError: undefined,
      workspaceId: "ws_1",
    })

    expect(harnessStatusPatch({
      data: {
        type: openCode,
        activeType: openCode,
        error: "runner failed",
      },
    })).toMatchObject({
      harnessMode: "harness",
      harness: openCode,
      readiness: "error",
      configError: "runner failed",
    })

    // A harness that is configured/applying but not yet ready is still
    // CONNECTING, not failed — it must report "polling" so the selector shows a
    // "Connecting" pill instead of a red "Unavailable" at startup (bug: the
    // error/ready binary made the polling UI unreachable).
    expect(harnessStatusPatch({
      data: {
        type: codex,
        status: "configured",
        ready: false,
      },
    })).toMatchObject({
      harnessMode: "harness",
      harness: codex,
      readiness: "polling",
    })
    expect(harnessStatusPatch({
      data: {
        type: codex,
        status: "applying",
        ready: false,
      },
    })).toMatchObject({ readiness: "polling" })

    // A hard failure (status "error" or an error message) stays "error".
    expect(harnessStatusPatch({
      data: { type: codex, status: "error" },
    })).toMatchObject({ readiness: "error" })
    expect(harnessStatusPatch({
      data: { type: codex, error: "spawn failed", ready: false },
    })).toMatchObject({ readiness: "error" })

    // `settled: true` marks a COMPLETED switch response (not a startup/in-flight
    // probe). A completed response that still reports ready:false is a definitive
    // failure — the harness finished configuring and came back unavailable — so
    // it is "error", not "polling". This is the harness-switcher applyPostedStatus
    // path (core-harness-ownership-local, harness-switcher.test.ts:144).
    expect(harnessStatusPatch({
      data: { type: codex, status: "configured", ready: false },
      settled: true,
    })).toMatchObject({ readiness: "error" })
    // Without `settled`, the same frame is an in-flight probe → still "polling".
    expect(harnessStatusPatch({
      data: { type: codex, status: "configured", ready: false },
    })).toMatchObject({ readiness: "polling" })
    // A settled ready:true response is still "ready".
    expect(harnessStatusPatch({
      data: { type: codex, status: "ready", ready: true },
      settled: true,
    })).toMatchObject({ readiness: "ready" })

    // A ready harness is ready.
    expect(harnessStatusPatch({
      data: { type: codex, status: "ready", ready: true },
    })).toMatchObject({ readiness: "ready" })

    // A live-but-degraded harness (`/api/wr/health` reports ok:true while
    // harnessHealth.status is degraded/unavailable — process lost + recovering)
    // maps to the "degraded" readiness that drives the composer health peek +
    // Send gate (T4). This finally exercises the union member at selection.ts:9.
    expect(harnessStatusPatch({
      data: { type: codex, status: "ready", ready: true, harnessHealth: { status: "degraded", reason: "harness_process_lost" } },
    })).toMatchObject({ harness: codex, readiness: "degraded" })
    expect(harnessStatusPatch({
      data: { type: codex, status: "ready", ready: true, harnessHealth: { status: "unavailable" } },
    })).toMatchObject({ readiness: "degraded" })
    // A healthy harnessHealth report does not degrade a ready harness.
    expect(harnessStatusPatch({
      data: { type: codex, status: "ready", ready: true, harnessHealth: { status: "ok" } },
    })).toMatchObject({ readiness: "ready" })
    // A hard failure still wins over degraded health.
    expect(harnessStatusPatch({
      data: { type: codex, status: "error", harnessHealth: { status: "degraded" } },
    })).toMatchObject({ readiness: "error" })
    // Connection-backed harnesses use the same health contract as native SDKs.
    expect(harnessStatusPatch({
      data: { type: openCode, ready: true, harnessHealth: { status: "degraded" } },
    })).toMatchObject({ harnessMode: "harness", readiness: "degraded" })
  })

  test("derives the standing health-probe readiness transition (T4)", () => {
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
    expect(readyHarnessHydrationPatch("acp:claude")).toEqual({
      harnessMode: "harness",
      readiness: "ready",
    })
    expect(readyHarnessHydrationPatch(pi)).toEqual({
      harness: pi,
      harnessMode: "harness",
      readiness: "ready",
      dynamicModels: null,
      thoughtLevels: null,
      selectedThoughtLevel: undefined,
      optionsSource: "empty",
      optionsStale: false,
      optionsLoading: false,
    })
    expect(pollingHarnessHydrationPatch("acp:claude")).toEqual({
      harness: "acp:claude",
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
      type: "acp:claude",
    })).toMatchObject({
      harness: "acp:claude",
      harnessMode: "harness",
      selectedModel: "",
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
