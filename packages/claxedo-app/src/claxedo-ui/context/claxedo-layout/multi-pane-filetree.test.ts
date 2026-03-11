import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createMultiPaneState } from "./multi-pane"
import type { ClaxedoLayoutStore, Pane, PaneContent, PaneLayout } from "./types"

/**
 * Helper: build a minimal ClaxedoLayoutStore with just the multiPane field.
 * All other fields are stubbed to satisfy the type.
 */
function setup() {
  const [store, setStore] = createStore<ClaxedoLayoutStore>({
    rail: { collapsed: false, hovered: false, pinned: false, locked: false },
    groups: [],
    split: { direction: "h", sizes: [1], focusedId: "g1" },
    enabled: true,
    terminalOwner: {},
    terminalAgentStatus: {},
    terminalAgentSeen: {},
    terminalLifecycle: {},
    workspaceRecency: {},
    worktreeColorMap: {},
    processPane: {
      toggleVersion: 0,
      pendingOpen: false,
      targetDirectory: null,
      crashedWhileClosed: false,
      pendingAction: null,
    },
    multiPane: {},
  })
  const mp = createMultiPaneState({ store, setStore })
  return { store, setStore, mp }
}

/** Create a single-leaf layout with a session pane. */
function sessionLayout(sessionLeafId: string, directory: string): PaneLayout {
  return {
    id: "layout-1",
    name: "default",
    pane: { t: "leaf", id: sessionLeafId },
    contents: {
      [sessionLeafId]: {
        type: "session",
        directory,
        sessionId: "new",
      },
    },
    focus: sessionLeafId,
  }
}

/** Collect leaf IDs from a pane tree in order (left-to-right). */
function paneLeafIds(pane: Pane): string[] {
  if (pane.t === "leaf") return [pane.id]
  return [...paneLeafIds(pane.a), ...paneLeafIds(pane.b)]
}

/** Find the filetree leaf ID among live (in-pane-tree) contents. */
function findFileTreeLeaf(layout: PaneLayout): string | undefined {
  const live = new Set(paneLeafIds(layout.pane))
  return Object.entries(layout.contents).find(([id, c]) => c.type === "filetree" && live.has(id))?.[0]
}

/** Find the review-workspace leaf ID among live (in-pane-tree) contents. */
function findReviewLeaf(layout: PaneLayout): string | undefined {
  const live = new Set(paneLeafIds(layout.pane))
  return Object.entries(layout.contents).find(([id, c]) => c.type === "review-workspace" && live.has(id))?.[0]
}

/** Get the position (left-to-right index) of a leaf in the pane tree. */
function leafPosition(pane: Pane, leafId: string): number {
  return paneLeafIds(pane).indexOf(leafId)
}

