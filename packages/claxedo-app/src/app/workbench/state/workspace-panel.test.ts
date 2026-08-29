import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { emptyClaxedoState } from "./persistence"
import { reviewWorkspaceWorkingSetKey } from "../review/review-workspace-working-set"
import { createWorkspacePanelSlice, MAX_SESSION_PANEL_SNAPSHOTS, syncFocusedSessionPanel } from "./workspace-panel"
import type { ClaxedoState } from "./types"

function makeSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const workspacePanel = createWorkspacePanelSlice({
    state,
    setState,
    defaultTarget: () => ({ workspaceDir: "/default", targetPaneId: "pane-default" }),
  })
  return { state, workspacePanel }
}

describe("workspace panel slice", () => {
  test("restores open, mode, and navigator with the session that owned them", () => {
    const { state, workspacePanel } = makeSlice()

    workspacePanel.open("review", {
      workspaceDir: "/repo",
      targetPaneId: "pane-a",
      navigator: "changes",
    })
    workspacePanel.rememberSession("ses_a")

    workspacePanel.open("processes", {
      workspaceDir: "/repo",
      targetPaneId: "pane-b",
      navigator: "processes",
    })
    workspacePanel.close()
    workspacePanel.rememberSession("ses_b")

    expect(workspacePanel.restoreSession("ses_a", {
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })).toBe(true)
    expect(state.workspacePanel).toMatchObject({
      open: true,
      mode: "review",
      navigator: "changes",
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })

    // Closed remember is minimal: restoring it only closes, and does not
    // resurrect a stale navigator/mode onto the live panel state.
    expect(workspacePanel.restoreSession("ses_b", {
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })).toBe(false)
    expect(state.workspacePanel.open).toBe(false)
  })

  test("a session with no snapshot does not inherit the previous session's open panel", () => {
    const { state, workspacePanel } = makeSlice()

    workspacePanel.open("review", {
      workspaceDir: "/repo",
      targetPaneId: "pane-a",
      navigator: "files",
    })
    workspacePanel.rememberSession("ses_a")

    expect(workspacePanel.restoreSession("ses_new", {
      workspaceDir: "/repo",
      targetPaneId: "pane-current",
    })).toBe(false)
    expect(state.workspacePanel.open).toBe(false)
  })

  test("evicts the least-recently-used snapshot once the retained set exceeds its bound", () => {
    const { workspacePanel } = makeSlice()
    const total = MAX_SESSION_PANEL_SNAPSHOTS + 1

    for (let i = 0; i < total; i++) {
      workspacePanel.open("review", { workspaceDir: `/r${i}`, targetPaneId: "p" })
      workspacePanel.rememberSession(`ses_${i}`)
    }

    // The oldest snapshot (ses_0) was evicted to hold the bound…
    expect(
      workspacePanel.restoreSession("ses_0", { workspaceDir: "/x", targetPaneId: "p" }),
    ).toBe(false)
    // …while the newest and the second-oldest still-retained ones survive.
    expect(
      workspacePanel.restoreSession("ses_1", { workspaceDir: "/x", targetPaneId: "p" }),
    ).toBe(true)
    expect(
      workspacePanel.restoreSession(`ses_${total - 1}`, { workspaceDir: "/x", targetPaneId: "p" }),
    ).toBe(true)
  })

  test("re-remembering a session keeps it alive across a full sweep of newer sessions", () => {
    const { workspacePanel } = makeSlice()

    workspacePanel.open("review", { workspaceDir: "/keep", targetPaneId: "p" })
    workspacePanel.rememberSession("ses_keep")

    // Touch it again after remembering one other so it is the most-recent.
    workspacePanel.rememberSession("ses_keep")

    // Fill the cache with enough brand-new sessions to overflow the bound
    // (ses_keep + MAX new = MAX + 1 distinct), so eviction actually fires. Because
    // ses_keep is bumped to most-recent after each insert, the eviction must land
    // on the oldest ses_new_* and never on ses_keep — LRU recency protects it.
    for (let i = 0; i < MAX_SESSION_PANEL_SNAPSHOTS; i++) {
      workspacePanel.rememberSession(`ses_new_${i}`)
      workspacePanel.rememberSession("ses_keep") // keep bumping it to most-recent
    }

    // The recently-touched key survives the overflow…
    expect(
      workspacePanel.restoreSession("ses_keep", { workspaceDir: "/x", targetPaneId: "p" }),
    ).toBe(true)
    // …and it was the oldest new session that got evicted, proving overflow fired.
    expect(
      workspacePanel.restoreSession("ses_new_0", { workspaceDir: "/x", targetPaneId: "p" }),
    ).toBe(false)
  })
})

