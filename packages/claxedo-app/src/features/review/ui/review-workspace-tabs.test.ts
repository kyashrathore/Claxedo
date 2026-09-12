import { describe, expect, test } from "bun:test"
import {
  REVIEW_TAB,
  closeSubagentWorkspaceTabsForSession,
  closeWorkspaceTab,
  openBrowserWorkspaceTab,
  openFileWorkspaceTab,
  openSubagentWorkspaceTab,
  reviewWorkspaceTabsForSession,
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
    const first = openSubagentWorkspaceTab({
      tabs: [REVIEW_TAB],
      sessionId: "ses_child_a",
      parentSessionId: "ses_parent",
      label: "code-reviewer",
    })
    const second = openSubagentWorkspaceTab({
      tabs: first.tabs,
      sessionId: "ses_child_b",
      parentSessionId: "ses_parent",
      label: "explorer",
    })

    expect(second.activeTabId).toBe("subagent:ses_child_b")
    expect(second.tabs).toEqual([
      REVIEW_TAB,
      {
        id: "subagent:ses_child_a",
        kind: "subagent",
        sessionId: "ses_child_a",
        parentSessionId: "ses_parent",
        label: "code-reviewer",
      },
      {
        id: "subagent:ses_child_b",
        kind: "subagent",
        sessionId: "ses_child_b",
        parentSessionId: "ses_parent",
        label: "explorer",
      },
    ])
  })

  test("reopening the same subagent selects its tab instead of stacking another", () => {
    const opened = openSubagentWorkspaceTab({
      tabs: [REVIEW_TAB],
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      label: "explorer",
    })
    const again = openSubagentWorkspaceTab({
      tabs: opened.tabs,
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
    })

    expect(again.added).toBe(false)
    expect(again.activeTabId).toBe("subagent:ses_child")
    expect(again.tabs).toBe(opened.tabs)
  })

  test("reopening a subagent takes the label and description the row now carries", () => {
    const opened = openSubagentWorkspaceTab({
      tabs: [REVIEW_TAB],
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      label: "explorer",
      description: "Find every caller",
    })
    const again = openSubagentWorkspaceTab({
      tabs: opened.tabs,
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      label: "explorer",
      description: "Found 14 callers across 6 files",
    })

    expect(again.added).toBe(false)
    expect(again.tabs).toEqual([
      REVIEW_TAB,
      {
        id: "subagent:ses_child",
        kind: "subagent",
        sessionId: "ses_child",
        parentSessionId: "ses_parent",
        label: "explorer",
        description: "Found 14 callers across 6 files",
      },
    ])
  })

  test("a subagent tab shows only while the session that spawned it is the pane's", () => {
    const tabs = openSubagentWorkspaceTab({
      tabs: [REVIEW_TAB],
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      label: "explorer",
    }).tabs

    expect(reviewWorkspaceTabsForSession({ tabs, sessionId: "ses_other" }).map((tab) => tab.id)).toEqual(["review"])
    expect(reviewWorkspaceTabsForSession({ tabs, sessionId: "ses_parent" }).map((tab) => tab.id)).toEqual([
      "review",
      "subagent:ses_child",
    ])
  })

  test("a retained subagent tab of another parent survives the switch away", () => {
    const tabs = openSubagentWorkspaceTab({
      tabs: [REVIEW_TAB],
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
    }).tabs

    expect(reviewWorkspaceTabsForSession({ tabs, sessionId: "ses_other" })).not.toBe(tabs)
    expect(tabs.map((tab) => tab.id)).toEqual(["review", "subagent:ses_child"])
  })

  test("deleting a session closes the subagent tabs it opened and its own tab", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "subagent:ses_a", kind: "subagent", sessionId: "ses_a", parentSessionId: "ses_parent" },
      { id: "subagent:ses_b", kind: "subagent", sessionId: "ses_b", parentSessionId: "ses_other" },
      { id: "subagent:ses_parent", kind: "subagent", sessionId: "ses_parent", parentSessionId: "ses_grandparent" },
      { id: "src/a.ts", kind: "file", tabId: "src/a.ts" },
    ]

    const result = closeSubagentWorkspaceTabsForSession({
      tabs,
      activeTabId: "subagent:ses_a",
      sessionId: "ses_parent",
    })

    expect(result.removed).toBe(true)
    expect(result.tabs.map((tab) => tab.id)).toEqual(["review", "subagent:ses_b", "src/a.ts"])
    expect(result.activeTabId).toBe("subagent:ses_b")
  })

  test("deleting an unrelated session leaves the tab list alone", () => {
    const tabs: ReviewWorkspaceTab[] = [
      REVIEW_TAB,
      { id: "subagent:ses_a", kind: "subagent", sessionId: "ses_a", parentSessionId: "ses_parent" },
    ]

    const result = closeSubagentWorkspaceTabsForSession({ tabs, activeTabId: "review", sessionId: "ses_zzz" })

    expect(result.removed).toBe(false)
    expect(result.tabs).toBe(tabs)
    expect(result.activeTabId).toBe("review")
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
