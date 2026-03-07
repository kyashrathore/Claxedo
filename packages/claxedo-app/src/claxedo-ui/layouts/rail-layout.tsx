/**
 * Rail Layout
 *
 * The main layout component implementing the "Rail + Tab" architecture.
 * This wraps/replaces the upstream layout when Claxedo mode is enabled.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                        Titlebar                              │
 * ├────────┬────────────────────────────────────────────────────┤
 * │        │  [Tab1] [Tab2] [Tab3] [+]  │  [Search]  │  [...]  │
 * │  Rail  ├────────────────────────────────────────────────────┤
 * │        │                                                     │
 * │        │               Tab Content Area                      │
 * │        │                                                     │
 * └────────┴────────────────────────────────────────────────────┘
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  type ParentProps,
  type JSX,
  type Accessor,
} from "solid-js"
import { DragDropProvider, DragDropSensors, DragOverlay, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useClaxedoLayout, ClaxedoLayoutProvider, type TabItem } from "../context/claxedo-layout"
import { RailSidebar, type ProjectItem, type WorkspaceItem } from "./rail-sidebar"
import { TopTabBar, TabDragOverlay, WorkspaceBar, type WorkspaceBarProject } from "./top-tab-bar"
import { GroupContentRenderer } from "../components/group-content-renderer"
import { toggleMarkdownPreview, isMarkdownPath } from "../components/tab-file"
import { SDKProvider } from "@/context/sdk"
import { useCommand, useServer, getAvatarColors } from "@opencode-ai/claxedo-app"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { getFilename } from "@opencode-ai/util/path"
import { createDebugLogger } from "../../overrides/utils/debug"
import "../styles.css"

export type RailLayoutProps = ParentProps<{
  /**
   * List of projects to display in the rail
   */
  projects: ProjectItem[]

  /**
   * Currently active project ID
   */
  activeProjectId?: string

  /**
   * Currently active worktree directory (route)
   */
  activeWorkspaceId?: string

  /**
   * Currently active session ID
   */
  activeSessionId?: string

  /**
   * Home directory for path shortening
   */
  homedir?: string

  /**
   * Callback when a project is selected
   */
  onProjectSelect?: (project: ProjectItem) => void

  /**
   * Callback when a worktree is selected
   */
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void

  /**
   * Callback when a session is selected
   */
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void

  /**
   * Callback to create a new project
   */
  onNewProject?: () => void

  /**
   * Callback to create a new worktree in a project
   */
  onNewWorkspace?: (project: ProjectItem) => Promise<import("./top-tab-bar").WorkspaceBarItem | undefined>

  /**
   * Callback to open settings
   */
  onSettings?: () => void

  /**
   * Callback to open help
   */
  onHelp?: () => void

  /**
   * Callback to create a new session (with workspace directory)
   */
  onNewSession?: (workspaceDir: string, groupId?: string) => void
  onDeleteSession?: (session: import("./rail-sidebar").SessionItem) => void
  onArchiveSession?: (session: import("./rail-sidebar").SessionItem) => void
  onDeleteWorkspace?: (workspace: import("./rail-sidebar").WorkspaceItem) => void
  onRemoveProject?: (project: import("./rail-sidebar").ProjectItem) => void

  /**
   * Callback to create a new terminal
   * @param workspaceDir - The workspace directory to create the terminal in
   * @param command - Optional command to run in the terminal (e.g., "claude --dangerously-skip-permissions")
   * @param title - Optional title for the terminal tab (e.g., "Claude", "Codex")
   */
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, groupId?: string) => void

  /**
   * Callback to create a new page
   */
  onNewPage?: (groupId?: string) => void

  /**
   * Callback to create a new review workspace tab
   */
  onNewReview?: (workspaceDir: string, groupId?: string) => void

  /**
   * Callback when a tab is selected
   */
  onTabSelect?: (tab: import("../context/claxedo-layout").TabItem) => void

  /**
   * Callback when a tab is closed (to sync URL with the new active tab)
   */
  onTabClose?: (nextActiveTab: import("../context/claxedo-layout").TabItem | undefined) => void

  /**
   * Render function for empty state (shown when no project selected)
   */
  renderEmpty?: () => JSX.Element

  /**
   * Titlebar component to render
   */
  titlebar?: JSX.Element

  /**
   * Additional content for the top bar (right side)
   */
  topBarRight?: () => JSX.Element
}>

// Check if running in Tauri desktop environment
const isTauri = () => typeof window !== "undefined" && !!(window as any).__TAURI__

