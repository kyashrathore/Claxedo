/**
 * ClaxedoLayout - Custom layout component for Rail + Tab UI
 *
 * This replaces the default Layout when registered via the extension system.
 * It provides the Rail sidebar and Tab bar UI with Project > Workspace > Session hierarchy.
 *
 * Note: ClaxedoLayout is at app level (outside DirectoryLayout/SDKProvider),
 * so it cannot directly access terminal context. Terminal tab creation is
 * coordinated via claxedo layout state and rendered through multi-pane leaves.
 */

import "./claxedo-layout.css"
import { createSignal, createMemo, createEffect, on, onCleanup, Show, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  useLayout,
  type LocalProject,
  useGlobalSync,
  useGlobalSDK,
  usePlatform,
} from "@opencode-ai/claxedo-app"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Toast } from "@opencode-ai/ui/toast"
import { base64Decode, base64Encode } from "@opencode-ai/util/encode"
import { validWorktree } from "@claxedo/utils/worktree"

// Import directly from source files to avoid circular dependency
// (index.tsx exports ClaxedoLayout, so we can't import from index here)
import { RailLayoutInner } from "./layouts/rail-layout"
import type { ProjectItem } from "./layouts/rail-sidebar"
import { useClaxedoLayout, ClaxedoLayoutProvider } from "./context/claxedo-layout"
import { useCommand } from "@/context/command"
import { useConfigOptional } from "../context/config"
import { createDebugLogger } from "../overrides/utils/debug"
import { capture as phCapture } from "../opencode-patches/observability/posthog"
import { createClaxedoLayoutActions } from "./claxedo-layout-actions"
import { createRouteIntentAdapter } from "./context/claxedo-layout/route-intent"
import { buildTabContextSnapshot, createTabContextSyncAdapter } from "./context/claxedo-layout/tab-context-sync"
import { createDynamicTitleSync } from "./context/claxedo-layout/dynamic-title-sync"

import { useAgentHooks } from "../agent-hooks/listener"
import { createBatchAutoTabListener } from "./context/batch-autotab"
import { isDemoMode } from "../utils/api"
import { DemoTourController } from "../demo/tour-controller"

function decodeDir(encoded: string | undefined) {
  if (!encoded) return
  try {
    const decoded = base64Decode(encoded)
    if (!validWorktree(decoded)) return
    return decoded
  } catch {
    return
  }
}

/**
 * Convert upstream LocalProject to Claxedo ProjectItem
 */
function projectToProjectItem(project: LocalProject): ProjectItem {
  return {
    id: project.id ?? project.worktree,
    worktree: project.worktree,
    name: project.name,
    icon: project.icon,
    expanded: project.expanded,
    sandboxes: project.sandboxes,
    commands: project.commands,
  }
}

/**
 * Bridge component that syncs upstream state with Claxedo state
 */
