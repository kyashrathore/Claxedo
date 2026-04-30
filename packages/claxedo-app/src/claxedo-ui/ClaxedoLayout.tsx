/**
 * ClaxedoLayout - Custom layout component for Rail + Tab UI
 *
 * This replaces the default Layout when registered via the extension system.
 * It provides the Rail sidebar and Tab bar UI with Project > Workspace > Session hierarchy.
 *
 * Note: ClaxedoLayout is at app level (outside DirectoryLayout/SDKProvider),
 * so it cannot directly access terminal context. Terminal surface creation is
 * coordinated via claxedo layout state and rendered through multi-pane leaves.
 */

import "./claxedo-layout.css"
import { createMemo, createEffect, on, onCleanup, Show, type ParentProps } from "solid-js"
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

import { RailLayoutInner } from "./layouts/rail-layout"
import type { ProjectItem } from "./layouts/rail-sidebar"
import { ClaxedoStateProvider, useClaxedoState } from "./state"
import { useCommand } from "@/context/command"
import { useConfigOptional } from "../context/config"
import { capture as phCapture } from "../analytics/posthog"
import { createClaxedoLayoutActions } from "./claxedo-layout-actions"
import { useClaxedoEventsOptional } from "../providers/claxedo-events"
import { createRouteIntentAdapter } from "./state/route-intent"
import { surfaceRoute, routeMatchesSurface } from "./state/surface-route"
import { realDirectory } from "./state"
import { canAutoOpenProject } from "../overrides/context/layout-projects"

import { useAgentHooks } from "./state/agent-status-listener"
import { createBatchAutoTabListener } from "./state/batch-autotab"
import { isDemoMode } from "../utils/api"
import { lazy } from "solid-js"
import { AcpConfigProvider } from "./context/acp-config"

const DemoTourController = __DEMO_ENABLED__
  ? lazy(() => import("../demo/tour-controller").then((m) => ({ default: m.DemoTourController })))
  : () => null

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
    workspaces: (project as any).workspaces,
    commands: project.commands,
  }
}

/**
 * Bridge component that syncs upstream state with Claxedo state
 */