type GroupPanelProps = {
  groupId: string
  isPrimary: boolean
  props: RailLayoutProps
  workspaceBarProjects: () => WorkspaceBarProject[]
  worktreeInfo: (dir: string) => { name: string; isMain: boolean; tooltip?: string } | undefined
  sidebarPinned: () => boolean
  mobileSidebarOpen: () => boolean
  toggleMobileSidebar: () => void
  allProjects: ProjectItem[]
  visibleWorkspaces: Set<string>
  onToggleWorkspace: (dir: string, visible: boolean) => void
}

function GroupPanel(gp: GroupPanelProps) {
  const claxedo = useClaxedoLayout()
  const server = useServer()
  const flow = createDebugLogger("terminal.flow", "terminal:flow", {
    legacyKey: "opencode.debug.terminal",
  })
  const wt = claxedo.groupWorktree(gp.groupId)
  const tabs = createMemo(() => claxedo.groupTabs(gp.groupId))
  const activeTab = createMemo(() => claxedo.select.groupActiveTab(gp.groupId))

  const hasProjects = () => gp.props.projects.length > 0

  /** Resolve a real workspace directory, excluding process-tab sentinel values. */
  const resolveDir = () => {
    const d = wt.default()
    if (d && d !== "__process__") return d
    const active = activeTab()
    if (active && active.type !== "process") return active.directory
    return undefined
  }

  const resolveSessionId = () => {
    const current = activeTab()
    if (!current) return
    if (current.sessionId && current.sessionId !== "new") return current.sessionId
    const layout = claxedo.multiPane.activeLayout(current.id)
    const values = layout ? Object.values(layout.contents) : []
    return values.find(
      (content) =>
        (content.type === "session" ||
          content.type === "review" ||
          content.type === "review-workspace" ||
          content.type === "context") &&
        content.sessionId &&
        content.sessionId !== "new",
    )?.sessionId
  }

  const hasCurrentProcessTab = createMemo(() => {
    const dir = resolveDir()
    if (!dir) return false
    return tabs().items().some((t) => t.type === "process" && t.directory === dir)
  })

  return (
    <div class="flex flex-col h-full w-full overflow-hidden">
      {/* When no projects exist, show only the empty state */}
      <Show when={!hasProjects()}>
        <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
          <span class="text-14-regular">No projects yet. Create one to get started.</span>
          <Button icon="plus-small" onClick={() => gp.props.onNewProject?.()}>
            New Project
          </Button>
        </div>
      </Show>

      <Show when={hasProjects()}>
      {/* Workspace bar - shows projects and their workspaces */}
      <WorkspaceBar
        projects={gp.workspaceBarProjects()}
        defaultDirectory={wt.default()}
        pinnedDirectory={wt.pinned()}
        activeProjectId={gp.props.activeProjectId}
        onNewSession={() => {
          const dir = resolveDir()
          if (!dir) return
          flow.log("new session button", {
            groupId: gp.groupId,
            dir,
            defaultDir: wt.default(),
            activeTabId: tabs().activeId(),
            activeTabDir: tabs().active()?.directory,
          })
          gp.props.onNewSession?.(dir, gp.groupId)
        }}
        onNewTerminal={(command, title) => {
          const dir = resolveDir()
          if (!dir) return
          flow.log("new terminal button", {
            groupId: gp.groupId,
            dir,
            command,
            title,
            defaultDir: wt.default(),
            activeTabId: tabs().activeId(),
            activeTabDir: tabs().active()?.directory,
          })
          gp.props.onNewTerminal?.(dir, command, title, gp.groupId)
        }}
        onNewPage={() => gp.props.onNewPage?.(gp.groupId)}
        onProcesses={() => {
          const dir = resolveDir()
          if (!dir) return
          const process = tabs().items().find((t) => t.type === "process" && t.directory === dir)
          claxedo.processPane.setTargetDirectory?.(dir)
          claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })
          if (process) {
            tabs().setActive(process.id)
            return
          }
          tabs().addProcess(dir)
        }}
        onSettings={gp.props.onSettings}
        showProcesses={!hasCurrentProcessTab()}
        allProjects={gp.allProjects}
        visibleWorkspaces={gp.visibleWorkspaces}
        onToggleWorkspace={gp.onToggleWorkspace}
        onWorktreeClick={(projectId, dir) => {
          flow.log("workspace bar click", {
            groupId: gp.groupId,
            projectId,
            clickedDir: dir,
            currentDefault: wt.default(),
            currentPinned: wt.pinned(),
            activeTabId: tabs().activeId(),
            activeTabDir: tabs().active()?.directory,
          })
          claxedo.processPane.setTargetDirectory?.(dir)
          claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })
          const project = gp.props.projects.find((p) => p.id === projectId)
          if (project && gp.props.onWorkspaceSelect) {
            gp.props.onWorkspaceSelect(project, dir)
            return
          }
          claxedo.workspaceRecency.recordAccess(projectId, dir)
          if (wt.pinned() && wt.pinned() !== dir) wt.setPinned(null)
          wt.setDefault(dir)
        }}
        onWorktreeDblClick={(projectId, dir) => {
          claxedo.workspaceRecency.recordAccess(projectId, dir)
          wt.setDefault(dir)
          if (wt.pinned() === dir) {
            wt.setPinned(null)
            return
          }
          wt.setPinned(dir)
        }}
        onProjectClick={(projectId) => {
          const proj = gp.props.projects.find((p) => p.id === projectId)
          if (!proj) return
          claxedo.processPane.setTargetDirectory?.(proj.worktree)
          claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })
          if (gp.props.onWorkspaceSelect) {
            gp.props.onWorkspaceSelect(proj, proj.worktree)
            return
          }
          if (wt.pinned() && wt.pinned() !== proj.worktree) wt.setPinned(null)
          wt.setDefault(proj.worktree)
        }}
        onNewWorktree={async (projectId) => {
          const proj = gp.props.projects.find((p) => p.id === projectId)
          if (!proj) return
          return gp.props.onNewWorkspace?.(proj)
        }}
        onWorktreeDelete={async (projectId, workspace) => {
          if (!gp.props.onDeleteWorkspace) return
          const proj = gp.props.projects.find((p) => p.id === projectId)
          const isCloud = !server.isLocal()
          await gp.props.onDeleteWorkspace({
            id: workspace.id,
            directory: workspace.directory,
            name: workspace.name,
            isMain: workspace.directory === proj?.worktree,
            projectWorktree: proj?.worktree,
            isCloud,
            canDelete: true,
          })
          claxedo.cleanupDeletedWorktree(workspace.directory, projectId)
        }}
        class="shrink-0"
      />

      {/* Top bar with tabs */}
      <div
        class="flex items-center shrink-0"
        onPointerDown={() => claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })}
      >
        <TopTabBar
          groupId={gp.groupId}
          onNewReview={() => {
            const dir = resolveDir()
            if (!dir) return
            gp.props.onNewReview?.(dir, gp.groupId)
          }}
          onToggleReviewPane={() => {
            const dir = resolveDir()
            if (!dir) return
            const current = activeTab()
            if (!current) return
            const sessionId = resolveSessionId()
            const mode = sessionId ? "session" : "uncommitted"
            claxedo.multiPane.toggleReviewWorkspace(current.id, dir, sessionId, mode)
          }}
          onTabSelect={gp.props.onTabSelect}
          onTabClose={gp.props.onTabClose}
          onToggleFileTree={() => {
            const dir = resolveDir()
            if (!dir) return
            const current = activeTab()
            if (!current) return
            claxedo.dispatch({
              type: "FileTreePaneToggleRequested",
              tabId: current.id,
              directory: dir,
            })
          }}
          fileTreeActive={(() => {
            const current = activeTab()
            return current ? claxedo.multiPane.hasFileTree(current.id) : false
          })()}
          reviewPaneActive={(() => {
            const current = activeTab()
            return current ? claxedo.multiPane.hasReviewWorkspace(current.id) : false
          })()}
          onStartAllProcesses={() => claxedo.processPane.requestStartAll()}
          onStopAllProcesses={() => claxedo.processPane.requestStopAll()}
          onAddProcess={() => claxedo.processPane.requestAddProcess()}
          onSidebarToggle={() => {
            if (window.innerWidth < 768) {
              gp.toggleMobileSidebar()
            } else {
              claxedo.rail.toggle()
            }
          }}
          sidebarPinned={gp.sidebarPinned()}
          mobileSidebarOpen={gp.mobileSidebarOpen()}
          showSidebarToggle={gp.isPrimary}
          worktreeInfo={gp.worktreeInfo}
          class="flex-1 min-w-0"
        />

        {/* Right side content (search, share, etc.) - only in primary group */}
        <Show when={gp.isPrimary && gp.props.topBarRight}>
          <div class="flex items-center gap-2 px-3 shrink-0 border-b border-border-weak-base h-10 box-content bg-background-base">
            {gp.props.topBarRight?.()}
          </div>
        </Show>
      </div>

      {/* Content area */}
      <div class="relative flex-1 min-h-0 overflow-hidden">
        {/* Main content - rendered by GroupContentRenderer based on active tab.
            Do not gate on route-level activeWorkspaceId; groups can have active tabs
            for workspaces not reflected in the current URL (split/group-specific state). */}
        <GroupContentRenderer
          groupId={gp.groupId}
          renderEmpty={() => (
            <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
              <span class="text-14-regular">Select a session or create a new one</span>
              <Button icon="plus-small" onClick={() => gp.props.onNewProject?.()}>
                New Project
              </Button>
            </div>
          )}
        />
      </div>
      </Show>
    </div>
  )
}

