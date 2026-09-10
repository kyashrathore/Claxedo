import { describe, expect, test } from "bun:test"
import {
  REVIEW_TAB,
  closeWorkspaceTab,
  openBrowserWorkspaceTab,
  openFileWorkspaceTab,
  openSubagentWorkspaceTab,
  subagentTabId,
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

  test("opening an external image reuses the browser tab and updates its URL", () => {
    const first = openBrowserWorkspaceTab({
      tabs: [REVIEW_TAB],
      browserId: "workspace-browser:repo",
      url: "https://example.com/first.png",
    })
    const second = openBrowserWorkspaceTab({
      tabs: first.tabs,
      browserId: "workspace-browser:repo",
      url: "https://example.com/second.png",
      navigationVersion: 2,
    })

    expect(second.added).toBe(false)
    expect(second.activeTabId).toBe("browser")
    expect(second.tabs).toEqual([
      REVIEW_TAB,
      {
        id: "browser",
        kind: "browser",
        browserId: "workspace-browser:repo",
        url: "https://example.com/second.png",
        navigationVersion: 2,
      },
    ])
  })

  test("each subagent gets its own tab, named by the agent that ran", () => {
    const first = openSubagentWorkspaceTab({ tabs: [REVIEW_TAB], sessionId: "ses_child_a", label: "code-reviewer" })
    const second = openSubagentWorkspaceTab({ tabs: first.tabs, sessionId: "ses_child_b", label: "explorer" })

    expect(second.activeTabId).toBe("subagent:ses_child_b")
    expect(second.tabs).toEqual([
      REVIEW_TAB,
      { id: "subagent:ses_child_a", kind: "subagent", sessionId: "ses_child_a", label: "code-reviewer" },
      { id: "subagent:ses_child_b", kind: "subagent", sessionId: "ses_child_b", label: "explorer" },
    ])
  })

  test("reopening the same subagent selects its tab instead of stacking another", () => {
    const opened = openSubagentWorkspaceTab({ tabs: [REVIEW_TAB], sessionId: "ses_child", label: "explorer" })
    const again = openSubagentWorkspaceTab({ tabs: opened.tabs, sessionId: "ses_child" })

    expect(again.added).toBe(false)
    expect(again.activeTabId).toBe("subagent:ses_child")
    expect(again.tabs).toBe(opened.tabs)
  })

  test("a subagent tab id cannot collide with a file tab for a path of the same name", () => {
    expect(subagentTabId("ses_child")).toBe("subagent:ses_child")
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
