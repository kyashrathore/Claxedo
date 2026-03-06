import {
  computeLeafRects,
  computeSplitHandles,
  type LeafRect,
  type SplitHandle,
} from "../../components/terminal-pane-layout"
import type { ClaxedoLayoutStore, GroupState, PaneContent, TabItem } from "./types"

type RenderTarget = {
  tabId: string
  type: TabItem["type"]
  directory: string
}

export type MultiPaneLeafView = {
  id: string
  rect: LeafRect
  content: PaneContent | undefined
  focused: boolean
  zoomed: boolean
  hidden: boolean
  floating: boolean
  title: string
}

function ordered(group: GroupState) {
  const ids = group.tabs.order.length ? group.tabs.order : group.tabs.items.map((tab) => tab.id)
  const seen = new Set(ids)
  const missing = group.tabs.items.filter((tab) => !seen.has(tab.id)).map((tab) => tab.id)
  const next = missing.length ? [...ids, ...missing] : ids
  return next.map((id) => group.tabs.items.find((tab) => tab.id === id)).filter((tab): tab is TabItem => !!tab)
}

function active(group: GroupState) {
  if (!group.tabs.activeId) return
  return group.tabs.items.find((tab) => tab.id === group.tabs.activeId)
}

function contentTitle(content: PaneContent | undefined) {
  if (!content) return "Empty"
  if (content.title) return content.title
  if (content.type === "session") return "Session"
  if (content.type === "terminal") return "Terminal"
  if (content.type === "file") return content.filePath?.split("/").at(-1) ?? "File"
  if (content.type === "review") return "Review"
  if (content.type === "page") return "Page"
  if (content.type === "context") return "Context"
  if (content.type === "process") return "Processes"
  if (content.type === "filetree") return "Files"
  return content.type
}

export function createLayoutSelectors(input: { store: ClaxedoLayoutStore }) {
  const { store } = input

  const group = (groupId: string) => store.groups.find((item) => item.id === groupId)

  const groupActiveTab = (groupId: string) => {
    const item = group(groupId)
    if (!item) return
    const current = active(item)
    if (!current) return
    const pinned = item.worktree.pinned
    if (!pinned || current.directory === pinned) return current
    return ordered(item).find((tab) => tab.directory === pinned && tab.type !== "process") ?? current
  }

  const visibleGroupTabs = (groupId: string) => {
    const item = group(groupId)
    if (!item) return []
    const pinned = item.worktree.pinned
    if (!pinned) return ordered(item)
    return ordered(item).filter((tab) => tab.pinned || tab.directory === pinned)
  }

  const visibleGroups = () => {
    if (!store.split.hidden) return store.groups
    const focused = store.groups.find((item) => item.id === store.split.focusedId)
    if (focused) return [focused]
    return store.groups.length ? [store.groups[0]] : []
  }

  const activeRenderTarget = (groupId: string): RenderTarget | undefined => {
    const item = groupActiveTab(groupId)
    if (!item) return
    return {
      tabId: item.id,
      type: item.type,
      directory: item.directory,
    }
  }

  const multiPaneLeafView = (tabId: string): MultiPaneLeafView[] => {
    const state = store.multiPane[tabId]
    if (!state) return []
    const layout = state.layouts.find((item) => item.id === state.activeLayoutId) ?? state.layouts[0]
    if (!layout) return []
    const rects = computeLeafRects(layout.pane)
    const floatingId = layout.floating
    return rects.map((rect) => {
      const content = layout.contents[rect.id]
      const isFloating = floatingId === rect.id
      // When a leaf is floating, it's hidden from normal layout (rendered as overlay)
      // Its sibling takes full space (effectively zoomed)
      const hasFloating = floatingId !== undefined && floatingId !== rect.id
      return {
        id: rect.id,
        rect,
        content,
        focused: layout.focus === rect.id,
        zoomed: layout.zoom === rect.id || hasFloating,
        hidden: (layout.zoom !== undefined && layout.zoom !== rect.id) || isFloating,
        floating: isFloating,
        title: contentTitle(content),
      }
    })
  }

  const multiPaneSplitHandles = (tabId: string): SplitHandle[] => {
    const state = store.multiPane[tabId]
    if (!state) return []
    const layout = state.layouts.find((item) => item.id === state.activeLayoutId) ?? state.layouts[0]
    if (!layout) return []
    return computeSplitHandles(layout.pane)
  }

  return {
    group,
    visibleGroups,
    visibleGroupTabs,
    groupActiveTab,
    activeRenderTarget,
    multiPaneLeafView,
    multiPaneSplitHandles,
  }
}