/** Draggable handle between split groups to resize them. */
function SplitResizeHandle(props: { index: number }) {
  const claxedo = useClaxedoLayout()
  const isH = () => claxedo.split.direction() === "h"

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const container = el.parentElement
    if (!container) return

    const rect = container.getBoundingClientRect()
    const span = isH() ? rect.width : rect.height
    if (span <= 0) return

    const startPos = isH() ? e.clientX : e.clientY
    const startSizes = [...claxedo.split.sizes()]
    const a = props.index - 1
    const b = props.index

    el.setPointerCapture(e.pointerId)
    document.body.style.userSelect = "none"
    document.body.style.cursor = isH() ? "col-resize" : "row-resize"

    const onMove = (me: PointerEvent) => {
      const pos = isH() ? me.clientX : me.clientY
      const delta = (pos - startPos) / span
      const minFrac = 0.15
      const newA = Math.max(minFrac, Math.min(startSizes[a] + startSizes[b] - minFrac, startSizes[a] + delta))
      const newB = startSizes[a] + startSizes[b] - newA
      const next = [...startSizes]
      next[a] = newA
      next[b] = newB
      claxedo.dispatch({ type: "SplitSizesSetRequested", sizes: next })
    }

    const onUp = () => {
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
    }

    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
  }

  return (
    <div
      class={
        isH()
          ? "w-px shrink-0 bg-border-weak-base cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors max-md:hidden"
          : "h-px shrink-0 bg-border-weak-base cursor-row-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors max-md:hidden"
      }
      onPointerDown={handlePointerDown}
    />
  )
}

