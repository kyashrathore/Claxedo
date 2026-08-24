import { describe, expect, test } from "bun:test"
import { FLOWS } from "../src/flows"
import { fileContent, fixtureFor } from "../src/browser-runner"
import {
  HEAVY_WORKSPACE_CLOSE_DWELL_MS,
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  heavyWorkspaceReviewRestorationFailures,
  heavyWorkspaceRestorationFailures,
} from "../src/heavy-workspace-reopen-contract"
import { seedForScenario } from "../src/seed"

describe("heavy workspace reopen benchmark contract", () => {
  test("uses a substantial review corpus, several file tabs, and an actual post-motion close dwell", () => {
    const seed = seedForScenario("heavy-workspace-reopen")

    expect(FLOWS.some((flow) => flow.id === "heavy-workspace-reopen")).toBe(true)
    expect(seed.changed_files).toBe(500)
    expect(seed.terminals).toBeGreaterThanOrEqual(3)
    expect(HEAVY_WORKSPACE_REOPEN_FILE_PATHS).toHaveLength(3)
    expect(new Set(HEAVY_WORKSPACE_REOPEN_FILE_PATHS).size).toBe(3)
    expect(HEAVY_WORKSPACE_CLOSE_DWELL_MS).toBeGreaterThan(140)

    const fixture = fixtureFor("heavy-workspace-reopen", seed)
    expect(fileContent(new URL("http://perf/file/content?path=src/generated/file-113.ts"), fixture)).toEqual({
      type: "text",
      content: "export const perfFile = \"src/generated/file-113.ts\"\n",
    })
  })

  test("requires exact tab order, active selection, navigator, and review-tab identity without requiring inactive review DOM", () => {
    const before = {
      openTabIds: ["review", "file://src/a.ts", "file://src/b.ts"],
      activeTabId: "file://src/b.ts",
      selectedFilePath: "src/b.ts",
      navigatorMode: "files",
      reviewTabId: "review",
    }

    expect(heavyWorkspaceRestorationFailures(before, { ...before })).toEqual([])
    expect(heavyWorkspaceRestorationFailures(before, {
      ...before,
      openTabIds: ["review", "file://src/b.ts", "file://src/a.ts"],
      activeTabId: "file://src/a.ts",
      selectedFilePath: "src/a.ts",
      navigatorMode: "changes",
      reviewTabId: "review-v2",
    })).toEqual([
      expect.stringContaining("workspace tabs changed"),
      expect.stringContaining("active workspace tab changed"),
      expect.stringContaining("workspace file selection changed"),
      expect.stringContaining("workspace navigator changed"),
      expect.stringContaining("review workspace tab changed"),
    ])
  })

  test("checks rich review state only when the review tab is activated", () => {
    const before = {
      diffStyle: "split",
      expandedPaths: ["src/generated/file-0.ts"],
      reviewFileCount: 75,
    }

    expect(heavyWorkspaceReviewRestorationFailures(before, { ...before })).toEqual([])
    expect(heavyWorkspaceReviewRestorationFailures(before, {
      diffStyle: "unified",
      expandedPaths: [],
      reviewFileCount: 8,
    })).toEqual([
      expect.stringContaining("review diff style changed"),
      expect.stringContaining("expanded review diffs changed"),
      expect.stringContaining("review corpus regressed after activation"),
    ])
  })
})
