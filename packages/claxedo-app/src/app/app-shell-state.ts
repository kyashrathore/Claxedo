import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Params } from "@solidjs/router"
import { useLayout, type LocalProject, useGlobalSDK, usePlatform } from "@claxedo/app"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"

import { useNotification } from "@/app/providers/notification"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { redactedPathValues } from "@/platform/telemetry/redact"
import { realDirectory, useClaxedoState } from "./workbench/state/index"
import { projectToProjectItem } from "./workbench/state/route-bridge"
import { resolveActiveDirectory } from "../features/workspaces/lib/active-workspace"
import { openWorkspaceScopeIds } from "../features/workspaces/lib/workspace-scope-ids"
import { workspaceRouteIdentity } from "../features/workspaces/lib/workspace-display"
import { useConfigOptional } from "./providers/config"
import type { SessionInventoryRow } from "../features/session/data/query/types"
import { canAutoOpenProject } from "@/app/providers/layout-projects"
import { usePrincipal } from "@/platform/auth/identity-provider"
import { documentsAccess } from "@/features/documents/access"
import { useDirectorySessionCacheActions } from "../features/session/data/sync/directory-session-cache"
import { useGlobalBootstrapActions } from "./integrations/sync/global-bootstrap"
import { useGlobalShellReady } from "./integrations/sync/global-readiness"
import { useProjectInventoryActions } from "./integrations/sync/project-inventory"
import { emptySessionInventory, sessionInventoryQueryOptions } from "../features/session/data/sync/queries"
import { parseShellRoute, shellRouteDirectory } from "@/platform/identity/route"
import { useShellAppStateSnapshot } from "./app-state-snapshot"

export type AppShellState = ReturnType<typeof useAppShellState>

export function useAppShellState(input: { params: Params; pathname: Accessor<string> }) {
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
  const canUseDocuments = () => documentsAccess({ principal: principal(), serverUrl: globalSDK.url })
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() => sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>())
  const notification = useNotification()
  const config = useConfigOptional()
  const globalChat = () => !!config?.globalChatEnabled
  const layoutProjects = () => layout.projects.list() ?? []
  const flowLog = (...args: unknown[]) => {
    if (typeof args[0] === "string") {
      const eventName = args[0].replace(/\s+/g, "_")
      const props = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : undefined
      // Flow properties carry workspace/route directories verbatim; the sink is
      // the only choke point every producer passes through.
      phCapture(eventName, {
        ...identityProps(),
        surface: "app_shell",
        ...redactedPathValues(props ?? {}),
      })
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
  const routeWorkspaceKey = createMemo(() => shellRouteDirectory(shellRoute()))
  const routeIdentity = createMemo(() => workspaceRouteIdentity(projectsQuery.data ?? [], routeWorkspaceKey()))
  const routeDirectory = createMemo(() => routeIdentity()?.directory ?? routeWorkspaceKey())
  const routeId = createMemo(() => routeIdentity()?.routeId)
  const shellRouteKind = createMemo(() => shellRoute().kind)
  const activeDirectory = createMemo(() =>
    resolveActiveDirectory({
      routeDir: routeDirectory(),
      surfaceDir: realDirectory(activeSurface()?.directory),
    }),
  )
  const openWorkspaceIds = createMemo(() =>
    openWorkspaceScopeIds({
      activeDirectory: activeDirectory(),
      visiblePanes: state.wb.selectors.visiblePanes(),
      meta: (id) => state.meta.get(id),
      projects: projects(),
    }),
  )
  const activeProjectId = createMemo(() => {
    const dir = activeDirectory()
    if (!dir) return
    const project = layoutProjects().find(
      (p) =>
        p.worktree === dir ||
        p.sandboxes?.includes(dir) ||
        dir in ((p as LocalProject & { workspaces?: Record<string, unknown> }).workspaces ?? {}),
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
    if (
      !canAutoOpenProject({
        api: projectsQuery.data ?? [],
        list: layoutProjects(),
        dir,
        closed: layout.projects.isClosed,
        ignoreClosed: true,
      })
    )
      return
    layout.projects.open(dir)
  }

  return {
    activeProjectId,
    activeSessionId,
    activeSurface,
    activeDirectory,
    canUseDocuments,
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
    routeId,
    sessionInventory,
    shellRouteKind,
    state,
    autoOpenActiveProject,
  }
}
