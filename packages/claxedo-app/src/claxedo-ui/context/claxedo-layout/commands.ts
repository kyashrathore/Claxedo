import type { PaneContent, PaneDir, TabItem } from "./types"

export type LayoutCommand =
  | {
      type: "RouteIntentReceived"
      intent: {
        workspaceId: string | undefined
        tabId: string | undefined
        sessionId: string | undefined
        pageId: string | undefined
      }
    }
  | { type: "SplitToggleRequested" }
  | { type: "SplitFocusRequested"; groupId: string }
  | { type: "SplitSizesSetRequested"; sizes: number[] }
  | { type: "SplitGroupCloseRequested"; groupId: string }
  | { type: "TabActivateRequested"; groupId: string; tabId: string }
  | { type: "TabCloseRequested"; groupId: string; tabId: string }
  | { type: "TabCloseActiveRequested"; groupId: string }
  | { type: "TabActivateByIndexRequested"; groupId: string; index: number }
  | { type: "TabActivateNextRequested"; groupId: string }
  | { type: "TabActivatePreviousRequested"; groupId: string }
  | { type: "TabReopenLastRequested"; groupId: string }
  | { type: "TabMoveWithinGroupRequested"; groupId: string; tabId: string; toIndex: number }
  | { type: "TabPatchRequested"; groupId: string; tabId: string; patch: Partial<TabItem> }
  | { type: "TabTitleUpdateRequested"; groupId: string; tabId: string; title: string }
  | { type: "TabBadgeUpdateRequested"; groupId: string; tabId: string; badge: TabItem["badge"] }
  | { type: "TabAddRequested"; groupId: string; tab: Omit<TabItem, "id"> }
  | {
      type: "SessionTabAddRequested"
      groupId: string
      directory: string
      sessionId: string
      title: string
      badge?: TabItem["badge"]
    }
  | { type: "TerminalTabAddRequested"; groupId: string; directory: string; terminalId: string; title: string }
  | {
      type: "ReviewTabAddRequested"
      groupId: string
      directory: string
      sessionId: string
      title: string
      badge?: TabItem["badge"]
      reviewMode?: TabItem["reviewMode"]
      reviewFromRef?: string
      reviewToRef?: string
    }
  | { type: "ContextTabAddRequested"; groupId: string; directory: string; sessionId: string; title: string }
  | { type: "FileTabAddRequested"; groupId: string; directory: string; filePath: string; title: string }
  | { type: "PageTabAddRequested"; groupId: string; pageId: string; title: string; directory?: string }
  | { type: "TabMoveAcrossGroupsRequested"; tabId: string; fromGroupId: string; toGroupId: string | "new" }
  | { type: "GroupWorktreeDefaultSetRequested"; groupId: string; directory: string | null }
  | { type: "GroupWorktreePinnedSetRequested"; groupId: string; directory: string | null }
  | { type: "PaneSplitRequested"; tabId: string; leafId: string; dir: PaneDir; content?: PaneContent }
  | { type: "PaneCloseRequested"; tabId: string; leafId: string }
  | { type: "PaneResizeRequested"; tabId: string; path: string; size: number }
  | { type: "PaneFocusRequested"; tabId: string; leafId: string }
  | { type: "PaneZoomRequested"; tabId: string; leafId: string }
  | { type: "PaneContentSetRequested"; tabId: string; leafId: string; content: PaneContent }
  | { type: "ProcessPaneToggleRequested"; directory?: string }
  | { type: "ProcessPaneOpenRequested"; directory?: string }
  | { type: "ProcessPaneTargetSetRequested"; directory: string | null }
  | { type: "ProcessPaneCrashFlagSetRequested"; value: boolean }

export type LayoutDispatch = (command: LayoutCommand) => string | undefined | void

type SplitBridge = {
  toggle: () => void
  setFocus: (groupId: string) => void
  setSizes: (sizes: number[]) => void
  closeGroup: (groupId: string) => void
  moveTab: (tabId: string, fromGroupId: string, toGroupId: string | "new") => void
}

type GroupTabBridge = {
  add: (tab: Omit<TabItem, "id">) => string | undefined
  addSession: (directory: string, sessionId: string, title: string, badge?: TabItem["badge"]) => string | undefined
  addTerminal: (directory: string, terminalId: string, title: string) => string | undefined
  addReview: (
    directory: string,
    sessionId: string,
    title: string,
    badge?: TabItem["badge"],
    reviewMode?: TabItem["reviewMode"],
    reviewFromRef?: string,
    reviewToRef?: string,
  ) => string | undefined
  addContext: (directory: string, sessionId: string, title: string) => string | undefined
  addFile: (directory: string, filePath: string, title: string) => string | undefined
  addPage: (pageId: string, title: string, directory?: string) => string | undefined
  patch: (id: string, patch: Partial<TabItem>) => void
  updateTitle: (id: string, title: string) => void
  updateBadge: (id: string, badge: TabItem["badge"]) => void
  closeActive: () => void
  activateByIndex: (index: number) => void
  activateNext: () => void
  activatePrevious: () => void
  reopenLast: () => void
  move: (tabId: string, toIndex: number) => void
  close: (tabId: string) => void
  setActive: (tabId: string) => void
}

type GroupWorktreeBridge = {
  setDefault: (directory: string | null) => void
  setPinned: (directory: string | null) => void
}

type MultiPaneBridge = {
  splitLeaf: (tabId: string, dir: PaneDir, atLeafId: string, content?: PaneContent) => string | undefined
  closeLeaf: (tabId: string, leafId: string) => void
  resize: (tabId: string, path: string, size: number) => void
  focus: (tabId: string, leafId: string) => void
  zoom: (tabId: string, leafId: string) => void
  setContent: (tabId: string, leafId: string, content: PaneContent) => void
}

