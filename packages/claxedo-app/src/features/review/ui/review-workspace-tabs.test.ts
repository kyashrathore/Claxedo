import { describe, expect, test } from "bun:test"
import {
  REVIEW_TAB,
  closeWorkspaceTab,
  openFileWorkspaceTab,
  nextActiveWorkspaceTabAfterClose,
  type ReviewWorkspaceTab,
} from "./review-workspace-tabs"

describe("review workspace tabs", () => {
  test("opening a file from the navigator creates and selects a file tab", () => {
    const result = openFileWorkspaceTab({
      tabs: [REVIEW_TAB],
      tabId: "src/app.ts",
    })

    expect(result.added).toBe(true)
    expect(result.activeTabId).toBe("src/app.ts")
    expect(result.tabs).toEqual([
      REVIEW_TAB,
      { id: "src/app.ts", kind: "file", tabId: "src/app.ts" },
    ])
  })

  test("opening an existing file tab selects it without duplicating it", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "src/app.ts", kind: "file", tabId: "src/app.ts" },
    ]

    const result = openFileWorkspaceTab({ tabs, tabId: "src/app.ts" })

    expect(result.added).toBe(false)
    expect(result.activeTabId).toBe("src/app.ts")
    expect(result.tabs).toBe(tabs)
  })

  test("closing the active file tab selects its neighbor", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "src/a.ts", kind: "file", tabId: "src/a.ts" },
      { id: "src/b.ts", kind: "file", tabId: "src/b.ts" },
    ]

    expect(nextActiveWorkspaceTabAfterClose({
      tabs,
      activeTabId: "src/a.ts",
      closeTabId: "src/a.ts",
    })).toBe("src/b.ts")
  })

  test("selecting an existing file tab preserves tab order", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "src/a.ts", kind: "file", tabId: "src/a.ts" },
      { id: "src/b.ts", kind: "file", tabId: "src/b.ts" },
      { id: "src/c.ts", kind: "file", tabId: "src/c.ts" },
    ]

    const result = openFileWorkspaceTab({ tabs, tabId: "src/a.ts" })

    expect(result.activeTabId).toBe("src/a.ts")
    expect(result.tabs.map((tab) => tab.id)).toEqual(["review", "src/a.ts", "src/b.ts", "src/c.ts"])
  })

  test("closing an inactive file tab keeps the active tab and order", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "src/a.ts", kind: "file", tabId: "src/a.ts" },
      { id: "src/b.ts", kind: "file", tabId: "src/b.ts" },
      { id: "src/c.ts", kind: "file", tabId: "src/c.ts" },
    ]

    const result = closeWorkspaceTab({
      tabs,
      activeTabId: "src/c.ts",
      closeTabId: "src/a.ts",
    })

    expect(result.activeTabId).toBe("src/c.ts")
    expect(result.tabs.map((tab) => tab.id)).toEqual(["review", "src/b.ts", "src/c.ts"])
  })

  test("closing the last active file tab selects the previous tab", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "src/a.ts", kind: "file", tabId: "src/a.ts" },
      { id: "src/b.ts", kind: "file", tabId: "src/b.ts" },
    ]

    const result = closeWorkspaceTab({
      tabs,
      activeTabId: "src/b.ts",
      closeTabId: "src/b.ts",
    })

    expect(result.activeTabId).toBe("src/a.ts")
    expect(result.tabs.map((tab) => tab.id)).toEqual(["review", "src/a.ts"])
  })
})