function ClaxedoStateBridge(props: ParentProps) {
  const claxedo = useClaxedoLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const params = useParams()
  const navigate = useNavigate()
  const debug = createDebugLogger("layout.state-bridge", "layout:bridge", {
    legacyKey: "opencode.debug.terminal",
  })

  // Set up agent lifecycle listeners for tab status indicators
  useAgentHooks()

  // Auto-add tabs for sessions/ptys created in sandbox directories (batch_issues)
  createEffect(() => {
    const unsub = createBatchAutoTabListener({
      listen: globalSDK.event.listen as any,
      topTabs: claxedo.topTabs,
      projects: () => {
        const list = globalSync.data.project ?? []
        return list.map((p: any) => ({ worktree: p.worktree, sandboxes: p.sandboxes }))
      },
    })
    onCleanup(unsub)
  })

  const workspaceId = createMemo(() => decodeDir(params.dir))
  const tabId = createMemo(() => params.tabId)
  const sessionId = createMemo(() => params.id)
  const pageId = createMemo(() => params.pageId)

  const route = createRouteIntentAdapter({
    claxedo,
    globalSync,
    globalSDK,
    navigate,
    log: (event, payload) => {
      debug.log(event, payload)
    },
  })

  const sessionTitle = createMemo(() => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return ""
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    return session?.title ?? ""
  })

  const sessionBadge = createMemo(() => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return undefined
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    const summary = session?.summary
    if (!summary) return undefined
    return {
      additions: summary.additions ?? 0,
      deletions: summary.deletions ?? 0,
    }
  })
  const sessionBadgeAdditions = createMemo(() => sessionBadge()?.additions ?? 0)
  const sessionBadgeDeletions = createMemo(() => sessionBadge()?.deletions ?? 0)
  const sessionHasBadge = createMemo(() => !!sessionBadge())

  // Combined effect to handle workspace and session sync together
  createEffect(
    on(
      () =>
        [
          claxedo.ready(),
          workspaceId(),
          tabId(),
          sessionId(),
          pageId(),
          sessionTitle(),
          sessionHasBadge(),
          sessionBadgeAdditions(),
          sessionBadgeDeletions(),
        ] as const,
      ([ready, wsId, tid, id, pid, title, hasBadge, additions, deletions]) => {
        // Skip route-intent when at workspace root with no params and user
        // intentionally closed all tabs — prevents auto-creating a session.
        if (wsId && !tid && !id && !pid && claxedo.isAutoTabSuppressed(wsId)) return
        route.receive({
          ready,
          workspaceId: wsId,
          tabId: tid,
          sessionId: id,
          pageId: pid,
          sessionTitle: title,
          sessionBadge: hasBadge ? { additions, deletions } : undefined,
        })
      },
    ),
  )

  // Sync tab titles reactively from pane contents + session data
  createDynamicTitleSync({ claxedo, globalSync })

  return <>{props.children}</>
}

/**
 * ClaxedoLayoutContent - The actual layout content
 */
