import { describe, expect, test } from "bun:test"
import { FLOWS } from "../../flows"
import { fileContent, fixtureFor } from "../fixtures"
import { HEAVY_WORKSPACE_FILE_LINES } from "./heavy-workspace-reopen-contract"
import { seedForScenario } from "../../seed"
import {
  OLD_WORKSPACE_RELEASE_BUDGET_MS,
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  sessionSwitchClockFailures,
  sessionSwitchPanelTransition,
  sameWorkspaceSwitchStabilityFailures,
  sessionSwitchCellPrefix,
  sessionSwitchPenaltyMetricName,
  stabilityRequestClass,
  workspaceOpenPenaltyMs,
} from "./session-switch-workspace-contract"

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
    expect(stabilityRequestClass("/api/wr/file")).toBe("file")
    expect(stabilityRequestClass("/api/wr/file/status")).toBe("file")
    expect(stabilityRequestClass("/api/wr/file/content")).toBe("file")
    expect(stabilityRequestClass("/api/wr/find/file")).toBe("file")
    expect(stabilityRequestClass("/api/wr/file-other")).toBeUndefined()
    expect(stabilityRequestClass("/api/workspace/resolve")).toBe("workspace")
    expect(stabilityRequestClass("/api/claxedo/workspace/resolve")).toBe("workspace")
    expect(stabilityRequestClass("/worktree")).toBe("workspace")
    expect(stabilityRequestClass("/api/cp/events")).toBe("sse")
    expect(stabilityRequestClass("/api/wr/events")).toBe("sse")
    expect(stabilityRequestClass("/event")).toBeUndefined()
    // Session data itself is NOT a stability class: a cold session switch
    // legitimately fetches its messages.
    expect(stabilityRequestClass("/session/ses_1/message")).toBeUndefined()
    expect(stabilityRequestClass("/session/ses_1/config")).toBeUndefined()
  })

  test("same-workspace transitions reuse loaded resources while allowing intentional panel disposal", () => {
    expect(sameWorkspaceSwitchStabilityFailures("cell", { ...zeroRequests, sse: 1 })).toEqual([])
    expect(sameWorkspaceSwitchStabilityFailures("cell", { vcs: 1, file: 2, workspace: 1, sse: 0 })).toEqual([
      expect.stringContaining("1 vcs requests"),
      expect.stringContaining("2 file requests"),
      expect.stringContaining("1 workspace requests"),
    ])
  })

  test("cold first visits close the panel and warm returns restore the saved home presentation", () => {
    for (const [block, home] of [["closed", "closed"], ["open_file", "file"], ["open_review", "review"]] as const) {
      expect(sessionSwitchPanelTransition(block, "cold")).toEqual({ source: home, destination: "closed" })
      expect(sessionSwitchPanelTransition(block, "warm")).toEqual({ source: "closed", destination: home })
    }
    const cold = sessionSwitchPanelTransition("open_file", "cold")
    expect(sessionSwitchClockFailures("cold", cold, {
      sessionReadyMs: 100, destinationPanelClosedMs: 20,
      oldWorkspaceReleasedMs: 150, oldWorkspaceRelease: "disposed", timedOut: false,
    })).toEqual([])
    expect(sessionSwitchClockFailures("cold", cold, { sessionReadyMs: 100, timedOut: true })).toEqual([
      expect.stringContaining("did not keep its workspace panel closed"),
      expect.stringContaining("neither disposed nor made inert"),
    ])
    const warm = sessionSwitchPanelTransition("open_file", "warm")
    expect(sessionSwitchClockFailures("warm", warm, {
      sessionReadyMs: 100, destinationWorkspaceReadyMs: 200, timedOut: false,
    })).toEqual([])
    expect(sessionSwitchClockFailures("warm", warm, { sessionReadyMs: 100, timedOut: true })).toEqual([
      expect.stringContaining("never restored its saved file content"),
    ])
    expect(sessionSwitchClockFailures("closed", sessionSwitchPanelTransition("closed", "cold"), {
      sessionReadyMs: 100, destinationPanelClosedMs: 5, timedOut: false,
    })).toEqual([])
  })

  test("cross-workspace switches fail when any independent clock never resolves", () => {
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 12,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: 600,
      timedOut: false,
    })).toEqual([])
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, { timedOut: true })).toEqual([
      expect.stringContaining("destination session never became ready"),
      expect.stringContaining("destination workspace never restored"),
      expect.stringContaining("neither disposed nor made inert"),
    ])
  })

  test("a retained old workspace surface releases the switch only when it is provably inert", () => {
    // Retention is a first-class outcome: the old body may stay constructed so
    // a return switch is a display flip, provided it is proved harmless. A
    // retaining panel resolves both clocks on the same frame.
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 65.5,
      oldWorkspaceRelease: "retained-inert",
      destinationWorkspaceReadyMs: 65.5,
      timedOut: false,
    })).toEqual([])
    // A disposing panel releases the old surface long before it has rebuilt
    // the destination, and that is still a pass.
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
      sessionReadyMs: 300,
      oldWorkspaceReleasedMs: 44.5,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: 337.4,
      timedOut: false,
    })).toEqual([])
    // A surface that is still connected AND still the displayed one never
    // reports a release at all, and that is a hard failure — not a slow one.
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
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
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
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
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
      sessionReadyMs: 40,
      oldWorkspaceReleasedMs: OLD_WORKSPACE_RELEASE_BUDGET_MS + 0.5,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: OLD_WORKSPACE_RELEASE_BUDGET_MS + 10,
      timedOut: false,
    })).toEqual([
      expect.stringContaining(`released the old workspace surface after ${OLD_WORKSPACE_RELEASE_BUDGET_MS + 0.5}ms (disposed); backstop ${OLD_WORKSPACE_RELEASE_BUDGET_MS}ms`),
    ])
    // Exactly at the backstop, and in order, still passes.
    expect(sessionSwitchClockFailures("cell", { source: "review", destination: "review" }, {
      sessionReadyMs: 40,
      oldWorkspaceReleasedMs: OLD_WORKSPACE_RELEASE_BUDGET_MS,
      oldWorkspaceRelease: "disposed",
      destinationWorkspaceReadyMs: OLD_WORKSPACE_RELEASE_BUDGET_MS,
      timedOut: false,
    })).toEqual([])
  })

  test("the workspace-open penalty is a first-class derived metric per cell", () => {
    expect(workspaceOpenPenaltyMs({ openMs: 480.128, closedMs: 300 })).toBe(180.13)
    expect(workspaceOpenPenaltyMs({ openMs: 250, closedMs: 300 })).toBe(-50)
    expect(sessionSwitchPenaltyMetricName("open_file", "within", "cold")).toBe("session_switch_penalty_open_file_within_cold_ms")
    expect(sessionSwitchPenaltyMetricName("open_review", "across", "warm")).toBe("session_switch_penalty_open_review_across_warm_ms")
    expect(sessionSwitchCellPrefix("closed", "across", "cold")).toBe("session_switch_closed_across_cold")
  })
})
