/**
 * Multi-Pane State Manager
 *
 * Manages per-tab multi-pane layout state: named layouts, pane trees,
 * content mapping, focus/zoom. Uses the same pane reducer as terminals.
 */

import type { SetStoreFunction } from "solid-js/store"
import { reducePaneTab, paneList, type PaneTabAction } from "../pane-reducer"
import type { ClaxedoLayoutStore, MultiPaneTabState, PaneContent, PaneDir, PaneLayout, Pane } from "./types"
import { withPaneIntentName } from "./pane-intent"

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clonePane(pane: Pane): Pane {
  if (pane.t === "leaf") return { t: "leaf", id: pane.id }
  return {
    t: "split",
    dir: pane.dir,
    a: clonePane(pane.a),
    b: clonePane(pane.b),
    size: pane.size,
  }
}

function leafEdges(
  pane: Pane,
  leafId: string,
  edges: { left: boolean; right: boolean } = { left: true, right: true },
): { left: boolean; right: boolean } | undefined {
  if (pane.t === "leaf") return pane.id === leafId ? edges : undefined
  if (pane.dir === "v") {
    return (
      leafEdges(pane.a, leafId, { left: edges.left, right: false }) ??
      leafEdges(pane.b, leafId, { left: false, right: edges.right })
    )
  }
  return leafEdges(pane.a, leafId, edges) ?? leafEdges(pane.b, leafId, edges)
}

function liveContents(layout: PaneLayout): Array<[string, PaneContent]> {
  const ids = new Set(paneList(layout.pane))
  return Object.entries(layout.contents).filter(([leafId]) => ids.has(leafId))
}

function pruneContents(layout: PaneLayout): Record<string, PaneContent> {
  return Object.fromEntries(liveContents(layout))
}

function defaultLayout(directory?: string): PaneLayout {
  const leafId = generateId("leaf")
  const contents: Record<string, PaneContent> = {}
  if (directory) {
    contents[leafId] = withPaneIntentName({ type: "session", directory, sessionId: "new" }, leafId)
  }
  return {
    id: generateId("layout"),
    name: "default",
    pane: { t: "leaf", id: leafId },
    contents,
    focus: leafId,
  }
}

function pageSessionLayout(input: { directory: string; pageId: string; filePath?: string; title: string }): PaneLayout {
  const pageLeaf = generateId("leaf")
  const sessionLeaf = generateId("leaf")
  return {
    id: generateId("layout"),
    name: "default",
    pane: {
      t: "split",
      dir: "v",
      a: { t: "leaf", id: pageLeaf },
      b: { t: "leaf", id: sessionLeaf },
      size: 0.62,
    },
    contents: {
      [pageLeaf]: withPaneIntentName(
        {
          type: "page",
          directory: input.directory,
          pageId: input.pageId,
          filePath: input.filePath,
          title: input.title,
          intent: {
            name: "doc",
            role: "document",
            meta: {
              page_id: input.pageId,
              directory: input.directory,
              markdown_mirror: `.claxedo/pages/${input.pageId}.md`,
            },
          },
        },
        pageLeaf,
      ),
      [sessionLeaf]: withPaneIntentName(
        {
          type: "session",
          directory: input.directory,
          sessionId: "new",
          title: "Session",
          intent: {
            name: "chat",
            role: "assistant",
            refs: ["doc"],
            defaults: {
              agent: "doc",
            },
          },
        },
        sessionLeaf,
      ),
    },
    focus: pageLeaf,
  }
}

export function processSessionLayout(input: { directory: string }): PaneLayout {
  const processLeaf = generateId("leaf")
  return {
    id: generateId("layout"),
    name: "default",
    pane: { t: "leaf", id: processLeaf },
    contents: {
      [processLeaf]: withPaneIntentName(
        {
          type: "process",
          directory: input.directory,
        },
        processLeaf,
      ),
    },
    focus: processLeaf,
  }
}