function ClaxedoLayoutContent(props: ParentProps) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const params = useParams()
  const navigate = useNavigate()
  const claxedo = useClaxedoLayout()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const command = useCommand()
  const config = useConfigOptional()
  const flowDebug = createDebugLogger("terminal.flow", "terminal:flow", {
    legacyKey: "opencode.debug.terminal",
  })
  const flowLog = (...args: unknown[]) => {
    flowDebug.log(...args)
    if (typeof args[0] === "string") {
      const eventName = args[0].replace(/\s+/g, "_")
      const props = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : undefined
      phCapture(eventName, props)
    }
  }
  const syncDebug = createDebugLogger("layout.tab-sync", "layout:tab-sync", {
    legacyKey: "opencode.debug.terminal",
  })

  // Capture app state snapshot shortly after layout mount
  const snapshotTimer = setTimeout(() => {
    const groups = claxedo.split.groups()
    const tabTypes: Record<string, number> = {}
    let totalTabs = 0
    for (const g of groups) {
      for (const tab of claxedo.groupTabs(g.id).items()) {
        tabTypes[tab.type] = (tabTypes[tab.type] ?? 0) + 1
        totalTabs++
      }
    }
    phCapture("app_state_snapshot", {
      project_count: layout.projects.list().length,
      active_groups: groups.length,
      active_tabs: totalTabs,
      split_active: claxedo.split.active(),
      tab_types: tabTypes,
      platform: platform.platform,
      os: platform.os,
      version: platform.version,
    })
  }, 3000)
  onCleanup(() => clearTimeout(snapshotTimer))

  // Register process pane command
  command.register(() => [
    {
      id: "processPane.toggle",
      title: "Toggle Process Pane",
      category: "View",
      keybind: "mod+shift+;",
      onSelect: () => {
        phCapture("process_pane_toggled")
        claxedo.processPane.requestToggle()
      },
    },
  ])

  // Convert projects to ProjectItems
  const projects = createMemo(() => {
    const projectList = layout.projects.list()
    return projectList.map(projectToProjectItem)
  })

  const activeTab = createMemo(() => claxedo.topTabs.active())

  // Current workspace from URL.
  const routeWorkspaceId = createMemo(() => {
    if (!params.dir) return undefined
    return decodeDir(params.dir)
  })

  // Active workspace for Claxedo UI actions prefers the active tab's directory.
  // This keeps terminal/file tabs decoupled from transient route state.
  const activeWorkspaceId = createMemo(() => {
    const tabDir = activeTab()?.directory
    if (tabDir && tabDir !== "__pages__") return tabDir
    return routeWorkspaceId()
  })
  const snap = () => {
    const groupId = claxedo.split.focusedId()
    const tab = groupId ? claxedo.groupTabs(groupId).active() : undefined
    return {
      params: {
        dir: params.dir ?? null,
        tabId: params.tabId ?? null,
        id: params.id ?? null,
        pageId: params.pageId ?? null,
      },
      groupId: groupId ?? null,
      routeDir: routeWorkspaceId() ?? null,
      activeDir: activeWorkspaceId() ?? null,
      tab: tab
        ? {
            id: tab.id,
            type: tab.type,
            directory: tab.directory,
            sessionId: tab.sessionId,
            pageId: tab.pageId,
            terminalId: tab.terminalId,
            filePath: tab.filePath,
          }
        : null,
    }
  }

  // Get active project (the project that contains the current workspace)
  const activeProjectId = createMemo(() => {
    const dir = activeWorkspaceId()
    if (!dir) return undefined

    const project = layout.projects.list().find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    return project?.worktree
  })

  // Initialize sync for the active workspace eagerly (no wait for globalSync)
  createEffect(() => {
    const dir = activeWorkspaceId()
    if (!dir) return
    globalSync.child(dir)
  })

  // Auto-open project when navigating to a workspace that isn't in the sidebar yet.
  // Must wait for globalSync.ready so rootFor() can resolve sandboxes to their parent project
  // — otherwise a sandbox directory gets added as a top-level project.
  createEffect(() => {
    if (!globalSync.ready) return
    const dir = activeWorkspaceId()
    if (!dir) return
    const existing = layout.projects.list().find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    if (existing) return
    layout.projects.open(dir)
  })

  // Auto-select main workspace when no workspace is selected.
  // Uses on() so the callback body is untracked — store reads inside
  // setPinned/setDefault/child don't become dependencies of this effect.
  createEffect(
    on(
      () => ({ dir: params.dir, projects: layout.projects.list() }),
      ({ dir, projects }) => {
        if (dir) return
        if (!projects.length) return
        const mainWorktree = projects[0].worktree
        if (!mainWorktree) return

        claxedo.worktree.setPinned(null)
        claxedo.worktree.setDefault(mainWorktree)
        globalSync.child(mainWorktree)
        const existing = claxedo.topTabs.orderedItems().find((tab) => tab.directory === mainWorktree)
        const tabId = existing?.id ?? claxedo.topTabs.addSession(mainWorktree, "new", "New Session")
        if (tabId) {
          claxedo.topTabs.setActive(tabId)
          queueMicrotask(() => navigate(`/${base64Encode(mainWorktree)}/tab/${tabId}`, { replace: true }))
        }
      },
    ),
  )

  // Sidebar selection should be driven by the active tab, not the URL.
  // When non-session tabs (terminal/file) are active, we intentionally clear the session highlight.
  const activeSessionId = createMemo(() => {
    const tab = activeTab()
    if (!tab) return params.id
    if (tab.type === "session" || tab.type === "review" || tab.type === "context") {
      if (!tab.sessionId) return undefined
      if (tab.sessionId === "new") return undefined
      return tab.sessionId
    }
    return undefined
  })

  // Ensure we always have an active tab when a directory route is open.
  // One-shot on initial mount/restore only. Do not recreate tabs after
  // users intentionally close the last tab.
  const [initialTabEnsured, setInitialTabEnsured] = createSignal(false)
  createEffect(() => {
    const dir = activeWorkspaceId()
    if (!dir) return
    if (initialTabEnsured()) return
    if (claxedo.topTabs.activeId()) {
      syncDebug.log("ensure skipped: active tab exists", {
        dir,
        activeId: claxedo.topTabs.activeId(),
        ...snap(),
      })
      setInitialTabEnsured(true)
      return
    }
    if (params.tabId) {
      syncDebug.log("ensure skipped: route already targets tab", {
        dir,
        ...snap(),
      })
      setInitialTabEnsured(true)
      return
    }
    if (params.id) {
      syncDebug.log("ensure skipped: route already targets session", {
        dir,
        ...snap(),
      })
      setInitialTabEnsured(true)
      return
    }
    if (params.pageId) {
      syncDebug.log("ensure skipped: route already targets page", {
        dir,
        ...snap(),
      })
      setInitialTabEnsured(true)
      return
    }
    if (claxedo.isAutoTabSuppressed(dir)) {
      syncDebug.log("ensure skipped: auto tab suppressed", {
        dir,
        ...snap(),
      })
      setInitialTabEnsured(true)
      return
    }
    const id = claxedo.topTabs.addSession(dir, "new", "New Session")
    syncDebug.log("ensure created tab", {
      dir,
      id: id ?? null,
      ...snap(),
    })
    if (id) claxedo.topTabs.setActive(id)
    setInitialTabEnsured(true)
  })

  // Sync URL with the focused group's active tab.
  // Covers ALL tab-change paths: creation, close, keyboard shortcuts, etc.
  // Deferred to skip the initial mount (URL is already correct from route).
  createEffect(
    on(
      () => {
        const focusedId = claxedo.split.focusedId()
        if (!focusedId) return undefined
        return claxedo.groupTabs(focusedId).active()
      },
      (tab) => {
        syncDebug.log("focused tab changed", {
          next: tab
            ? {
                id: tab.id,
                type: tab.type,
                directory: tab.directory,
                sessionId: tab.sessionId,
                pageId: tab.pageId,
                terminalId: tab.terminalId,
              }
            : null,
          ...snap(),
        })
        if (tab) {
          const dir = tab.directory === "__pages__" ? activeWorkspaceId() : tab.directory
          if (!dir) {
            syncDebug.log("navigate skipped: tab has no directory", {
              tabId: tab.id,
              ...snap(),
            })
            return
          }
          claxedo.allowAutoTab(dir)
          if (params.tabId === tab.id) {
            syncDebug.verbose("navigate skipped: route already in sync", {
              dir,
              tabId: tab.id,
              ...snap(),
            })
            return
          }
          syncDebug.log("navigate to active tab", {
            dir,
            to: `/${base64Encode(dir)}/tab/${tab.id}`,
            ...snap(),
          })
          navigate(`/${base64Encode(dir)}/tab/${tab.id}`, { replace: true })
        } else if (params.tabId) {
          // All tabs closed — update URL bar to workspace root without triggering
          // the SolidJS router (which would cause route-intent to auto-create a tab).
          const dir = activeWorkspaceId()
          if (dir) {
            claxedo.suppressAutoTab(dir)
            syncDebug.log("replace route with workspace root", {
              dir,
              to: `/${base64Encode(dir)}`,
              ...snap(),
            })
            window.history.replaceState(null, "", `/${base64Encode(dir)}`)
            return
          }
          syncDebug.log("replace skipped: no workspace for empty tab set", snap())
          return
        }
        syncDebug.verbose("focused tab cleared with no route tab", snap())
      },
      { defer: true },
    ),
  )

  const handleOpenWorkGraph = () => {
    const targetGroupId = claxedo.split.focusedId()
    if (targetGroupId) claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })
    const tabs = targetGroupId ? claxedo.groupTabs(targetGroupId) : claxedo.topTabs
    // Reuse existing WorkGraph tab if open
    const existing = tabs.items().find((t) => t.type === "page" && (t as any).pageId === "__workgraph__")
    if (existing) {
      tabs.setActive(existing.id)
      return
    }
    tabs.addPage("__workgraph__", "WorkGraph")
  }

  const {
    handleProjectSelect,
    handleWorkspaceSelect,
    handleSessionSelect,
    handleNewProject,
    handleNewWorkspace,
    handleSettings,
    handleHelp,
    handleNewSession,
    handleNewReview,
    handleDeleteSession,
    handleArchiveSession,
    handleDeleteWorkspace,
    handleRemoveProject,
    handleNewTerminal,
    handleNewPage,
    handleTabSelect,
  } = createClaxedoLayoutActions({
    params,
    navigate: (path) => navigate(path),
    claxedo,
    dialog,
    globalSync,
    globalSDK,
    layout,
    platform,
    config,
    projects,
    activeWorkspaceId,
    activeProjectId,
    flowLog,
  })

  const activeGroupContext = () => {
    const groupId = claxedo.split.focusedId()
    if (!groupId) return
    const tabs = claxedo.groupTabs(groupId)
    const wt = claxedo.groupWorktree(groupId)
    const active = tabs.active()
    const tabDir = active?.directory
    const directory = tabDir && tabDir !== "__pages__" ? tabDir : (wt.default() ?? activeWorkspaceId())
    if (!directory) return
    const sessionID =
      active?.type === "session" && active.sessionId && active.sessionId !== "new" ? active.sessionId : undefined
    return { groupId, tabs, directory, sessionID, activeType: active?.type }
  }

  const tabContextSync = createTabContextSyncAdapter({
    sdkUrl: () => globalSDK.url,
    request: platform.fetch ?? fetch,
  })

  const tabContext = createMemo(() => {
    const ctx = activeGroupContext()
    if (!ctx) return
    const tab = ctx.tabs.active()
    if (!tab) return

    return buildTabContextSnapshot({
      groupId: ctx.groupId,
      tab,
      layout: claxedo.multiPane.activeLayout(tab.id),
    })
  })

  createEffect(
    on(
      tabContext,
      (snapshot) => {
        tabContextSync.push(snapshot)
      },
      { defer: true },
    ),
  )

  return (
    <>
      <RailLayoutInner
        projects={projects()}
        activeProjectId={activeProjectId()}
        activeWorkspaceId={activeWorkspaceId()}
        activeSessionId={activeSessionId()}
        homedir={globalSync.data.path.home}
        onProjectSelect={handleProjectSelect}
        onWorkspaceSelect={handleWorkspaceSelect}
        onSessionSelect={handleSessionSelect}
        onNewProject={handleNewProject}
        onNewWorkspace={handleNewWorkspace}
        onSettings={handleSettings}
        onHelp={handleHelp}
        onOpenWorkGraph={handleOpenWorkGraph}
        onNewSession={handleNewSession}
        onNewTerminal={handleNewTerminal}
        onNewPage={handleNewPage}
        onNewReview={handleNewReview}
        onTabSelect={handleTabSelect}
        onTabClose={(nextTab) => {
          syncDebug.log("tabbar close callback", {
            next: nextTab
              ? {
                  id: nextTab.id,
                  type: nextTab.type,
                  directory: nextTab.directory,
                  sessionId: nextTab.sessionId,
                  pageId: nextTab.pageId,
                  terminalId: nextTab.terminalId,
                }
              : null,
            ...snap(),
          })
          if (nextTab?.directory && nextTab.directory !== "__pages__") {
            syncDebug.log("navigate from tabbar close", {
              to: `/${base64Encode(nextTab.directory)}/tab/${nextTab.id}`,
              ...snap(),
            })
            navigate(`/${base64Encode(nextTab.directory)}/tab/${nextTab.id}`, { replace: true })
            return
          }
          syncDebug.log("tabbar close left route unchanged", snap())
        }}
        onDeleteSession={handleDeleteSession}
        onArchiveSession={handleArchiveSession}
        onDeleteWorkspace={handleDeleteWorkspace}
        onRemoveProject={handleRemoveProject}
        // titlebar={<Titlebar />}
      >
        {props.children}
      </RailLayoutInner>
    </>
  )
}

/**
 * ClaxedoLayout - Main layout component for extension system
 *
 * Register this as `layoutComponent` in the app extensions.
 *
 * Note: TerminalProvider is NOT added here because ClaxedoLayout is at app level
 * (outside SDKProvider). Terminal context is provided via directoryProviders extension
 * point, which injects TerminalProvider at directory level.
 */
export function ClaxedoLayout(props: ParentProps) {
  return (
    <ClaxedoLayoutProvider>
      <Toast.Region />
      {isDemoMode() && <DemoTourController />}
      <ClaxedoStateBridge>
        <ClaxedoLayoutContent>{props.children}</ClaxedoLayoutContent>
      </ClaxedoStateBridge>
    </ClaxedoLayoutProvider>
  )
}
