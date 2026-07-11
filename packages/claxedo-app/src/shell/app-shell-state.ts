import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Params } from "@solidjs/router"
import {
  useLayout,
  type LocalProject,
  useGlobalSDK,
  usePlatform,
} from "@claxedo/app"
import { useShellQueryOptions as useQueryOptions } from "@/shell/data/query-options"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"

import { useNotification } from "@/context/notification"
import { capture as phCapture } from "../utils/analytics"
import { realDirectory, useClaxedoState } from "../claxedo-ui/state"
import { projectToProjectItem } from "../claxedo-ui/state/route-bridge"
import { resolveActiveDirectory } from "../claxedo-ui/utils/active-workspace"
import { openWorkspaceScopeIds } from "../claxedo-ui/utils/workspace-scope-ids"
import { useConfigOptional } from "../context/config"
import type { SessionInventoryRow } from "../shared/query/types"
import { canAutoOpenProject } from "@/context/layout-projects"
import { principalHasSignedAccess, usePrincipal } from "./auth/identity-provider"
import { useDirectorySessionCacheActions } from "./data/directory-session-cache"
import { useGlobalBootstrapActions } from "./data/global-bootstrap"
import { useGlobalShellReady } from "./data/global-readiness"
import { useProjectInventoryActions } from "./data/project-inventory"
import {
  emptySessionInventory,
  sessionInventoryQueryOptions,
} from "./data/queries"
import { parseShellRoute, shellRouteDirectory } from "./identity/route"
import { useShellAppStateSnapshot } from "./app-state-snapshot"

export type AppShellState = ReturnType<typeof useAppShellState>

export function useAppShellState(input: {
  params: Params
  pathname: Accessor<string>
}) {
  const layout = useLayout()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const globalBootstrapActions = useGlobalBootstrapActions()
  const projectInventoryActions = useProjectInventoryActions()
  const globalReady = useGlobalShellReady()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const pathQuery = useQuery(() => queryOptions.path(null))
  const platform = usePlatform()
  const state = useClaxedoState()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const principal = usePrincipal()
  const canUsePages = () => principalHasSignedAccess(principal())
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() =>
    sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>(),
  )
  const notification = useNotification()
  const config = useConfigOptional()
  const globalChat = () => !!config?.globalChatEnabled
  const layoutProjects = () => layout.projects.list() ?? []
  const flowLog = (...args: unknown[]) => {
    if (typeof args[0] === "string") {
      const eventName = args[0].replace(/\s+/g, "_")
      const props = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : undefined
      phCapture(eventName, props)
    }
  }
  const ensureDirectorySessionCache = async (directory: string) => {
    await directorySessionCacheActions.ensure({ directory })
  }
  useShellAppStateSnapshot({
    layoutProjects,
    state,
    platform,
  })

  const projects = createMemo(() => layoutProjects().map(projectToProjectItem))
  const activeSurface = createMemo(() => {
    const id = state.wb.selectors.focusedContent()
    return id ? state.meta.get(id) : undefined
  })
  const shellRoute = createMemo(() => parseShellRoute(input.pathname()))
  const routeDirectory = createMemo(() => shellRouteDirectory(shellRoute()))
  const shellRouteKind = createMemo(() => shellRoute().kind)
  const activeDirectory = createMemo(() =>
    resolveActiveDirectory({
      routeDir: routeDirectory(),
      surfaceDir: realDirectory(activeSurface()?.directory),
    })
  )
  const openWorkspaceIds = createMemo(() =>
    openWorkspaceScopeIds({
      activeDirectory: activeDirectory(),
      visiblePanes: state.wb.selectors.visiblePanes(),
      meta: (id) => state.meta.get(id),
      projects: projects(),
    })
  )
  const activeProjectId = createMemo(() => {
    const dir = activeDirectory()
    if (!dir) return
    const project = layoutProjects().find((p) =>
      p.worktree === dir ||
      p.sandboxes?.includes(dir) ||
      dir in (((p as LocalProject & { workspaces?: Record<string, unknown> }).workspaces) ?? {})
    )
    return project?.worktree
  })
  const activeSessionId = createMemo(() => {
    const surface = activeSurface()
    if (!surface) return input.params.id
    if (surface.type === "session" || surface.type === "context") {
      if (!surface.sessionId) return
      if (surface.sessionId === "new") return
      return surface.sessionId
    }
    return
  })

  createEffect(() => {
    const dir = activeDirectory()
    if (!dir) return
    void ensureDirectorySessionCache(dir)
  })

  createEffect(() => {
    directorySessionCacheActions.setFocused(activeDirectory() ?? undefined)
  })

  createEffect(() => {
    notification.setActiveScope({
      directory: activeDirectory(),
      session: activeSessionId(),
    })
  })

  const autoOpenActiveProject = () => {
    if (!globalReady()) return
    const dir = activeDirectory()
    if (!dir) return
    if (!canAutoOpenProject({
      api: projectsQuery.data ?? [],
      list: layoutProjects(),
      dir,
      closed: layout.projects.isClosed,
      ignoreClosed: true,
    })) return
    layout.projects.open(dir)
  }

  return {
    activeProjectId,
    activeSessionId,
    activeSurface,
    activeDirectory,
    canUsePages,
    config,
    dialog,
    directorySessionCacheActions,
    flowLog,
    globalBootstrapActions,
    globalChat,
    globalSDK,
    layout,
    openWorkspaceIds,
    pathQuery,
    platform,
    projectInventoryActions,
    projects,
    routeDirectory,
    sessionInventory,
    shellRouteKind,
    state,
    autoOpenActiveProject,
  }
}