/**
 * Shared DragDropProvider for cross-panel tab dragging.
 * Wraps all split groups so sortables/droppables from different panels
 * register with the same provider.
 */
function SharedTabDragDrop(props: { children: JSX.Element }) {
  const claxedo = useClaxedoLayout()
  const [draggedTab, setDraggedTab] = createSignal<TabItem | undefined>()

  const GROUP_ZONE_PREFIX = "group-zone-"

  const handleDragStart = (event: { draggable: { id: unknown } }) => {
    const id = event.draggable?.id
    if (typeof id !== "string") return

    // Find the tab across all groups
    const groupId = claxedo.findTabGroup(id)
    if (!groupId) return
    const tab = claxedo
      .groupTabs(groupId)
      .orderedItems()
      .find((t) => t.id === id)
    setDraggedTab(tab)
  }

  const handleDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event

    if (draggable && droppable) {
      const dragId = draggable.id.toString()
      const dropId = droppable.id.toString()

      const fromGroupId = claxedo.findTabGroup(dragId)
      // Determine target group: either from a tab ID or from a group zone droppable
      const toGroupId = dropId.startsWith(GROUP_ZONE_PREFIX)
        ? dropId.slice(GROUP_ZONE_PREFIX.length)
        : claxedo.findTabGroup(dropId)

      // Cross-group transfer: move tab on drop
      if (fromGroupId && toGroupId && fromGroupId !== toGroupId) {
        claxedo.dispatch({ type: "TabMoveAcrossGroupsRequested", tabId: dragId, fromGroupId, toGroupId })
      }
    }

    setDraggedTab(undefined)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const dragId = draggable.id.toString()
    const dropId = droppable.id.toString()

    // Skip group zone droppables for reorder — they only matter on drop
    if (dropId.startsWith(GROUP_ZONE_PREFIX)) return

    const fromGroupId = claxedo.findTabGroup(dragId)
    const toGroupId = claxedo.findTabGroup(dropId)

    // Same group → check if same worktree before reorder
    if (fromGroupId && toGroupId && fromGroupId === toGroupId) {
      const tabs = claxedo.groupTabs(fromGroupId)
      const dragTab = tabs.items().find((t) => t.id === dragId)
      const dropTab = tabs.items().find((t) => t.id === dropId)

      // Only allow reorder if tabs are in same worktree (directory)
      if (!dragTab || !dropTab || !claxedo.canDragTabBetweenWorktrees(dragTab.directory, dropTab.directory)) {
        return
      }

      const ids = tabs.order().length ? tabs.order() : tabs.orderedItems().map((t) => t.id)
      const fromIndex = ids.indexOf(dragId)
      const toIndex = ids.indexOf(dropId)
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        tabs.move(dragId, toIndex)
      }
    }
    // Different groups → no-op (transfer happens in handleDragEnd)
  }

  return (
    <DragDropProvider
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      collisionDetector={closestCenter}
    >
      <DragDropSensors />
      {props.children}
      <DragOverlay>
        <TabDragOverlay tab={draggedTab()} />
      </DragOverlay>
    </DragDropProvider>
  )
}

