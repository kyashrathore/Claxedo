import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FLOWS } from "../src/flows"
import { fileContent, fixtureFor } from "../src/browser-runner"
import { HEAVY_WORKSPACE_FILE_LINES } from "../src/heavy-workspace-reopen-contract"
import { seedForScenario } from "../src/seed"
import {
  OLD_WORKSPACE_RELEASE_BUDGET_MS,
  RETAINED_PANEL_BODY_HOST_SELECTOR,
  RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  crossWorkspaceSwitchClockFailures,
  sameWorkspaceSwitchStabilityFailures,
  sessionSwitchCellPrefix,
  sessionSwitchPenaltyMetricName,
  stabilityRequestClass,
  workspaceOpenPenaltyMs,
} from "../src/session-switch-workspace-contract"

const zeroRequests = { vcs: 0, file: 0, workspace: 0, sse: 0 }

describe("session switch with workspace benchmark contract", () => {
  test("fixture spans two workspaces with sessions in each, plus a substantial file", () => {
    expect(FLOWS.some((flow) => flow.id === "session-switch-workspace")).toBe(true)
    const seed = seedForScenario("session-switch-workspace")
    expect(seed.projects).toBe(2)
    expect(seed.sessions).toBe(8)
    expect(seed.changed_files).toBe(500)
    const fixture = fixtureFor("session-switch-workspace", seed)
    expect(fixture.workspaceDirectories).toHaveLength(2)
    expect(new Set(fixture.workspaceDirectories).size).toBe(2)
    const byDirectory = Map.groupBy(fixture.sessions, (session) => session.directory)
    expect(byDirectory.size).toBe(2)
    for (const directory of fixture.workspaceDirectories) {
      expect((byDirectory.get(directory) ?? []).length).toBeGreaterThanOrEqual(3)
    }
    const file = fileContent(new URL(`http://perf/file/content?path=${SESSION_SWITCH_SUBSTANTIAL_FILE_PATH}`), fixture)
    expect(file.content.split("\n")).toHaveLength(HEAVY_WORKSPACE_FILE_LINES + 1)
  })

  test("stability request classification matches the mocked route surface", () => {
    expect(stabilityRequestClass("/api/wr/diff/vcs")).toBe("vcs")
    expect(stabilityRequestClass("/api/claxedo/diff/vcs/file")).toBe("vcs")
    expect(stabilityRequestClass("/vcs/status")).toBe("vcs")
    expect(stabilityRequestClass("/file/content")).toBe("file")
    expect(stabilityRequestClass("/find/file")).toBe("file")
    expect(stabilityRequestClass("/api/workspace/resolve")).toBe("workspace")
    expect(stabilityRequestClass("/api/claxedo/workspace/resolve")).toBe("workspace")
    expect(stabilityRequestClass("/worktree")).toBe("workspace")
    expect(stabilityRequestClass("/event")).toBe("sse")
    expect(stabilityRequestClass("/api/wr/events")).toBe("sse")
    // Session data itself is NOT a stability class: a cold session switch
    // legitimately fetches its messages.
    expect(stabilityRequestClass("/session/ses_1/message")).toBeUndefined()
    expect(stabilityRequestClass("/session/ses_1/config")).toBeUndefined()
  })

  test("same-workspace stability gate fails on remounts, refetches, and review recomputation — not on background SSE", () => {
    expect(sameWorkspaceSwitchStabilityFailures("cell", {
      shellTokenPreserved: true,
      contentTokenPreserved: true,
      requestDelta: { ...zeroRequests, sse: 1 },
      reviewRenderedFilesChurn: 0,
    })).toEqual([])
    expect(sameWorkspaceSwitchStabilityFailures("cell", {
      shellTokenPreserved: false,
      contentTokenPreserved: false,
      requestDelta: { vcs: 1, file: 2, workspace: 1, sse: 0 },
      reviewRenderedFilesChurn: 3,
    })).toEqual([
      expect.stringContaining("remounted the workspace panel shell"),
      expect.stringContaining("remounted the open workspace content"),
      expect.stringContaining("1 vcs requests"),
      expect.stringContaining("2 file requests"),
      expect.stringContaining("1 workspace requests"),
      expect.stringContaining("recomputed the review"),
    ])
    // Closed-block cells have no surface to token-check; that is not a pass
    // of the token gate, just its absence.
    expect(sameWorkspaceSwitchStabilityFailures("cell", { requestDelta: zeroRequests })).toEqual([])
  })

  test("cross-workspace switches fail when any independent clock never resolves", () => {
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 12,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: 600,
      timedOut: false,
    })).toEqual([])
    expect(crossWorkspaceSwitchClockFailures("cell", { timedOut: true })).toEqual([
      expect.stringContaining("destination session never became ready"),
      expect.stringContaining("destination workspace never rendered"),
      expect.stringContaining("neither disposed nor made inert"),
    ])
  })

  test("a retained old workspace surface releases the switch only when it is provably inert", () => {
    // Retention is a first-class outcome: the old body may stay constructed so
    // a return switch is a display flip, provided it is proved harmless. A
    // retaining panel resolves both clocks on the same frame.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 65.5,
      oldWorkspaceRelease: "retained-inert",
      destinationWorkspaceReadyMs: 65.5,
      timedOut: false,
    })).toEqual([])
    // A disposing panel releases the old surface long before it has rebuilt
    // the destination, and that is still a pass.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 44.5,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: 337.4,
      timedOut: false,
    })).toEqual([])
    // A surface that is still connected AND still the displayed one never
    // reports a release at all, and that is a hard failure — not a slow one.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 300,
      destinationWorkspaceReadyMs: 40,
      timedOut: false,
    })).toEqual([expect.stringContaining("neither disposed nor made inert")])
  })

  test("the destination workspace may not be presented while the old surface is still the user's", () => {
    // The failure mode a stopwatch cannot separate from a slow first frame:
    // the panel holds the flip behind its settle gate, so the destination
    // reads ready while what is actually on screen is the workspace the user
    // left. Ordering catches it; both clocks come off the same tick loop.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 33.4,
      oldWorkspaceReleasedMs: 126.9,
      oldWorkspaceRelease: "retained-inert",
      destinationWorkspaceReadyMs: 34.7,
      timedOut: false,
    })).toEqual([
      expect.stringContaining("presented the destination workspace at 34.7ms while the old workspace surface was still the user's (released 126.9ms, retained-inert)"),
    ])
    // The coarse backstop still fires on a release that waited for the
    // destination to be built, and reports which outcome was late.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 40,
      oldWorkspaceReleasedMs: OLD_WORKSPACE_RELEASE_BUDGET_MS + 0.5,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: OLD_WORKSPACE_RELEASE_BUDGET_MS + 10,
      timedOut: false,
    })).toEqual([
      expect.stringContaining(`released the old workspace surface after ${OLD_WORKSPACE_RELEASE_BUDGET_MS + 0.5}ms (disposed); backstop ${OLD_WORKSPACE_RELEASE_BUDGET_MS}ms`),
    ])
    // Exactly at the backstop, and in order, still passes.
    expect(crossWorkspaceSwitchClockFailures("cell", {
      sessionReadyMs: 40,
      oldWorkspaceReleasedMs: OLD_WORKSPACE_RELEASE_BUDGET_MS,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: OLD_WORKSPACE_RELEASE_BUDGET_MS,
      timedOut: false,
    })).toEqual([])
  })

  test("the retained-inert reader's markers are owned by the contract, not by the driver", () => {
    // The driver and the probe both build their in-page reader out of these,
    // and the panel stamps them. One owner, three readers.
    expect(RETAINED_PANEL_BODY_HOST_SELECTOR).toBe("[data-testid='workspace-panel-body']")
    expect(RETAINED_PANEL_BODY_INERT_ATTRIBUTE).toBe("data-panel-body-inert")
    const panel = readFileSync(
      new URL("../../src/features/workspaces/ui/panel/workspace-panel.tsx", import.meta.url),
      "utf8",
    )
    const hostTestId = RETAINED_PANEL_BODY_HOST_SELECTOR.slice("[data-testid='".length, -"']".length)
    // Booleans, not the file: a mismatch here should name the marker, not print the panel.
    expect({
      stampsHost: panel.includes(`data-testid="${hostTestId}"`),
      stampsInertMarker: panel.includes(RETAINED_PANEL_BODY_INERT_ATTRIBUTE),
    }).toEqual({ stampsHost: true, stampsInertMarker: true })
  })

  test("the workspace-open penalty is a first-class derived metric per cell", () => {
    expect(workspaceOpenPenaltyMs({ openMs: 480.128, closedMs: 300 })).toBe(180.13)
    expect(workspaceOpenPenaltyMs({ openMs: 250, closedMs: 300 })).toBe(-50)
    expect(sessionSwitchPenaltyMetricName("open_file", "within", "cold")).toBe("session_switch_penalty_open_file_within_cold_ms")
    expect(sessionSwitchPenaltyMetricName("open_review", "across", "warm")).toBe("session_switch_penalty_open_review_across_warm_ms")
    expect(sessionSwitchCellPrefix("closed", "across", "cold")).toBe("session_switch_closed_across_cold")
  })
})
