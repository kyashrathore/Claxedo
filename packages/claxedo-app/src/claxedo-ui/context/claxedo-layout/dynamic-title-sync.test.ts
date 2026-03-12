import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import {
  computeTabTitle,
  findPrimarySession,
  listDynamicTitleUpdates,
  type ComputeTitleInput,
  type DynamicTitleSyncDeps,
} from "./dynamic-title-sync"
import type { PaneContent, TabItem } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: "tab-1",
    type: "session",
    directory: "/workspace",
    title: "Session",
    closable: true,
    ...overrides,
  }
}

function makeContent(overrides: Partial<PaneContent> = {}): PaneContent {
  return {
    type: "session",
    directory: "/workspace",
    ...overrides,
  }
}

function makeInput(overrides: Partial<ComputeTitleInput> = {}): ComputeTitleInput {
  return {
    tab: makeTab(),
    paneContents: [makeContent()],
    sessionTitle: undefined,
    firstMessagePreview: undefined,
    isDefaultTitle: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeTabTitle
// ---------------------------------------------------------------------------

describe("computeTabTitle", () => {
  test("returns undefined when paneContents is empty", () => {
    const result = computeTabTitle(makeInput({ paneContents: [] }))
    expect(result).toBeUndefined()
  })

  test("returns session title when not default", () => {
    const result = computeTabTitle(
      makeInput({
        sessionTitle: "Fix login bug",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Fix login bug")
  })

  test("returns first-message preview when session title is default", () => {
    const result = computeTabTitle(
      makeInput({
        sessionTitle: "New session - 2026-03-11T10:00:00.000Z",
        isDefaultTitle: true,
        firstMessagePreview: "How do I fix the auth flow?",
      }),
    )
    expect(result).toBe("How do I fix the auth flow?")
  })

  test("returns undefined when session title matches current tab title", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ title: "Fix login bug" }),
        sessionTitle: "Fix login bug",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBeUndefined()
  })

  test("session pane takes priority over terminal pane", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [
          makeContent({ type: "terminal", directory: "/workspace" }),
          makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
        ],
        sessionTitle: "Debug API",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Debug API")
  })

  test("session pane takes priority over filetree pane", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [
          makeContent({ type: "filetree", directory: "/workspace" }),
          makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
          makeContent({ type: "terminal", directory: "/workspace" }),
        ],
        sessionTitle: "Refactor components",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Refactor components")
  })

  test("review-workspace pane prefixes with Review:", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [makeContent({ type: "review-workspace", directory: "/workspace", sessionId: "s1" })],
        sessionTitle: "Fix login bug",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Review: Fix login bug")
  })

  test("review pane uses first-message preview when session title is default", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [makeContent({ type: "review-workspace", directory: "/workspace", sessionId: "s1" })],
        sessionTitle: "New session - 2026-03-11T10:00:00.000Z",
        isDefaultTitle: true,
        firstMessagePreview: "Update auth flow",
      }),
    )
    expect(result).toBe("Review: Update auth flow")
  })

  test("page pane uses page title", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "page", title: "Page" }),
        paneContents: [makeContent({ type: "page", directory: "/workspace", title: "Architecture Notes" })],
      }),
    )
    expect(result).toBe("Architecture Notes")
  })

  test("file pane uses filename", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "file", title: "File" }),
        paneContents: [makeContent({ type: "file", directory: "/workspace", title: "auth.ts" })],
      }),
    )
    expect(result).toBe("auth.ts")
  })

  test("regular terminal returns undefined (no dynamic title)", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "terminal", title: "Terminal" }),
        paneContents: [makeContent({ type: "terminal", directory: "/workspace" })],
      }),
    )
    expect(result).toBeUndefined()
  })

  test("TUI terminal (claude command) returns undefined (keeps static title)", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "terminal", title: "Claude" }),
        paneContents: [makeContent({ type: "terminal", directory: "/workspace", command: "claude" })],
      }),
    )
    // TUI terminals keep their static title — no dynamic override
    expect(result).toBeUndefined()
  })

  test("process pane returns undefined (no dynamic title)", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "process", title: "Processes" }),
        paneContents: [makeContent({ type: "process", directory: "/workspace" })],
      }),
    )
    expect(result).toBeUndefined()
  })

  test("context pane defers — only session pane drives title", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [
          makeContent({ type: "context", directory: "/workspace", sessionId: "s1" }),
          makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
        ],
        sessionTitle: "Implement feature X",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Implement feature X")
  })

  test("context pane alone returns undefined (no primary found)", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [makeContent({ type: "context", directory: "/workspace", sessionId: "s1" })],
      }),
    )
    expect(result).toBeUndefined()
  })

  test("filetree pane alone returns undefined (defers, no primary)", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [makeContent({ type: "filetree", directory: "/workspace" })],
      }),
    )
    expect(result).toBeUndefined()
  })

  test("returns undefined when no session title and no preview available", () => {
    const result = computeTabTitle(
      makeInput({
        sessionTitle: undefined,
        firstMessagePreview: undefined,
        isDefaultTitle: true,
      }),
    )
    expect(result).toBeUndefined()
  })

  test("session with page — session takes priority (lower number)", () => {
    const result = computeTabTitle(
      makeInput({
        paneContents: [
          makeContent({ type: "page", directory: "/workspace", title: "My Page" }),
          makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
        ],
        sessionTitle: "Working on page",
        isDefaultTitle: false,
      }),
    )
    expect(result).toBe("Working on page")
  })

  test("page without session uses page title", () => {
    const result = computeTabTitle(
      makeInput({
        tab: makeTab({ type: "page", title: "Page" }),
        paneContents: [makeContent({ type: "page", directory: "/workspace", title: "Design Doc" })],
      }),
    )
    expect(result).toBe("Design Doc")
  })
})

