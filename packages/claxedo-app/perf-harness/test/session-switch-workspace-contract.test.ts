import { describe, expect, test } from "bun:test"
import { FLOWS } from "../src/flows"
import { fileContent, fixtureFor } from "../src/browser-runner"
import { HEAVY_WORKSPACE_FILE_LINES } from "../src/heavy-workspace-reopen-contract"
import { seedForScenario } from "../src/seed"
import {
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
      oldWorkspaceDisposedMs: 120,
      destinationWorkspaceReadyMs: 600,
      timedOut: false,
    })).toEqual([])
    expect(crossWorkspaceSwitchClockFailures("cell", { timedOut: true })).toEqual([
      expect.stringContaining("destination session never became ready"),
      expect.stringContaining("old workspace surface was never disposed"),
      expect.stringContaining("destination workspace never rendered"),
    ])
  })

  test("the workspace-open penalty is a first-class derived metric per cell", () => {
    expect(workspaceOpenPenaltyMs({ openMs: 480.128, closedMs: 300 })).toBe(180.13)
    expect(workspaceOpenPenaltyMs({ openMs: 250, closedMs: 300 })).toBe(-50)
    expect(sessionSwitchPenaltyMetricName("open_file", "within", "cold")).toBe("session_switch_penalty_open_file_within_cold_ms")
    expect(sessionSwitchPenaltyMetricName("open_review", "across", "warm")).toBe("session_switch_penalty_open_review_across_warm_ms")
    expect(sessionSwitchCellPrefix("closed", "across", "cold")).toBe("session_switch_closed_across_cold")
  })
})