describe("syncFocusedSessionPanel", () => {
  test("remembers the session that is leaving, then restores the one arriving", () => {
    const remembered: string[] = []
    const restored: string[] = []
    syncFocusedSessionPanel({
      previousSessionId: "ses_a",
      nextSessionId: "ses_b",
      remember: (id) => remembered.push(id),
      restore: (id) => restored.push(id),
    })
    expect(remembered).toEqual(["ses_a"])
    expect(restored).toEqual(["ses_b"])
  })

  test("does not stamp the destination with the live panel after focus already moved", () => {
    const remembered: string[] = []
    syncFocusedSessionPanel({
      previousSessionId: "ses_b",
      nextSessionId: "ses_b",
      remember: (id) => remembered.push(id),
      restore: () => {
        throw new Error("same-session restore would clone the previous panel onto the destination")
      },
    })
    expect(remembered).toEqual([])
  })

  test("closes inheritance by restoring a first visit even when the previous panel is open", () => {
    const remembered: string[] = []
    const restored: string[] = []
    syncFocusedSessionPanel({
      previousSessionId: "ses_a",
      nextSessionId: "ses_new",
      remember: (id) => remembered.push(id),
      restore: (id) => restored.push(id),
    })
    expect(remembered).toEqual(["ses_a"])
    expect(restored).toEqual(["ses_new"])
  })
})

describe("workspace panel review working set", () => {
  test("outlives closing the panel, so a disposed panel body reopens on its own tabs", () => {
    const { workspacePanel } = makeSlice()
    const key = reviewWorkspaceWorkingSetKey({ workspaceDir: "/repo", mode: "uncommitted" })

    workspacePanel.open("review", { workspaceDir: "/repo", targetPaneId: "pane-a" })
    workspacePanel.reviewWorkingSet.set(key, {
      tabs: [
        { id: "review", kind: "review" },
        { id: "file:src/a.ts", kind: "file", tabId: "file:src/a.ts" },
      ],
      activeTabId: "file:src/a.ts",
      review: { scroll: { top: 11_200, anchorPath: "src/generated/file-350.ts", anchorOffset: 0 } },
    })

    // Closing unmounts the panel body; the store is owned by the slice, not by
    // the DOM it renders.
    workspacePanel.close()

    const restored = workspacePanel.reviewWorkingSet.get(key)
    expect(restored?.activeTabId).toBe("file:src/a.ts")
    expect(restored?.tabs.map((tab) => tab.id)).toEqual(["review", "file:src/a.ts"])
    expect(restored?.review.scroll).toEqual({
      top: 11_200,
      anchorPath: "src/generated/file-350.ts",
      anchorOffset: 0,
    })
  })

  test("gives each provider instance its own working sets", () => {
    const first = makeSlice()
    const second = makeSlice()
    const key = reviewWorkspaceWorkingSetKey({ workspaceDir: "/repo", mode: "uncommitted" })

    first.workspacePanel.reviewWorkingSet.set(key, {
      tabs: [{ id: "review", kind: "review" }],
      activeTabId: "review",
      review: { scroll: { top: 42 } },
    })

    expect(second.workspacePanel.reviewWorkingSet.get(key)).toBeUndefined()
  })
})