// ---------------------------------------------------------------------------
// findPrimarySession
// ---------------------------------------------------------------------------

describe("findPrimarySession", () => {
  test("returns first session pane", () => {
    const result = findPrimarySession([
      makeContent({ type: "filetree", directory: "/workspace" }),
      makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
      makeContent({ type: "session", directory: "/workspace", sessionId: "s2" }),
    ])
    expect(result).toEqual({ sessionId: "s1", directory: "/workspace" })
  })

  test("skips session with sessionId 'new'", () => {
    const result = findPrimarySession([
      makeContent({ type: "session", directory: "/workspace", sessionId: "new" }),
      makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
    ])
    expect(result).toEqual({ sessionId: "s1", directory: "/workspace" })
  })

  test("falls back to review-workspace pane", () => {
    const result = findPrimarySession([
      makeContent({ type: "filetree", directory: "/workspace" }),
      makeContent({ type: "review-workspace", directory: "/workspace", sessionId: "s1" }),
    ])
    expect(result).toEqual({ sessionId: "s1", directory: "/workspace" })
  })

  test("prefers session over review-workspace", () => {
    const result = findPrimarySession([
      makeContent({ type: "review-workspace", directory: "/workspace", sessionId: "r1" }),
      makeContent({ type: "session", directory: "/workspace", sessionId: "s1" }),
    ])
    expect(result).toEqual({ sessionId: "s1", directory: "/workspace" })
  })

  test("returns undefined when no session-like pane exists", () => {
    const result = findPrimarySession([
      makeContent({ type: "terminal", directory: "/workspace" }),
      makeContent({ type: "filetree", directory: "/workspace" }),
    ])
    expect(result).toBeUndefined()
  })

  test("returns undefined for empty paneContents", () => {
    const result = findPrimarySession([])
    expect(result).toBeUndefined()
  })

  test("skips session without directory", () => {
    const result = findPrimarySession([
      makeContent({ type: "session", directory: "", sessionId: "s1" }),
      makeContent({ type: "session", directory: "/workspace", sessionId: "s2" }),
    ])
    expect(result).toEqual({ sessionId: "s2", directory: "/workspace" })
  })
})

describe("listDynamicTitleUpdates", () => {
  test("uses renamed session title without needing tab mutations", () => {
    const [state, setState] = createStore({
      session: [{ id: "s1", directory: "/workspace", title: "First title" }],
      message: {},
      part: {},
    })
    const [tabs] = createStore<TabItem[]>([
      {
        id: "tab-1",
        type: "session",
        directory: "/workspace",
        title: "Session",
        sessionId: "s1",
        closable: true,
      },
    ])

    const deps: DynamicTitleSyncDeps = {
      claxedo: {
        split: {
          groups: () => [{ id: "group-1" }] as any,
        },
        groupTabs: () => ({
          items: () => tabs,
          updateTitle: () => {},
        }),
        multiPane: {
          leafIds: () => ["leaf-1"],
          getContent: () => ({
            type: "session",
            directory: "/workspace",
            sessionId: "s1",
          }),
        },
      },
      globalSync: {
        child: () => [state as any],
      },
    }

    expect(listDynamicTitleUpdates(deps)).toEqual([{ groupId: "group-1", tabId: "tab-1", title: "First title" }])

    setState("session", 0, "title", "Renamed session")

    expect(listDynamicTitleUpdates(deps)).toEqual([{ groupId: "group-1", tabId: "tab-1", title: "Renamed session" }])
  })
})