export function reviewSessionLayout(input: {
  directory: string
  sessionId: string
  reviewMode?: import("./types").ReviewMode
  reviewFromRef?: string
  reviewToRef?: string
}): PaneLayout {
  const reviewLeaf = generateId("leaf")
  const sessionLeaf = generateId("leaf")
  return {
    id: generateId("layout"),
    name: "default",
    pane: {
      t: "split",
      dir: "v",
      a: { t: "leaf", id: sessionLeaf },
      b: { t: "leaf", id: reviewLeaf },
      size: 0.45,
    },
    contents: {
      [reviewLeaf]: withPaneIntentName(
        {
          type: "review-workspace",
          directory: input.directory,
          sessionId: input.sessionId,
          reviewMode: input.reviewMode ?? "session",
          reviewFromRef: input.reviewFromRef,
          reviewToRef: input.reviewToRef,
          intent: {
            name: "review",
            role: "reviewer",
            refs: ["session"],
          },
        },
        reviewLeaf,
      ),
      [sessionLeaf]: withPaneIntentName(
        {
          type: "session",
          directory: input.directory,
          sessionId: input.sessionId,
          title: "Session",
          intent: {
            name: "session",
            role: "assistant",
            refs: ["review"],
          },
        },
        sessionLeaf,
      ),
    },
    focus: reviewLeaf,
  }
}

