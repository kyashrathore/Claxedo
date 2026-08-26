import { describe, expect, test } from "bun:test"
import {
  WORKSPACE_PANEL_CLOSE_GRACE_MS,
  WORKSPACE_PANEL_MOTION_MS,
} from "../../src/features/workspaces/ui/panel/workspace-panel-lifecycle"
import { FLOWS } from "../src/flows"
import { fixtureFor } from "../src/browser-runner"
import { seedForScenario } from "../src/seed"
import {
  WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS,
  WORKSPACE_LIFECYCLE_CLOSE_GRACE_MS,
  WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN,
  WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS,
  WORKSPACE_LIFECYCLE_MOTION_MS,
  workspaceLifecycleAboveFoldFailures,
  workspaceLifecycleColdOpenFailures,
  workspaceLifecycleInterruptionFailures,
  workspaceLifecycleWarmReopenFailures,
} from "../src/workspace-lifecycle-contract"
import { WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES } from "../src/workspace-interactions-contract"

describe("workspace lifecycle benchmark contract", () => {
  test("derives its timing constants from the app's shipped motion", () => {
    expect(FLOWS.some((flow) => flow.id === "workspace-lifecycle")).toBe(true)
    expect(WORKSPACE_LIFECYCLE_MOTION_MS).toBe(WORKSPACE_PANEL_MOTION_MS)
    expect(WORKSPACE_LIFECYCLE_CLOSE_GRACE_MS).toBe(WORKSPACE_PANEL_CLOSE_GRACE_MS)
    // The interruption click must land strictly inside the motion.
    expect(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS).toBeGreaterThan(0)
    expect(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS).toBeLessThan(WORKSPACE_PANEL_MOTION_MS)
    // The ownership dwell must be past the close grace (the exposure boundary).
    expect(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS).toBeGreaterThan(WORKSPACE_PANEL_CLOSE_GRACE_MS)
    expect(WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN.test("http://127.0.0.1:34615/api/wr/diff/vcs?content=summary")).toBe(true)
    expect(WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN.test("http://127.0.0.1:34615/api/wr/diff/vcs/file?file=a.ts")).toBe(false)
  })

  test("seeds a substantial review corpus with a weighty first diff", () => {
    const seed = seedForScenario("workspace-lifecycle")
    expect(seed.changed_files).toBe(500)
    const fixture = fixtureFor("workspace-lifecycle", seed)
    expect(fixture.changedFiles).toHaveLength(500)
    expect(fixture.changedFiles[0]!.additions).toBe(WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES)
    expect(fixture.changedFiles[0]!.patch.length).toBeGreaterThan(10_000)
  })

  test("cold open fails when the fetch never starts, data never arrives, or content never renders", () => {
    const sound = {
      completionMs: 900,
      acknowledgedMs: 20,
      timedOut: false,
      shellSettledMs: 180,
      clickToFetchStartMs: 12,
      fetchStartToDataMs: 40,
      dataToAboveFoldMs: 300,
    }
    expect(workspaceLifecycleColdOpenFailures(sound)).toEqual([])
    expect(workspaceLifecycleColdOpenFailures({ ...sound, clickToFetchStartMs: undefined, fetchStartToDataMs: undefined }))
      .toEqual([expect.stringContaining("never started its VCS changed-files fetch")])
    expect(workspaceLifecycleColdOpenFailures({ ...sound, clickToFetchStartMs: -120 }))
      .toEqual([expect.stringContaining("BEFORE the opening click")])
    expect(workspaceLifecycleColdOpenFailures({ ...sound, fetchStartToDataMs: undefined }))
      .toEqual([expect.stringContaining("data never arrived")])
    expect(workspaceLifecycleColdOpenFailures({ ...sound, shellSettledMs: undefined }))
      .toEqual([expect.stringContaining("settled panel shell")])
    expect(workspaceLifecycleColdOpenFailures({ ...sound, dataToAboveFoldMs: undefined }))
      .toEqual([expect.stringContaining("above-fold")])
  })

  test("interruption phases fail when the click lands outside the motion or the surface never recovers", () => {
    const sound = {
      completionMs: 220,
      acknowledgedMs: 10,
      timedOut: false,
      interruptOffsetMs: WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS + 12,
      recovered: true,
    }
    expect(workspaceLifecycleInterruptionFailures("phase", sound)).toEqual([])
    expect(workspaceLifecycleInterruptionFailures("phase", { ...sound, interruptOffsetMs: undefined }))
      .toEqual([expect.stringContaining("was not observed")])
    expect(workspaceLifecycleInterruptionFailures("phase", { ...sound, interruptOffsetMs: WORKSPACE_LIFECYCLE_MOTION_MS + 40 }))
      .toEqual([expect.stringContaining("outside the")])
    expect(workspaceLifecycleInterruptionFailures("phase", { ...sound, recovered: false }))
      .toEqual([expect.stringContaining("did not recover")])
  })

  test("warm reopen fails without a settled shell or without its warm content", () => {
    const sound = { completionMs: 400, acknowledgedMs: 10, timedOut: false, shellSettledMs: 150, contentReadyMs: 320 }
    expect(workspaceLifecycleWarmReopenFailures(sound)).toEqual([])
    expect(workspaceLifecycleWarmReopenFailures({ ...sound, shellSettledMs: undefined }))
      .toEqual([expect.stringContaining("settled panel shell")])
    expect(workspaceLifecycleWarmReopenFailures({ ...sound, contentReadyMs: undefined }))
      .toEqual([expect.stringContaining("warm review content")])
  })

  test("above-fold gate fails on zero rows, a truncated model, or a pending surface", () => {
    expect(workspaceLifecycleAboveFoldFailures({ reviewFileRows: 18, totalFiles: 500, pending: false }, 500)).toEqual([])
    expect(workspaceLifecycleAboveFoldFailures({ reviewFileRows: 0, totalFiles: 500, pending: false }, 500))
      .toEqual([expect.stringContaining("no file rows")])
    expect(workspaceLifecycleAboveFoldFailures({ reviewFileRows: 18, totalFiles: 262, pending: false }, 500))
      .toEqual([expect.stringContaining("held 262 files; expected 500")])
    expect(workspaceLifecycleAboveFoldFailures({ reviewFileRows: 18, totalFiles: 500, pending: true }, 500))
      .toEqual([expect.stringContaining("pending surface")])
  })
})