function ClaxedoStateBridge(props: ParentProps) {
  const state = useClaxedoState()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const config = useConfigOptional()
  const params = useParams()
  const navigate = useNavigate()

  // Set up agent lifecycle listeners for content status indicators
  useAgentHooks()

  // Auto-add tabs for sessions/ptys created in sandbox directories (batch_issues).
  // Uses state.layout.openSession/openTerminal with focus:false so the listener
  // never steals the user's current focus.
  createEffect(() => {
    const unsub = createBatchAutoTabListener({
      listen: globalSDK.event.listen as any,
      adapters: {
        addSession: (dir, sid, title) =>
          state.layout.openSession(dir, sid, title, { focus: false }),
        addTerminal: (dir, tid, title) =>
          state.layout.openTerminal(dir, tid, title, { focus: false }),
        findSession: (dir, sid) =>
          state.meta.find(
            (m) => m.type === "session" && m.directory === dir && m.sessionId === sid,
          ),
        findTerminal: (dir, tid) =>
          state.meta.find(
            (m) => m.type === "terminal" && m.directory === dir && m.terminalId === tid,
          ),
      },
      projects: () => {
        const list = globalSync.data.project ?? []
        return list.map((p: any) => ({ worktree: p.worktree, sandboxes: p.sandboxes }))
      },
    })
    onCleanup(unsub)
  })

  const workspaceId = createMemo(() => decodeDir(params.dir))
  const sessionId = createMemo(() => params.id)
  const pageId = createMemo(() => params.pageId)
  const terminalId = createMemo(() => params.terminalId)

  const route = createRouteIntentAdapter({
    state,
    globalSync,
    globalSDK,
    workgraphEnabled: () => !!config?.workgraphEnabled,
    navigate,
  })

  const sessionInfo = createMemo((prev: { workspaceId: string; sessionId: string; title: string } | undefined) => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return undefined
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    if (session?.title) return { workspaceId: wsId, sessionId: id, title: session.title }
    if (prev?.workspaceId === wsId && prev?.sessionId === id) return prev
    return undefined
  })
  const sessionTitle = createMemo(() => sessionInfo()?.title)

  const sessionBadge = createMemo(
    (prev: { workspaceId: string; sessionId: string; badge: { additions: number; deletions: number } } | undefined) => {
    const wsId = workspaceId()
    const id = sessionId()
    if (!wsId || !id) return undefined
    const [store] = globalSync.child(wsId)
    const session = store.session.find((s: Session) => s.id === id && s.directory === wsId)
    const summary = session?.summary
      if (!summary) {
        if (prev?.workspaceId === wsId && prev?.sessionId === id) return prev
        return undefined
      }
      return {
        workspaceId: wsId,
        sessionId: id,
        badge: {
          additions: summary.additions ?? 0,
          deletions: summary.deletions ?? 0,
        },
      }
    },
  )
  const sessionBadgeAdditions = createMemo(() => sessionBadge()?.badge.additions ?? 0)
  const sessionBadgeDeletions = createMemo(() => sessionBadge()?.badge.deletions ?? 0)
  const sessionHasBadge = createMemo(() => !!sessionBadge()?.badge)

  // URL → state: tell route-intent about deep-link params.
  // Route-intent is a pure reader of the URL; it never auto-creates surfaces
  // for the workspace root. Canvas state is only created for concrete
  // session/page ids.
  createEffect(
    on(
      () =>
        [
          state.ready(),
          workspaceId(),
          sessionId(),
          pageId(),
          terminalId(),
          sessionTitle(),
          sessionHasBadge(),
          sessionBadgeAdditions(),
          sessionBadgeDeletions(),
        ] as const,
      ([ready, wsId, id, pid, tid, title, hasBadge, additions, deletions]) => {
        route.receive({
          ready,
          workspaceId: wsId,
          sessionId: id,
          pageId: pid,
          terminalId: tid,
          sessionTitle: title ?? "",
          sessionBadge: hasBadge ? { additions, deletions } : undefined,
        })
      },
    ),
  )

  // Sync surface titles reactively from pane contents + session data

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
  const state = useClaxedoState()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const command = useCommand()
  const config = useConfigOptional()
  const globalChat = () => !!config?.globalChatEnabled
  const workgraph = () => !!config?.workgraphEnabled
  const flowLog = (...args: unknown[]) => {
    if (typeof args[0] === "string") {
      const eventName = args[0].replace(/\s+/g, "_")
      const props = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : undefined
      phCapture(eventName, props)
    }
  }

  // Capture app state snapshot shortly after layout mount
  const snapshotTimer = setTimeout(() => {
    const surfaceTypes: Record<string, number> = {}
    for (const surface of state.meta.all()) {
      surfaceTypes[surface.type] = (surfaceTypes[surface.type] ?? 0) + 1
    }
    phCapture("app_state_snapshot", {
      project_count: layout.projects.list().length,
      active_panes: state.wb.state.panes.length,
      active_surfaces: state.meta.all().length,
      split_active: state.wb.state.panes.length > 1,
      surface_types: surfaceTypes,
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
        state.workspacePanel.toggle("processes", {
          workspaceDir: activeWorkspaceId(),
          navigator: "processes",
        })
      },
    },
  ])

  // Convert projects to ProjectItems
  const projects = createMemo(() => {
    const projectList = layout.projects.list()
    return projectList.map(projectToProjectItem)
  })

  const activeSurface = createMemo(() => {
    const id = state.wb.selectors.focusedContent()
    return id ? state.meta.get(id) : undefined
  })

  // Current workspace from URL.
  const routeWorkspaceId = createMemo(() => {
    if (!params.dir) return undefined
    return decodeDir(params.dir)
  })

  // Active workspace for Claxedo UI actions prefers the active surface's directory.
  // This keeps non-workspace surfaces (terminal/context) decoupled from transient route state.
  const activeWorkspaceId = createMemo(() => {
    const surfaceDir = realDirectory(activeSurface()?.directory)
    if (surfaceDir) return surfaceDir
    return routeWorkspaceId()
  })
  const snap = () => {
    const paneId = state.wb.state.focusedPaneId
    const surface = activeSurface()
    return {
      params: {
        dir: params.dir ?? null,
        id: params.id ?? null,
        pageId: params.pageId ?? null,
      },
      paneId: paneId ?? null,
      routeDir: routeWorkspaceId() ?? null,
      activeDir: activeWorkspaceId() ?? null,
      surface: surface
        ? {
            id: surface.id,
            type: surface.type,
            directory: surface.directory,
            sessionId: surface.sessionId,
            pageId: surface.pageId,
            terminalId: surface.terminalId,
            filePath: surface.filePath,
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
    if (!canAutoOpenProject({
      api: globalSync.data.project,
      list: layout.projects.list(),
      dir,
      closed: layout.projects.isClosed,
      ignoreClosed: true,
    })) return
    layout.projects.open(dir)
  })

  // Sidebar selection should be driven by the active surface, not the URL.
  // When non-session surfaces (terminal/file) are active, we intentionally clear the session highlight.
  const activeSessionId = createMemo(() => {
    const surface = activeSurface()
    if (!surface) return params.id
    if (surface.type === "session" || surface.type === "context") {
      if (!surface.sessionId) return undefined
      if (surface.sessionId === "new") return undefined
      return surface.sessionId
    }
    return undefined
  })

  // Sync URL with the focused pane's active surface.
  // Covers ALL surface-change paths: creation, close, keyboard shortcuts, etc.
  // Deferred to skip the initial mount (URL is already correct from route).
  createEffect(
    on(
      () => {
        const id = state.wb.selectors.focusedContent()
        return id ? state.meta.get(id) : undefined
      },
      (surface) => {
        if (surface) {
          const dir = realDirectory(surface.directory) ?? activeWorkspaceId()
          if (!dir) return
          if (routeMatchesSurface(params, dir, surface)) return
          const route = surfaceRoute(dir, surface)
          if (!route) {
            if (params.id || params.pageId) {
              const target = `/${base64Encode(dir)}`
              navigate(target, { replace: true })
              return
            }
            return
          }
          navigate(route, { replace: true })
        } else if (params.id || params.pageId || params.terminalId) {
          const dir = activeWorkspaceId()
          if (dir) {
            navigate(`/${base64Encode(dir)}`, { replace: true })
            return
          }
          return
        }
      },
      { defer: true },
    ),
  )

  const handleOpenWorkGraph = () => {
    if (!workgraph()) return
    state.layout.openWorkgraph(activeWorkspaceId())
  }

  createEffect(() => {
    if (workgraph()) return
    for (const item of state.meta.findAll((meta) => meta.type === "workgraph")) {
      state.layout.closeContent(item.id)
    }
  })

  const events = useClaxedoEventsOptional()

  const {
    handleWorkspaceSelect,
    handleSessionSelect,
    handleNewProject,
    handleNewWorkspace,
    handleNewLocalWorkspace,
    handleNewCloudWorkspace,
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
    state,
    dialog,
    globalSync,
    globalSDK,
    layout,
    platform,
    config,
    events,
    projects,
    activeWorkspaceId,
    activeProjectId,
    flowLog,
  })

  return (
    <>
      <RailLayoutInner
        projects={projects()}
        activeProjectId={activeProjectId()}
        activeWorkspaceId={activeWorkspaceId()}
        activeSessionId={activeSessionId()}
        globalChatEnabled={globalChat()}
        homedir={globalSync.data.path.home}
        onWorkspaceSelect={handleWorkspaceSelect}
        onSessionSelect={handleSessionSelect}
        onNewProject={handleNewProject}
        onNewWorkspace={handleNewWorkspace}
        onNewLocalWorkspace={handleNewLocalWorkspace}
        onNewCloudWorkspace={handleNewCloudWorkspace}
        onSettings={handleSettings}
        onHelp={handleHelp}
        onOpenWorkGraph={handleOpenWorkGraph}
        workgraphEnabled={workgraph()}
        onNewSession={handleNewSession}
        onNewTerminal={handleNewTerminal}
        onNewPage={handleNewPage}
        onNewReview={handleNewReview}
        onTabSelect={handleTabSelect}
        onTabClose={(nextSurface) => {
          const dir = realDirectory(nextSurface?.directory)
          if (dir && nextSurface) {
            const route = surfaceRoute(dir, nextSurface)
            if (!route) {
              return
            }
            navigate(route, { replace: true })
            return
          }
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
    <ClaxedoStateProvider>
      <Toast.Region />
      {isDemoMode() && <DemoTourController />}
      <ClaxedoStateBridge>
        <AcpConfigProvider>
          <ClaxedoLayoutContent>{props.children}</ClaxedoLayoutContent>
        </AcpConfigProvider>
      </ClaxedoStateBridge>
    </ClaxedoStateProvider>
  )
}
