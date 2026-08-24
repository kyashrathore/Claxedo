import { describe, expect, test } from "bun:test"
import { FLOWS } from "../src/flows"
import { benchmarkViewport, fileContent, fixtureFor } from "../src/browser-runner"
import {
  REVIEW_ESTIMATED_ROW_HEIGHT,
  reviewWindowRowBudget,
} from "../../src/features/review/ui/review-window"
import {
  HEAVY_WORKSPACE_CLOSE_DWELL_MS,
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
  HEAVY_WORKSPACE_FILE_MIN_CHARS,
  HEAVY_WORKSPACE_FILE_LINES,
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  HEAVY_WORKSPACE_REVIEW_OVERSCAN,
  HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  HEAVY_WORKSPACE_REVIEW_MEASURED_ROW_HEIGHT_PX,
  HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS,
  HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK,
  HEAVY_WORKSPACE_VIEWPORT_HEIGHT,
  heavyWorkspaceClosedOwnershipFailures,
  heavyWorkspaceExpansionRetentionFailures,
  heavyWorkspaceInactiveFileOwnershipFailures,
  heavyWorkspaceInactiveReviewOwnershipFailures,
  heavyWorkspaceWindowedCorpusFailures,
  heavyWorkspaceLiveFileFailures,
  heavyWorkspaceReviewRestorationFailures,
  heavyWorkspaceRestorationFailures,
  heavyWorkspaceSetupScrollFailures,
} from "../src/heavy-workspace-reopen-contract"
import { seedForScenario } from "../src/seed"