function RailLayoutBody(props: RailLayoutProps) {
  const claxedo = useClaxedoLayout()
  const command = useCommand()
  const server = useServer()

  const sidebarPinned = () => claxedo.rail.pinned()

  // Dispatch terminal fit when workspace-level split state changes
  // (toggle split, show/hide split). Deferred to skip the initial mount.
  createEffect(
    on(
      () => [claxedo.split.active(), claxedo.split.hidden()],
      () => {
        setTimeout(() => window.dispatchEvent(new Event("opencode:terminal-fit")), 150)
      },
      { defer: true },
    ),
  )

  // Mobile sidebar state - separate from desktop pinned state
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false)

  const toggleMobileSidebar = () => setMobileSidebarOpen(!mobileSidebarOpen())
  const closeMobileSidebar = () => setMobileSidebarOpen(false)

  // Track explicitly visible workspaces (checkbox state)
  // These are workspaces the user has chosen to show in the bar even without open tabs
  const [visibleWorkspaces, setVisibleWorkspaces] = createSignal<Set<string>>(new Set())

  const toggleWorkspaceVisibility = (dir: string, visible: boolean) => {
    setVisibleWorkspaces((prev) => {
      const next = new Set(prev)
      if (visible) next.add(dir)
      else next.delete(dir)
      return next
    })
  }

  // Register keyboard shortcuts
  command.register(() => [
    {
      id: "claxedo.tab.close",
      title: "Close Tab",
      category: "View",
      keybind: "mod+w",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).closeActive()
      },
    },
    {
      id: "claxedo.tab.next",
      title: "Next Tab",
      category: "View",
      keybind: "mod+tab",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).activateNext()
      },
    },
    {
      id: "claxedo.tab.previous",
      title: "Previous Tab",
      category: "View",
      keybind: "mod+shift+tab",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).activatePrevious()
      },
    },
    {
      id: "claxedo.tab.reopen",
      title: "Reopen Closed Tab",
      category: "View",
      keybind: "mod+shift+t",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).reopenLast()
      },
    },
    {
      id: "claxedo.sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      keybind: "mod+b",
      onSelect: () => claxedo.rail.toggle(),
    },
    // Tab switching shortcuts (Cmd+1 through Cmd+9)
    // Index into visible tabs grouped by directory (matching visual tab bar order)
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `claxedo.tab.${i + 1}`,
      title: `Switch to Tab ${i + 1}`,
      category: "View",
      keybind: `mod+${i + 1}`,
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        if (!focusedId) return
        const tabs = claxedo.groupTabs(focusedId)
        const wt = claxedo.groupWorktree(focusedId)
        const pinned = wt.pinned()
        const selected = wt.default()
        const active = tabs.active()
        const scope =
          active &&
          (active.type === "session" ||
            active.type === "review" ||
            active.type === "context" ||
            active.type === "file" ||
            active.type === "page")
            ? active.directory
            : selected
        const tabScopeDir = (tab: TabItem) => {
          if (tab.type === "review" || tab.type === "context" || tab.type === "file" || tab.type === "page") {
            return scope ?? tab.directory
          }
          return tab.directory
        }
        const ordered = tabs.visualOrderedItems()
        const scopeFiltered = pinned
          ? ordered.filter((t) => tabScopeDir(t) === pinned)
          : !scope
            ? ordered
            : ordered.filter((t) => {
                if (t.type === "review" || t.type === "context" || t.type === "file" || t.type === "page")
                  return tabScopeDir(t) === scope
                return true
              })
        const groups = new Map<string, TabItem[]>()
        for (const tab of scopeFiltered) {
          const dir = tabScopeDir(tab)
          const list = groups.get(dir)
          if (list) {
            list.push(tab)
            continue
          }
          groups.set(dir, [tab])
        }
        const visible = Array.from(groups.values()).flat()
        const tab = visible[i]
        if (tab) tabs.setActive(tab.id)
      },
    })),
    // Split view shortcuts
    {
      id: "claxedo.split.toggle",
      title: "Toggle Split View",
      category: "View",
      keybind: "mod+\\",
      onSelect: () => claxedo.dispatch({ type: "SplitToggleRequested" }),
    },
    {
      id: "claxedo.split.focusLeft",
      title: "Focus Left/Top Panel",
      category: "View",
      keybind: "mod+alt+ArrowLeft",
      onSelect: () => {
        const groups = claxedo.split.orderedGroups()
        const focusedId = claxedo.split.focusedId()
        const idx = groups.findIndex((g) => g.id === focusedId)
        if (idx > 0) claxedo.dispatch({ type: "SplitFocusRequested", groupId: groups[idx - 1].id })
      },
    },
    {
      id: "claxedo.split.focusRight",
      title: "Focus Right/Bottom Panel",
      category: "View",
      keybind: "mod+alt+ArrowRight",
      onSelect: () => {
        const groups = claxedo.split.orderedGroups()
        const focusedId = claxedo.split.focusedId()
        const idx = groups.findIndex((g) => g.id === focusedId)
        if (idx < groups.length - 1) claxedo.dispatch({ type: "SplitFocusRequested", groupId: groups[idx + 1].id })
      },
    },
    {
      id: "file.preview.toggle",
      title: "Toggle Markdown Preview",
      category: "View",
      keybind: "mod+shift+v",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        if (!focusedId) return
        const tab = claxedo.groupTabs(focusedId).active()
        if (!tab || tab.type !== "file" || !tab.filePath) return
        if (!isMarkdownPath(tab.filePath)) return
        toggleMarkdownPreview(tab.filePath)
      },
    },
  ])

  // Helper: Get workspaces for a project (main worktree + sandboxes)
  const getProjectWorkspaces = (project: ProjectItem): WorkspaceItem[] => {
    const workspaces: WorkspaceItem[] = []
    const isCloud = !server.isLocal()

    // Main workspace
    // Can only delete main workspace if it's a cloud sandbox
    workspaces.push({
      id: project.worktree,
      directory: project.worktree,
      name: "main",
      isMain: true,
      projectWorktree: project.worktree,
      isCloud,
      canDelete: isCloud,
    })

    // Additional sandboxes
    if (project.sandboxes) {
      for (const sandbox of project.sandboxes) {
        if (sandbox === project.worktree) continue
        workspaces.push({
          id: sandbox,
          directory: sandbox,
          name: getFilename(sandbox),
          projectWorktree: project.worktree,
          isCloud,
          canDelete: true,
        })
      }
    }

    return workspaces
  }

  // Find current project (the one containing activeWorkspaceId)
  const currentProject = createMemo(() => {
    const activeWs = props.activeWorkspaceId
    if (!activeWs) return undefined
    return props.projects.find((p) => p.worktree === activeWs || p.sandboxes?.includes(activeWs))
  })

  // Build workspace bar projects data from open tabs AND explicit visibility
  const workspaceBarProjects = createMemo((): WorkspaceBarProject[] => {
    // Get all open tabs from all groups
    const allTabs: TabItem[] = []
    const groups = claxedo.split.orderedGroups()
    for (const group of groups) {
      const tabs = claxedo.groupTabs(group.id)
      allTabs.push(...tabs.items())
    }

    // Get unique directories from open tabs
    const tabDirs = new Set(allTabs.map((t) => t.directory))

    // Always include each group's selected/pinned workspaces so a workspace
    // chosen in any panel appears in the workspace bar immediately.
    for (const group of groups) {
      const wt = claxedo.groupWorktree(group.id)
      const pinned = wt.pinned()
      if (pinned) tabDirs.add(pinned)
      const selected = wt.default()
      if (selected) tabDirs.add(selected)
    }

    // Add explicitly visible workspaces
    const visible = visibleWorkspaces()
    for (const dir of visible) {
      tabDirs.add(dir)
    }

    return props.projects.flatMap((project) => {
      const workspaces = getProjectWorkspaces(project).filter((workspace) => tabDirs.has(workspace.directory))
      if (workspaces.length === 0) return []
      return [{
        id: project.id,
        name: project.name || getFilename(project.worktree),
        worktree: project.worktree,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          directory: workspace.directory,
          name: workspace.name || getFilename(workspace.directory),
          notification: false,
          isMain: workspace.isMain,
          projectWorktree: workspace.projectWorktree,
          canDelete: workspace.canDelete,
        })),
      }]
    })
  })

  const worktreeInfo = (dir: string) => {
    const proj = props.projects.find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    if (!proj) return
    const isMain = dir === proj.worktree
    const name = isMain ? "main" : getFilename(dir)
    return { name, isMain, tooltip: `🌳 ${name}` }
  }

  const visibleGroups = createMemo(() => claxedo.select.visibleGroups())

  return (
    <div class="flex flex-col w-full h-full bg-background-base overflow-hidden" data-claxedo>
      {/* Desktop window chrome spacer - for macOS traffic lights / Windows title bar */}
      <Show when={!props.titlebar && isTauri()}>
        <div class="h-10 shrink-0 bg-background-base" data-tauri-drag-region />
      </Show>

      {/* Titlebar */}
      <Show when={props.titlebar}>
        <div class="shrink-0">{props.titlebar}</div>
      </Show>

      <div class="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Mobile backdrop - closes sidebar when tapped */}
        <Show when={mobileSidebarOpen()}>
          <div class="fixed inset-0 bg-black/50 z-[90] md:hidden" onClick={closeMobileSidebar} />
        </Show>

        {/* Sidebar container - desktop: floats/pinned, mobile: slide-in overlay */}
        <div
          class={`
            flex flex-col
            transition-all duration-200 ease-out
            ${
              sidebarPinned()
                ? "relative z-10 shrink-0 h-full"
                : "absolute top-0 left-0 bottom-0 z-[100] pointer-events-none"
            }
            max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[100] max-md:pointer-events-auto
            max-md:transition-transform max-md:duration-300 max-md:ease-in-out
            ${mobileSidebarOpen() ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
          `}
        >
          {/* Rail Sidebar - fills full height */}
          <div class="flex-1 min-h-0 h-full">
            <RailSidebar
              projects={props.projects}
              activeProjectId={props.activeProjectId}
              activeWorkspaceId={props.activeWorkspaceId}
              activeSessionId={props.activeSessionId}
              homedir={props.homedir}
              onProjectSelect={(project) => {
                props.onProjectSelect?.(project)
                closeMobileSidebar()
              }}
              onWorkspaceSelect={(project, workspaceDir) => {
                props.onWorkspaceSelect?.(project, workspaceDir)
                closeMobileSidebar()
              }}
              onSessionSelect={(workspaceDir, sessionId) => {
                props.onSessionSelect?.(workspaceDir, sessionId)
                closeMobileSidebar()
              }}
              onNewSession={(workspaceDir) => {
                props.onNewSession?.(workspaceDir)
                closeMobileSidebar()
              }}
              onDeleteSession={props.onDeleteSession}
              onArchiveSession={props.onArchiveSession}
              onDeleteWorkspace={props.onDeleteWorkspace}
              onRemoveProject={props.onRemoveProject}
              onNewWorkspace={async (project) => {
                const result = await props.onNewWorkspace?.(project)
                if (result) {
                  toggleWorkspaceVisibility(result.directory, true)
                }
                closeMobileSidebar()
                return result
              }}
              onNewProject={() => {
                props.onNewProject?.()
                closeMobileSidebar()
              }}
              onSettings={() => {
                props.onSettings?.()
                closeMobileSidebar()
              }}
              onHelp={() => {
                props.onHelp?.()
                closeMobileSidebar()
              }}
            />
          </div>
        </div>

        {/* Collapsed sidebar strip — compact project icons + toggle when sidebar is unpinned */}
        <Show when={!sidebarPinned()}>
          <div class="shrink-0 flex flex-col border-r border-border-weak-base/50" style={{ width: "40px" }}>
            {/* Top — matches workspace bar height so borders align */}
            <div class="h-9 shrink-0 flex items-center justify-center border-b border-border-weak-base/50">
              <Tooltip placement="right" value="Show Sidebar">
                <IconButton
                  icon="layout-left-partial"
                  variant="ghost"
                  size="small"
                  onClick={() => claxedo.rail.toggle()}
                  aria-label="Show Sidebar"
                />
              </Tooltip>
            </div>
            {/* Project icons */}
            <div class="flex flex-col items-center py-2 gap-2 flex-1 min-h-0 overflow-y-auto">
              <For each={props.projects}>
                {(project) => {
                  const name = () => project.name || getFilename(project.worktree)
                  const colors = () => getAvatarColors(project.icon?.color)
                  const active = () => props.activeProjectId === project.id
                  return (
                    <Tooltip placement="right" value={name()}>
                      <button
                        type="button"
                        class="relative p-0.5 rounded-md hover:bg-surface-base-hover transition-colors"
                        onClick={() => props.onProjectSelect?.(project)}
                      >
                        <Avatar
                          fallback={name()}
                          src={project.icon?.override}
                          {...colors()}
                          class="w-6 h-6 rounded text-[10px]"
                        />
                        <Show when={active()}>
                          <div class="absolute -left-1.5 top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full bg-surface-interactive-base" />
                        </Show>
                      </button>
                    </Tooltip>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>
        <div class="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden bg-background-stronger transition-all duration-200 ease-out">
          <SharedTabDragDrop>
            <div
              class="flex flex-1 min-h-0 overflow-hidden"
              style={{ "flex-direction": claxedo.split.direction() === "h" ? "row" : "column" }}
            >
              <For each={visibleGroups()}>
                {(group, i) => (
                  <>
                    <Show when={i() > 0}>
                      <SplitResizeHandle index={i()} />
                    </Show>
                    <div
                      data-group-id={group.id}
                      data-group-focused={group.id === claxedo.split.focusedId() ? "" : undefined}
                      style={{
                        flex: claxedo.split.hidden() ? "1 1 100%" : `0 0 ${claxedo.split.sizes()[i()] * 100}%`,
                        opacity: claxedo.split.active() && group.id !== claxedo.split.focusedId() ? "0.7" : "1",
                      }}
                      class="min-w-0 min-h-0 overflow-hidden relative transition-opacity max-md:!flex-auto"
                      classList={{
                        "max-md:hidden": group.id !== claxedo.split.focusedId() && !claxedo.split.hidden(),
                      }}
                      on:pointerdown={() => claxedo.dispatch({ type: "SplitFocusRequested", groupId: group.id })}
                    >
                      {/* Close button for non-primary panels */}
                      <Show when={i() > 0}>
                        <div class="absolute top-0 right-0 z-10">
                          <IconButton
                            icon="close-small"
                            variant="ghost"
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation()
                              claxedo.dispatch({ type: "SplitGroupCloseRequested", groupId: group.id })
                            }}
                            aria-label="Close panel"
                            class="opacity-60 hover:opacity-100"
                          />
                        </div>
                      </Show>
                      <GroupPanel
                        groupId={group.id}
                        isPrimary={i() === 0}
                        props={props}
                        workspaceBarProjects={workspaceBarProjects}
                        worktreeInfo={worktreeInfo}
                        sidebarPinned={sidebarPinned}
                        mobileSidebarOpen={mobileSidebarOpen}
                        toggleMobileSidebar={toggleMobileSidebar}
                        allProjects={props.projects}
                        visibleWorkspaces={visibleWorkspaces()}
                        onToggleWorkspace={toggleWorkspaceVisibility}
                      />
                    </div>
                  </>
                )}
              </For>
            </div>
          </SharedTabDragDrop>

          {/* Mount route content (DirectoryLayout + providers) without rendering it visually.
              Session content is rendered by GroupContentRenderer via DirectoryScope (session.tsx
              bails out early here). */}
          <div class="hidden">{props.children}</div>
        </div>
      </div>
    </div>
  )
}

function RailLayoutInner(props: RailLayoutProps) {
  try {
    useClaxedoLayout()
    return <RailLayoutBody {...props} />
  } catch {
    return (
      <ClaxedoLayoutProvider>
        <RailLayoutBody {...props} />
      </ClaxedoLayoutProvider>
    )
  }
}

/**
 * Rail Layout Inner (without provider)
 *
 * Use this when you need to provide your own ClaxedoLayoutProvider.
 */
export { RailLayoutInner }

/**
 * Rail Layout with provider
 *
 * Use this component at the top level to enable Claxedo layout mode.
 */
export function RailLayout(props: RailLayoutProps) {
  return (
    <ClaxedoLayoutProvider>
      <RailLayoutInner {...props} />
    </ClaxedoLayoutProvider>
  )
}

/**
 * Hook to check if Claxedo layout is enabled
 */
export function useClaxedoEnabled() {
  try {
    const claxedo = useClaxedoLayout()
    return createMemo(() => claxedo.enabled())
  } catch {
    // Context not available, Claxedo not enabled
    return () => false
  }
}