type ProcessPaneBridge = {
  requestToggle: (directory?: string) => void
  requestOpen: (directory?: string) => void
  setTargetDirectory: (directory: string | null) => void
  setCrashedWhileClosed: (value: boolean) => void
}

export function createLayoutDispatcher(input: {
  split: SplitBridge
  groupTabs: (groupId: string) => GroupTabBridge
  groupWorktree: (groupId: string) => GroupWorktreeBridge
  multiPane: MultiPaneBridge
  processPane: ProcessPaneBridge
}): LayoutDispatch {
  const { split, groupTabs, groupWorktree, multiPane, processPane } = input

  return (command) => {
    if (command.type === "RouteIntentReceived") {
      return
    }

    if (command.type === "SplitToggleRequested") {
      split.toggle()
      return
    }

    if (command.type === "SplitFocusRequested") {
      split.setFocus(command.groupId)
      return
    }

    if (command.type === "SplitSizesSetRequested") {
      split.setSizes(command.sizes)
      return
    }

    if (command.type === "SplitGroupCloseRequested") {
      split.closeGroup(command.groupId)
      return
    }

    if (command.type === "TabActivateRequested") {
      groupTabs(command.groupId).setActive(command.tabId)
      return
    }

    if (command.type === "TabActivateByIndexRequested") {
      groupTabs(command.groupId).activateByIndex(command.index)
      return
    }

    if (command.type === "TabActivateNextRequested") {
      groupTabs(command.groupId).activateNext()
      return
    }

    if (command.type === "TabActivatePreviousRequested") {
      groupTabs(command.groupId).activatePrevious()
      return
    }

    if (command.type === "TabCloseRequested") {
      groupTabs(command.groupId).close(command.tabId)
      return
    }

    if (command.type === "TabCloseActiveRequested") {
      groupTabs(command.groupId).closeActive()
      return
    }

    if (command.type === "TabReopenLastRequested") {
      groupTabs(command.groupId).reopenLast()
      return
    }

    if (command.type === "TabMoveWithinGroupRequested") {
      groupTabs(command.groupId).move(command.tabId, command.toIndex)
      return
    }

    if (command.type === "TabPatchRequested") {
      groupTabs(command.groupId).patch(command.tabId, command.patch)
      return
    }

    if (command.type === "TabTitleUpdateRequested") {
      groupTabs(command.groupId).updateTitle(command.tabId, command.title)
      return
    }

    if (command.type === "TabBadgeUpdateRequested") {
      groupTabs(command.groupId).updateBadge(command.tabId, command.badge)
      return
    }

    if (command.type === "TabAddRequested") {
      return groupTabs(command.groupId).add(command.tab)
    }

    if (command.type === "SessionTabAddRequested") {
      return groupTabs(command.groupId).addSession(command.directory, command.sessionId, command.title, command.badge)
    }

    if (command.type === "TerminalTabAddRequested") {
      return groupTabs(command.groupId).addTerminal(command.directory, command.terminalId, command.title)
    }

    if (command.type === "ReviewTabAddRequested") {
      return groupTabs(command.groupId).addReview(
        command.directory,
        command.sessionId,
        command.title,
        command.badge,
        command.reviewMode,
        command.reviewFromRef,
        command.reviewToRef,
      )
    }

    if (command.type === "ContextTabAddRequested") {
      return groupTabs(command.groupId).addContext(command.directory, command.sessionId, command.title)
    }

    if (command.type === "FileTabAddRequested") {
      return groupTabs(command.groupId).addFile(command.directory, command.filePath, command.title)
    }

    if (command.type === "PageTabAddRequested") {
      return groupTabs(command.groupId).addPage(command.pageId, command.title, command.directory)
    }

    if (command.type === "TabMoveAcrossGroupsRequested") {
      split.moveTab(command.tabId, command.fromGroupId, command.toGroupId)
      return
    }

    if (command.type === "GroupWorktreeDefaultSetRequested") {
      groupWorktree(command.groupId).setDefault(command.directory)
      return
    }

    if (command.type === "GroupWorktreePinnedSetRequested") {
      groupWorktree(command.groupId).setPinned(command.directory)
      return
    }

    if (command.type === "PaneSplitRequested") {
      return multiPane.splitLeaf(command.tabId, command.dir, command.leafId, command.content)
    }

    if (command.type === "PaneCloseRequested") {
      multiPane.closeLeaf(command.tabId, command.leafId)
      return
    }

    if (command.type === "PaneResizeRequested") {
      multiPane.resize(command.tabId, command.path, command.size)
      return
    }

    if (command.type === "PaneFocusRequested") {
      multiPane.focus(command.tabId, command.leafId)
      return
    }

    if (command.type === "PaneZoomRequested") {
      multiPane.zoom(command.tabId, command.leafId)
      return
    }

    if (command.type === "PaneContentSetRequested") {
      multiPane.setContent(command.tabId, command.leafId, command.content)
      return
    }

    if (command.type === "ProcessPaneToggleRequested") {
      processPane.requestToggle(command.directory)
      return
    }

    if (command.type === "ProcessPaneOpenRequested") {
      processPane.requestOpen(command.directory)
      return
    }

    if (command.type === "ProcessPaneTargetSetRequested") {
      processPane.setTargetDirectory(command.directory)
      return
    }

    if (command.type === "ProcessPaneCrashFlagSetRequested") {
      processPane.setCrashedWhileClosed(command.value)
      return
    }

    const never: never = command
    return never
  }
}