describe("heavy workspace reopen benchmark contract", () => {
  test("uses a substantial review corpus, several file tabs, and an actual post-motion close dwell", () => {
    const seed = seedForScenario("heavy-workspace-reopen")

    expect(FLOWS.some((flow) => flow.id === "heavy-workspace-reopen")).toBe(true)
    expect(FLOWS.some((flow) => flow.id === "heavy-workspace-review-resume")).toBe(true)
    expect(FLOWS.some((flow) => flow.id === "heavy-workspace-close")).toBe(true)
    expect(seed.changed_files).toBe(500)
    expect(seed.terminals).toBeGreaterThanOrEqual(3)
    expect(HEAVY_WORKSPACE_REOPEN_FILE_PATHS).toHaveLength(3)
    expect(new Set(HEAVY_WORKSPACE_REOPEN_FILE_PATHS).size).toBe(3)
    expect(HEAVY_WORKSPACE_CLOSE_DWELL_MS).toBeGreaterThan(140)
    expect(HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR).toContain("[data-scrollable]")

    const expanded = fixtureFor("heavy-workspace-reopen", seed).changedFiles[0]!
    expect(expanded.additions).toBe(HEAVY_WORKSPACE_EXPANDED_DIFF_LINES)
    expect(expanded.deletions).toBe(HEAVY_WORKSPACE_EXPANDED_DIFF_LINES)
    expect(expanded.patch.split("\n")).toHaveLength(HEAVY_WORKSPACE_EXPANDED_DIFF_LINES * 2 + 1)
    expect(expanded.patch.length).toBeGreaterThan(10_000)

    const fixture = fixtureFor("heavy-workspace-reopen", seed)
    const file = fileContent(new URL("http://perf/file/content?path=src/generated/file-113.ts"), fixture)
    expect(file.type).toBe("text")
    expect(file.content.split("\n")).toHaveLength(HEAVY_WORKSPACE_FILE_LINES + 1)
    expect(file.content.length).toBeGreaterThan(10_000)
  })

  test("requires exact tab order, active selection, navigator, and review-tab identity without requiring inactive review DOM", () => {
    const before = {
      openTabIds: ["review", "file://src/a.ts", "file://src/b.ts"],
      activeTabId: "file://src/b.ts",
      selectedFilePath: "src/b.ts",
      selectedFileChars: 12_000,
      selectedFileLines: HEAVY_WORKSPACE_FILE_LINES,
      navigatorMode: "files",
      reviewTabId: "review",
    }

    expect(heavyWorkspaceRestorationFailures(before, { ...before })).toEqual([])
    expect(heavyWorkspaceLiveFileFailures(before)).toEqual([])
    expect(heavyWorkspaceLiveFileFailures({
      ...before,
      selectedFileChars: HEAVY_WORKSPACE_FILE_MIN_CHARS - 1,
      selectedFileLines: HEAVY_WORKSPACE_FILE_LINES - 1,
    })).toEqual([
      expect.stringContaining("expected 320"),
      expect.stringContaining(`at least ${HEAVY_WORKSPACE_FILE_MIN_CHARS}`),
    ])
    expect(heavyWorkspaceRestorationFailures(before, {
      ...before,
      openTabIds: ["review", "file://src/b.ts", "file://src/a.ts"],
      activeTabId: "file://src/a.ts",
      selectedFilePath: "src/a.ts",
      selectedFileChars: 12,
      selectedFileLines: 1,
      navigatorMode: "changes",
      reviewTabId: "review-v2",
    })).toEqual([
      expect.stringContaining("workspace tabs changed"),
      expect.stringContaining("active workspace tab changed"),
      expect.stringContaining("workspace file selection changed"),
      expect.stringContaining("workspace file content changed"),
      expect.stringContaining("workspace navigator changed"),
      expect.stringContaining("review workspace tab changed"),
    ])
  })

  test("can require absolute zero ownership only for the disposal candidate", () => {
    expect(heavyWorkspaceClosedOwnershipFailures({
      shells: 0,
      tabs: 0,
      fileRoots: 0,
      navigators: 0,
      reviewRoots: 0,
      reviewFiles: 0,
    })).toEqual([])
    expect(heavyWorkspaceClosedOwnershipFailures({
      shells: 1,
      tabs: 4,
      fileRoots: 3,
      navigators: 1,
      reviewRoots: 1,
      reviewFiles: 500,
    })).toHaveLength(6)

    expect(heavyWorkspaceInactiveReviewOwnershipFailures({ roots: 0, files: 0, fileRoots: 1 })).toEqual([])
    expect(heavyWorkspaceInactiveReviewOwnershipFailures({ roots: 1, files: 500, fileRoots: 3 })).toHaveLength(3)
    expect(heavyWorkspaceInactiveFileOwnershipFailures({ fileRoots: 0 })).toEqual([])
    expect(heavyWorkspaceWindowedCorpusFailures({ reviewFileCount: 18, totalFileCount: 500, expectedTotal: 500 }))
      .toEqual([])
    expect(heavyWorkspaceWindowedCorpusFailures({ reviewFileCount: 0, totalFileCount: 500, expectedTotal: 500 }))
      .toEqual(["review window materialized no file rows"])
    expect(heavyWorkspaceWindowedCorpusFailures({ reviewFileCount: 500, totalFileCount: 500, expectedTotal: 500 }))
      .toEqual(["review window materialized 500 file rows; expected at most 44"])
    expect(heavyWorkspaceWindowedCorpusFailures({ reviewFileCount: 18, totalFileCount: 262, expectedTotal: 500 }))
      .toEqual(["review model held 262 files; expected 500"])
    expect(heavyWorkspaceInactiveFileOwnershipFailures({ fileRoots: 3 })).toEqual([
      expect.stringContaining("inactive file roots"),
    ])
  })

  test("derives the review window cap from the app's budget rule and the real benchmark viewport", () => {
    // The runner's browser window is the geometry the contract reasons from.
    expect(HEAVY_WORKSPACE_VIEWPORT_HEIGHT).toBe(benchmarkViewport.height)
    // One owner of the budget rule: the contract cap IS the app's derivation
    // for the benchmark viewport — pinned here to the concrete value so an
    // accidental formula change fails loudly instead of drifting the gate.
    // The window materializes rows intersecting the overscanned span at their
    // MEASURED height; benchmark rows render at ~30px, so the cap derives
    // from that height, not the 40px unmeasured-row estimate.
    expect(HEAVY_WORKSPACE_REVIEW_MEASURED_ROW_HEIGHT_PX).toBeLessThan(REVIEW_ESTIMATED_ROW_HEIGHT)
    expect(HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS).toBe(reviewWindowRowBudget({
      viewportHeight: benchmarkViewport.height,
      overscan: HEAVY_WORKSPACE_REVIEW_OVERSCAN,
      estimatedRowHeight: HEAVY_WORKSPACE_REVIEW_MEASURED_ROW_HEIGHT_PX,
    }))
    expect(HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS).toBe(40)
    expect(HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS + HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK).toBe(44)
  })

  test("fails when the expanded diff recorded before the deep scroll does not survive resume", () => {
    const expandedAtSetup = ["src/generated/file-0.ts"]

    // Retained: the row scrolled back into the window is still expanded.
    expect(heavyWorkspaceExpansionRetentionFailures({
      expandedAtSetup,
      expandedAfterResume: expandedAtSetup,
    })).toEqual([])
    // Lost: a resume that dropped the expansion must fail even though both
    // deep-window identity snapshots hold empty expansion arrays.
    expect(heavyWorkspaceExpansionRetentionFailures({
      expandedAtSetup,
      expandedAfterResume: [],
    })).toEqual([expect.stringContaining("expanded review diffs were lost across close/reopen")])
    // Vacuous pass is impossible: empty-vs-empty is itself a failure.
    expect(heavyWorkspaceExpansionRetentionFailures({
      expandedAtSetup: [],
      expandedAfterResume: [],
    })).toEqual([expect.stringContaining("no expanded review diff")])
  })

  test("checks rich review state only when the review tab is activated", () => {
    const before = {
      diffStyle: "split",
      expandedPaths: ["src/generated/file-0.ts"],
      expandedBodyPaths: ["src/generated/file-0.ts"],
      reviewFileCount: 500,
      totalFileCount: 500,
      renderedHunks: 1,
      scrollTop: 12_000,
      scrollAnchorPath: "src/generated/file-350.ts",
      scrollAnchorOffset: 0,
    }

    expect(heavyWorkspaceReviewRestorationFailures(before, { ...before })).toEqual([])
    expect(heavyWorkspaceReviewRestorationFailures(before, {
      diffStyle: "unified",
      expandedPaths: [],
      expandedBodyPaths: [],
      reviewFileCount: 8,
      totalFileCount: 500,
      renderedHunks: 0,
      scrollTop: 0,
      scrollAnchorPath: "src/generated/file-0.ts",
      scrollAnchorOffset: 24,
    })).toEqual([
      expect.stringContaining("review diff style changed"),
      expect.stringContaining("expanded review diffs changed"),
      expect.stringContaining("rendered expanded review bodies changed"),
      expect.stringContaining("review corpus changed after activation"),
      expect.stringContaining("rendered review hunks regressed"),
      expect.stringContaining("review scroll anchor changed"),
      expect.stringContaining("review scroll anchor offset changed"),
      expect.stringContaining("review deep scroll position was not restored"),
    ])
  })

  test("allows semantic anchor enrichment without allowing setup scroll movement", () => {
    const topOnly = { position: { top: 16_960 } }
    const anchored = {
      position: {
        top: 16_960,
        anchorPath: "src/generated/file-350.ts",
        anchorOffset: 0,
      },
    }

    expect(heavyWorkspaceSetupScrollFailures({
      before: topOnly,
      after: anchored,
      expectedAnchorPath: "src/generated/file-350.ts",
      stage: "while opening Files",
    })).toEqual([])
    expect(heavyWorkspaceSetupScrollFailures({
      before: anchored,
      after: { position: { top: 0, anchorPath: "src/generated/file-0.ts", anchorOffset: 0 } },
      expectedAnchorPath: "src/generated/file-350.ts",
      stage: "while opening file tabs",
    })).toEqual([
      expect.stringContaining("scroll moved"),
      expect.stringContaining("anchor changed"),
      expect.stringContaining("expected src/generated/file-350.ts"),
    ])
    expect(heavyWorkspaceSetupScrollFailures({
      before: undefined,
      after: anchored,
      expectedAnchorPath: "src/generated/file-350.ts",
      stage: "while opening Files",
    })).toEqual([expect.stringContaining("diagnostic was unavailable")])
  })
})