describe("toggleFileTree placement", () => {
  test("file tree opens on the right when no review pane exists", () => {
    const { mp, store, setStore } = setup()
    const tabId = "tab-1"
    const sessionLeaf = "session-leaf"

    setStore("multiPane", tabId, {
      layouts: [sessionLayout(sessionLeaf, "/ws")],
      activeLayoutId: "layout-1",
    })

    mp.toggleFileTree(tabId, "/ws")

    const layout = mp.activeLayout(tabId)!
    const ftLeaf = findFileTreeLeaf(layout)!
    const ids = paneLeafIds(layout.pane)

    // File tree should be the rightmost leaf (default when no review)
    expect(ids.at(-1)).toBe(ftLeaf)
    expect(leafPosition(layout.pane, ftLeaf)).toBeGreaterThan(leafPosition(layout.pane, sessionLeaf))
  })

  test("file tree opens on the right when review is on the right", () => {
    const { mp, store, setStore } = setup()
    const tabId = "tab-1"
    const sessionLeaf = "session-leaf"
    const reviewLeaf = "review-leaf"

    // Layout: [session | review] — review on the right
    setStore("multiPane", tabId, {
      layouts: [
        {
          id: "layout-1",
          name: "default",
          pane: {
            t: "split",
            dir: "v",
            a: { t: "leaf", id: sessionLeaf },
            b: { t: "leaf", id: reviewLeaf },
            size: 0.65,
          },
          contents: {
            [sessionLeaf]: { type: "session", directory: "/ws", sessionId: "s1" },
            [reviewLeaf]: { type: "review-workspace", directory: "/ws", sessionId: "s1" },
          },
          focus: sessionLeaf,
        },
      ],
      activeLayoutId: "layout-1",
    })

    mp.toggleFileTree(tabId, "/ws")

    const layout = mp.activeLayout(tabId)!
    const ftLeaf = findFileTreeLeaf(layout)!
    const ids = paneLeafIds(layout.pane)

    // File tree should be rightmost (same side as review)
    expect(ids.at(-1)).toBe(ftLeaf)
    expect(leafPosition(layout.pane, ftLeaf)).toBeGreaterThan(leafPosition(layout.pane, reviewLeaf))
  })

  test("file tree opens on the left when review is on the left", () => {
    const { mp, store, setStore } = setup()
    const tabId = "tab-1"
    const sessionLeaf = "session-leaf"
    const reviewLeaf = "review-leaf"

    // Layout: [review | session] — review on the left
    setStore("multiPane", tabId, {
      layouts: [
        {
          id: "layout-1",
          name: "default",
          pane: {
            t: "split",
            dir: "v",
            a: { t: "leaf", id: reviewLeaf },
            b: { t: "leaf", id: sessionLeaf },
            size: 0.35,
          },
          contents: {
            [sessionLeaf]: { type: "session", directory: "/ws", sessionId: "s1" },
            [reviewLeaf]: { type: "review-workspace", directory: "/ws", sessionId: "s1" },
          },
          focus: sessionLeaf,
        },
      ],
      activeLayoutId: "layout-1",
    })

    mp.toggleFileTree(tabId, "/ws")

    const layout = mp.activeLayout(tabId)!
    const ftLeaf = findFileTreeLeaf(layout)!
    const ids = paneLeafIds(layout.pane)

    // File tree should be leftmost (same side as review)
    expect(ids[0]).toBe(ftLeaf)
    expect(leafPosition(layout.pane, ftLeaf)).toBeLessThan(leafPosition(layout.pane, reviewLeaf))
  })

  test("toggling file tree twice removes it", () => {
    const { mp, store, setStore } = setup()
    const tabId = "tab-1"

    setStore("multiPane", tabId, {
      layouts: [sessionLayout("session-leaf", "/ws")],
      activeLayoutId: "layout-1",
    })

    mp.toggleFileTree(tabId, "/ws")
    expect(mp.hasFileTree(tabId)).toBe(true)

    mp.toggleFileTree(tabId, "/ws")
    expect(mp.hasFileTree(tabId)).toBe(false)
  })

  test("toggleReviewWorkspace then toggleFileTree places both on the right", () => {
    const { mp, setStore } = setup()
    const tabId = "tab-1"
    const sessionLeaf = "session-leaf"

    setStore("multiPane", tabId, {
      layouts: [sessionLayout(sessionLeaf, "/ws")],
      activeLayoutId: "layout-1",
    })

    // Review goes to the right by default
    mp.toggleReviewWorkspace(tabId, "/ws", "s1", "session")
    expect(mp.hasReviewWorkspace(tabId)).toBe(true)

    const afterReview = mp.activeLayout(tabId)!
    const reviewLeaf = findReviewLeaf(afterReview)!
    expect(leafPosition(afterReview.pane, reviewLeaf)).toBeGreaterThan(leafPosition(afterReview.pane, sessionLeaf))

    // File tree should also go to the right
    mp.toggleFileTree(tabId, "/ws")

    const layout = mp.activeLayout(tabId)!
    const ftLeaf = findFileTreeLeaf(layout)!
    const ids = paneLeafIds(layout.pane)

    // Order should be: session, review, filetree (all on the right side)
    expect(leafPosition(layout.pane, sessionLeaf)).toBe(0)
    expect(leafPosition(layout.pane, ftLeaf)).toBe(ids.length - 1)
  })
})
