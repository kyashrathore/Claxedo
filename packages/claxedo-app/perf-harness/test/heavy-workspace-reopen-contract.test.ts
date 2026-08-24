import { describe, expect, test } from "bun:test"
import { FLOWS } from "../src/flows"
import { fileContent, fixtureFor } from "../src/browser-runner"
import {
  HEAVY_WORKSPACE_CLOSE_DWELL_MS,
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
  HEAVY_WORKSPACE_FILE_MIN_CHARS,
  HEAVY_WORKSPACE_FILE_LINES,
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  heavyWorkspaceClosedOwnershipFailures,
  heavyWorkspaceInactiveFileOwnershipFailures,
  heavyWorkspaceInactiveReviewOwnershipFailures,
  heavyWorkspaceLiveFileFailures,
  heavyWorkspaceReviewRestorationFailures,
  heavyWorkspaceRestorationFailures,
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
    expect(heavyWorkspaceInactiveFileOwnershipFailures({ fileRoots: 3 })).toEqual([
      expect.stringContaining("inactive file roots"),
    ])
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
})