export function createMultiPaneState(input: {
  store: ClaxedoLayoutStore
  setStore: SetStoreFunction<ClaxedoLayoutStore>
}) {
  const { store, setStore } = input

  const getState = (tabId: string): MultiPaneTabState | undefined => {
    return store.multiPane[tabId]
  }

  const getLayoutIndex = (tabId: string, layoutId: string): number => {
    const state = store.multiPane[tabId]
    if (!state) return -1
    return state.layouts.findIndex((l) => l.id === layoutId)
  }

  const activeLayout = (tabId: string): PaneLayout | undefined => {
    const state = store.multiPane[tabId]
    if (!state) return undefined
    return state.layouts.find((l) => l.id === state.activeLayoutId) ?? state.layouts[0]
  }

  const activeLayoutIndex = (tabId: string): number => {
    const state = store.multiPane[tabId]
    if (!state) return -1
    const idx = state.layouts.findIndex((l) => l.id === state.activeLayoutId)
    return idx === -1 ? 0 : idx
  }

  const reduceInLayout = (tabId: string, action: PaneTabAction) => {
    const idx = activeLayoutIndex(tabId)
    if (idx === -1) return
    const layout = store.multiPane[tabId]!.layouts[idx]
    const current = {
      pane: layout.pane,
      focus: layout.focus,
      zoom: layout.zoom,
    }
    const next = reducePaneTab(current, action)
    if (next.pane !== current.pane) setStore("multiPane", tabId, "layouts", idx, "pane", next.pane!)
    if (next.focus !== current.focus) setStore("multiPane", tabId, "layouts", idx, "focus", next.focus)
    if (next.zoom !== current.zoom) setStore("multiPane", tabId, "layouts", idx, "zoom", next.zoom)
    return next
  }

  return {
    getState,
    activeLayout,

    initTab(tabId: string, directory?: string, initial?: PaneLayout) {
      const layout = initial ?? defaultLayout(directory)
      setStore("multiPane", tabId, {
        layouts: [layout],
        activeLayoutId: layout.id,
      })
    },

    initTabWithContent(tabId: string, content: PaneContent) {
      const leafId = generateId("leaf")
      const layout: PaneLayout = {
        id: generateId("layout"),
        name: "default",
        pane: { t: "leaf", id: leafId },
        contents: { [leafId]: withPaneIntentName(content, leafId) },
        focus: leafId,
      }
      setStore("multiPane", tabId, {
        layouts: [layout],
        activeLayoutId: layout.id,
      })
    },

    initPageSessionTab(tabId: string, input: { directory: string; pageId: string; filePath?: string; title: string }) {
      const layout = pageSessionLayout(input)
      setStore("multiPane", tabId, {
        layouts: [layout],
        activeLayoutId: layout.id,
      })
    },

    clearTab(tabId: string) {
      setStore("multiPane", tabId, undefined)
    },

    setActiveLayout(tabId: string, layoutId: string) {
      const state = store.multiPane[tabId]
      if (!state) return
      if (!state.layouts.some((l) => l.id === layoutId)) return
      setStore("multiPane", tabId, "activeLayoutId", layoutId)
    },

    addLayout(tabId: string, name: string, initial?: PaneLayout) {
      const state = store.multiPane[tabId]
      if (!state) return
      const layout = initial ?? { ...defaultLayout(), name }
      if (!initial) layout.name = name
      setStore("multiPane", tabId, "layouts", (layouts) => [...layouts, layout])
      setStore("multiPane", tabId, "activeLayoutId", layout.id)
      return layout.id
    },

    removeLayout(tabId: string, layoutId: string) {
      const state = store.multiPane[tabId]
      if (!state || state.layouts.length <= 1) return
      const remaining = state.layouts.filter((l) => l.id !== layoutId)
      setStore("multiPane", tabId, "layouts", remaining)
      if (state.activeLayoutId === layoutId) {
        setStore("multiPane", tabId, "activeLayoutId", remaining[0].id)
      }
    },

    renameLayout(tabId: string, layoutId: string, name: string) {
      const idx = getLayoutIndex(tabId, layoutId)
      if (idx === -1) return
      setStore("multiPane", tabId, "layouts", idx, "name", name)
    },

    duplicateLayout(tabId: string, layoutId: string) {
      const state = store.multiPane[tabId]
      if (!state) return
      const source = state.layouts.find((l) => l.id === layoutId)
      if (!source) return
      const newLayout: PaneLayout = {
        ...structuredClone(source),
        id: generateId("layout"),
        name: `${source.name} (copy)`,
      }
      setStore("multiPane", tabId, "layouts", (layouts) => [...layouts, newLayout])
      setStore("multiPane", tabId, "activeLayoutId", newLayout.id)
      return newLayout.id
    },

    splitLeaf(tabId: string, dir: PaneDir, atLeafId: string, content?: PaneContent) {
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      const newLeafId = generateId("leaf")
      reduceInLayout(tabId, { type: "split", at: atLeafId, id: newLeafId, dir })
      if (content) {
        setStore("multiPane", tabId, "layouts", idx, "contents", newLeafId, withPaneIntentName(content, newLeafId))
      }
      return newLeafId
    },

    closeLeaf(tabId: string, leafId: string) {
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      const layout = store.multiPane[tabId]!.layouts[idx]
      const ids = paneList(layout.pane)
      if (ids.length <= 1) return // Don't close last pane
      reduceInLayout(tabId, { type: "close", id: leafId })
      const nextLayout = store.multiPane[tabId]!.layouts[idx]
      setStore("multiPane", tabId, "layouts", idx, "contents", pruneContents(nextLayout))
    },

    resize(tabId: string, path: string, size: number) {
      reduceInLayout(tabId, { type: "resize", path, size })
    },

    swap(tabId: string, a: string, b: string) {
      reduceInLayout(tabId, { type: "swap", a, b })
    },

    focus(tabId: string, leafId: string) {
      reduceInLayout(tabId, { type: "focus", id: leafId })
    },

    zoom(tabId: string, leafId: string) {
      reduceInLayout(tabId, { type: "zoom", id: leafId })
    },

    setContent(tabId: string, leafId: string, content: PaneContent) {
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      setStore("multiPane", tabId, "layouts", idx, "contents", leafId, withPaneIntentName(content, leafId))
    },

    getContent(tabId: string, leafId: string): PaneContent | undefined {
      const layout = activeLayout(tabId)
      if (!layout) return undefined
      const content = layout.contents[leafId]
      if (!content) return
      return withPaneIntentName(content, leafId)
    },

    float(tabId: string, leafId: string) {
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      const layout = store.multiPane[tabId]!.layouts[idx]
      // Only allow floating a session leaf
      const content = layout.contents[leafId]
      if (!content || content.type !== "session") return
      setStore("multiPane", tabId, "layouts", idx, "floating", leafId)
    },

    unfloat(tabId: string) {
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      setStore("multiPane", tabId, "layouts", idx, "floating", undefined)
    },

    /** Check whether the active layout for a tab contains a filetree pane */
    hasFileTree(tabId: string): boolean {
      const layout = activeLayout(tabId)
      if (!layout) return false
      return liveContents(layout).some(([, content]) => content.type === "filetree")
    },

    /** Check whether the active layout for a tab contains a review workspace pane */
    hasReviewWorkspace(tabId: string): boolean {
      const layout = activeLayout(tabId)
      if (!layout) return false
      return liveContents(layout).some(([, content]) => content.type === "review-workspace")
    },

    /** Toggle a filetree pane in the active layout. If one exists, remove it; otherwise insert one. */
    toggleFileTree(tabId: string, directory: string) {
      const layout = activeLayout(tabId)
      if (!layout) return

      const existing = liveContents(layout).find(([, content]) => content.type === "filetree")
      if (!existing && Object.values(layout.contents).some((content) => content.type === "filetree")) {
        const idx = activeLayoutIndex(tabId)
        if (idx !== -1) setStore("multiPane", tabId, "layouts", idx, "contents", pruneContents(layout))
      }
      if (existing) {
        // Remove it — reuse closeLeaf (but only if not the last pane)
        const ids = paneList(layout.pane)
        if (ids.length > 1) {
          const idx = activeLayoutIndex(tabId)
          if (idx === -1) return
          reduceInLayout(tabId, { type: "close", id: existing[0] })
          const nextLayout = store.multiPane[tabId]!.layouts[idx]
          setStore("multiPane", tabId, "layouts", idx, "contents", pruneContents(nextLayout))
        }
        return
      }

      const reviewLeafId =
        (layout.focus && layout.contents[layout.focus]?.type === "review-workspace" ? layout.focus : undefined) ??
        Object.entries(layout.contents).find(([, c]) => c.type === "review-workspace")?.[0]
      const reviewEdges = reviewLeafId ? leafEdges(layout.pane, reviewLeafId) : undefined
      const openRight = !!reviewEdges?.right && !reviewEdges.left
      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      const newLeafId = generateId("leaf")
      const currentRoot = clonePane(layout.pane)
      const newRoot: Pane = {
        t: "split",
        dir: "v",
        a: openRight ? currentRoot : { t: "leaf", id: newLeafId },
        b: openRight ? { t: "leaf", id: newLeafId } : currentRoot,
        size: openRight ? 0.8 : 0.2,
      }
      setStore("multiPane", tabId, "layouts", idx, "pane", newRoot)
      setStore("multiPane", tabId, "layouts", idx, "contents", newLeafId, withPaneIntentName({
        type: "filetree",
        directory,
      }, newLeafId))
      // Don't steal focus — keep existing focused leaf
    },

    /** Toggle a review-workspace pane in the active layout. */
    toggleReviewWorkspace(
      tabId: string,
      directory: string,
      sessionId?: string,
      reviewMode?: import("./types").ReviewMode,
    ) {
      const layout = activeLayout(tabId)
      if (!layout) return
      const sid = sessionId && sessionId !== "new" ? sessionId : "new"
      const mode = reviewMode ?? (sid === "new" ? "uncommitted" : "session")

      const existing = liveContents(layout).find(([, content]) => content.type === "review-workspace")
      if (!existing && Object.values(layout.contents).some((content) => content.type === "review-workspace")) {
        const idx = activeLayoutIndex(tabId)
        if (idx !== -1) setStore("multiPane", tabId, "layouts", idx, "contents", pruneContents(layout))
      }
      if (existing) {
        const ids = paneList(layout.pane)
        if (ids.length > 1) {
          const idx = activeLayoutIndex(tabId)
          if (idx === -1) return
          reduceInLayout(tabId, { type: "close", id: existing[0] })
          const nextLayout = store.multiPane[tabId]!.layouts[idx]
          setStore("multiPane", tabId, "layouts", idx, "contents", pruneContents(nextLayout))
        }
        return
      }

      const idx = activeLayoutIndex(tabId)
      if (idx === -1) return
      const newLeafId = generateId("leaf")
      const currentRoot = clonePane(layout.pane)
      const newRoot: Pane = {
        t: "split",
        dir: "v",
        a: currentRoot,
        b: { t: "leaf", id: newLeafId },
        size: 0.65,
      }
      setStore("multiPane", tabId, "layouts", idx, "pane", newRoot)
      setStore(
        "multiPane",
        tabId,
        "layouts",
        idx,
        "contents",
        newLeafId,
        withPaneIntentName(
          {
            type: "review-workspace",
            directory,
            sessionId: sid,
            reviewMode: mode,
          },
          newLeafId,
        ),
      )
      setStore("multiPane", tabId, "layouts", idx, "focus", newLeafId)
    },

    /** Get all leaf IDs for the active layout */
    leafIds(tabId: string): string[] {
      const layout = activeLayout(tabId)
      if (!layout) return []
      return paneList(layout.pane)
    },
  }
}
