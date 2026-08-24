import { describe, expect, test } from "bun:test"
import { FLOWS } from "../src/flows"
import { fileContent, fixtureFor } from "../src/browser-runner"
import {
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
  HEAVY_WORKSPACE_FILE_LINES,
} from "../src/heavy-workspace-reopen-contract"
import { seedForScenario } from "../src/seed"
import { MAX_DIFF_CHANGED_LINES } from "../../src/features/review/ui/review-session-logic"
import {
  WORKSPACE_INTERACTIONS_DIFF_RENDER_CEILING,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES,
  WORKSPACE_INTERACTIONS_FILE_LINES,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_CHANGED_LINES,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES,
  WORKSPACE_INTERACTIONS_LARGE_FILE_LINES,
  WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
  WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
  WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX,
  workspaceInteractionCollapseFailures,
  workspaceInteractionDiffStyleFailures,
  workspaceInteractionExpandFailures,
  workspaceInteractionLargeDiffGuardFailures,
  workspaceInteractionNavigatorFailures,
  workspaceInteractionResizeFailures,
  workspaceInteractionTabDeltaFailures,
  workspaceInteractionTabSwitchFailures,
} from "../src/workspace-interactions-contract"

describe("workspace interactions benchmark contract", () => {
  test("large fixtures are much larger than the median and formula-derived from the heavy baseline", () => {
    expect(FLOWS.some((flow) => flow.id === "workspace-interactions")).toBe(true)
    expect(WORKSPACE_INTERACTIONS_FILE_LINES).toBe(HEAVY_WORKSPACE_FILE_LINES)
    expect(WORKSPACE_INTERACTIONS_LARGE_FILE_LINES).toBe(HEAVY_WORKSPACE_FILE_LINES * 10)
    expect(WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES).toBe(HEAVY_WORKSPACE_EXPANDED_DIFF_LINES)
    expect(WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES).toBe(HEAVY_WORKSPACE_EXPANDED_DIFF_LINES * 5)
    // The generic fixture rows carry (index % 9) + 1 additions — median 5 —
    // so the large diff is orders of magnitude above the median row.
    expect(WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES).toBeGreaterThan(5 * 100)
    // The measurement design depends on which side of the app's render
    // ceiling each diff sits: the standard expand target renders directly,
    // the large diff hits the guard pane and needs the "render anyway" force.
    // Pinned so a ceiling or fixture change fails loudly instead of silently
    // changing what the two interactions measure.
    expect(WORKSPACE_INTERACTIONS_DIFF_RENDER_CEILING).toBe(MAX_DIFF_CHANGED_LINES)
    expect(WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES * 2).toBeLessThanOrEqual(WORKSPACE_INTERACTIONS_DIFF_RENDER_CEILING)
    expect(WORKSPACE_INTERACTIONS_LARGE_DIFF_CHANGED_LINES).toBe(WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES * 2)
    expect(WORKSPACE_INTERACTIONS_LARGE_DIFF_CHANGED_LINES).toBeGreaterThan(WORKSPACE_INTERACTIONS_DIFF_RENDER_CEILING)

    const seed = seedForScenario("workspace-interactions")
    expect(seed.changed_files).toBe(500)
    const fixture = fixtureFor("workspace-interactions", seed)
    expect(fixture.changedFiles[WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX]!.additions)
      .toBe(WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES)
    expect(fixture.changedFiles[WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX]!.additions)
      .toBe(WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES)
    expect(fixture.changedFiles[WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX]!.patch.split("\n"))
      .toHaveLength(WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES * 2 + 1)

    const largeFile = fileContent(
      new URL(`http://perf/file/content?path=${WORKSPACE_INTERACTIONS_LARGE_FILE_PATH}`),
      fixture,
    )
    expect(largeFile.content.split("\n")).toHaveLength(WORKSPACE_INTERACTIONS_LARGE_FILE_LINES + 1)
    for (const path of [...WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS, WORKSPACE_INTERACTIONS_OPEN_FILE_PATH]) {
      const file = fileContent(new URL(`http://perf/file/content?path=${path}`), fixture)
      expect(file.content.split("\n")).toHaveLength(WORKSPACE_INTERACTIONS_FILE_LINES + 1)
    }
    // Distinct measured surfaces: no path is reused between roles.
    const paths = [
      ...WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
      WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
      WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
    ]
    expect(new Set(paths).size).toBe(paths.length)
  })

  test("tab switches fail when the open-tab set changes or the wrong tab activates", () => {
    const before = { openTabIds: ["review", "t-a", "t-b"], activeTabId: "t-b" }
    expect(workspaceInteractionTabSwitchFailures({
      interaction: "switch",
      before,
      after: { openTabIds: ["review", "t-a", "t-b"], activeTabId: "t-a" },
      expectedActiveTabId: "t-a",
    })).toEqual([])
    expect(workspaceInteractionTabSwitchFailures({
      interaction: "switch",
      before,
      after: { openTabIds: ["review", "t-a"], activeTabId: "t-a" },
      expectedActiveTabId: "t-a",
    })).toEqual([expect.stringContaining("changed the open tab set")])
    expect(workspaceInteractionTabSwitchFailures({
      interaction: "switch",
      before,
      after: { openTabIds: ["review", "t-a", "t-b"], activeTabId: "t-b" },
      expectedActiveTabId: "t-a",
    })).toEqual([expect.stringContaining("activated t-b; expected t-a")])
  })

  test("open/close file interactions fail when the tab count does not move by exactly one", () => {
    const before = { openTabIds: ["review", "t-a"], activeTabId: "t-a" }
    expect(workspaceInteractionTabDeltaFailures({
      interaction: "open",
      before,
      after: { openTabIds: ["review", "t-a", "t-c"], activeTabId: "t-c" },
      expectedDelta: 1,
    })).toEqual([])
    expect(workspaceInteractionTabDeltaFailures({
      interaction: "open",
      before,
      after: before,
      expectedDelta: 1,
    })).toEqual([expect.stringContaining("changed the tab count by 0; expected 1")])
    expect(workspaceInteractionTabDeltaFailures({
      interaction: "close",
      before: { openTabIds: ["review", "t-a", "t-c"], activeTabId: "t-c" },
      after: { openTabIds: ["review"], activeTabId: "review" },
      expectedDelta: -1,
    })).toEqual([expect.stringContaining("changed the tab count by -2; expected -1")])
  })

  test("diff style, expand/collapse, navigator, and resize gates can each fail", () => {
    expect(workspaceInteractionDiffStyleFailures({ interaction: "toggle", expectedStyle: "unified", observedStyle: "unified" }))
      .toEqual([])
    expect(workspaceInteractionDiffStyleFailures({ interaction: "toggle", expectedStyle: "unified", observedStyle: "split" }))
      .toEqual([expect.stringContaining("landed on diff style split")])

    expect(workspaceInteractionExpandFailures({ interaction: "expand", renderedHunksBefore: 0, renderedHunksAfter: 1 }))
      .toEqual([])
    // The rendered-hunks counter is monotonic: an expand that renders nothing
    // leaves it flat, which must fail.
    expect(workspaceInteractionExpandFailures({ interaction: "expand", renderedHunksBefore: 1, renderedHunksAfter: 1 }))
      .toEqual([expect.stringContaining("did not increase rendered hunks")])

    // Collapse is structural: content unmounted, trigger no longer expanded.
    expect(workspaceInteractionCollapseFailures({ interaction: "collapse", stillExpanded: false, contentMounted: false }))
      .toEqual([])
    expect(workspaceInteractionCollapseFailures({ interaction: "collapse", stillExpanded: true, contentMounted: true }))
      .toEqual([
        expect.stringContaining("left the diff trigger expanded"),
        expect.stringContaining("left the collapsed row's diff content mounted"),
      ])

    // Above-ceiling expand must land on the guard pane.
    expect(workspaceInteractionLargeDiffGuardFailures({ interaction: "large", placeholderShown: true })).toEqual([])
    expect(workspaceInteractionLargeDiffGuardFailures({ interaction: "large", placeholderShown: false }))
      .toEqual([expect.stringContaining("did not surface the large-diff guard pane")])

    expect(workspaceInteractionNavigatorFailures({ interaction: "nav", expectedMode: "changes", observedMode: "changes", dataReady: true }))
      .toEqual([])
    expect(workspaceInteractionNavigatorFailures({ interaction: "nav", expectedMode: "changes", observedMode: "files", dataReady: false }))
      .toEqual([
        expect.stringContaining("landed on navigator mode files"),
        expect.stringContaining("data never became ready"),
      ])

    expect(workspaceInteractionResizeFailures({ widthBefore: 600, widthAfter: 600 + WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX }))
      .toEqual([])
    expect(workspaceInteractionResizeFailures({ widthBefore: 600, widthAfter: 610 }))
      .toEqual([expect.stringContaining("moved the shell 10px")])
  })
})
