import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Params } from "@solidjs/router"
import { useLayout } from "@/app/providers/layout"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
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
import { routeSessionWorkspaceBacking } from "./workbench/state/route-bridge-resolution"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { projectWorktreeForDirectory } from "./providers/global-sync/project-owner"
import { workspaceRouteIdentity } from "@/features/workspaces/lib/workspace-display"

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
    await directorySessionCacheActions.ensure({ directory, workspace: routeWorkspaceBacking() })
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
  // Resolve the route's workspace segment against the projects list, which is
  // already local: it matches on EITHER the canonical id or the directory, so a
  // directory-form URL still yields `routeId` and `app-shell-route-sync` can
  // rewrite it to `/w/<id>`. Resolving through the async workspace record
  // instead only ever succeeded when the segment ALREADY was the id — the one
  // case that needs no rewrite — so directory-form URLs never became canonical
  // and `routeDirectory` went undefined for the length of a fetch.
  const routeIdentity = createMemo(() => workspaceRouteIdentity(projectsQuery.data ?? [], routeWorkspaceKey()))
  const routeDirectory = createMemo(() => routeIdentity()?.directory ?? routeWorkspaceKey())
  const routeWorkspaceBacking = createMemo(() => {
    const directory = routeDirectory()
    const workspaceId = routeWorkspaceKey()
    if (!directory || !workspaceId) return
    return (
      routeSessionWorkspaceBacking({
        projects: projectsQuery.data ?? [],
        directory,
        workspaceId,
      }) ?? sessionWorkspaceRuntimeRef({ directory: workspaceId })
    )
  })
  const routeId = createMemo(() => routeIdentity()?.routeId)
  const routeProjectWorktree = createMemo(() => {
    const workspaceKey = routeWorkspaceKey()
    if (!workspaceKey) return
    return projectWorktreeForDirectory(layoutProjects(), workspaceKey)
  })
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
    // Prefer the canonical `/w/:workspaceId` owner: multiple cloud workspaces
    // can legitimately report the same physical `/workspace` directory. The
    // physical directory remains the fallback for local and legacy routes.
    return routeProjectWorktree() ?? projectWorktreeForDirectory(layoutProjects(), dir)
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

  createEffect(activeDirectory, (dir) => {
    if (dir) void ensureDirectorySessionCache(dir)
  })

  createEffect(
    () => activeDirectory() ?? undefined,
    (dir) => directorySessionCacheActions.setFocused(dir),
  )

  createEffect(
    () => ({ directory: activeDirectory(), session: activeSessionId() }),
    (scope) => notification.setActiveScope(scope),
  )

  // Auto-open the active project. `canAutoOpenProject` consults the open list
  // and `layout.projects.isClosed` — the very state `layout.projects.open`
  // writes — so as one tracked scope this fed its own output straight back in.
  // The compute answers "which directory, if any, should be opened"; the effect
  // opens it. The compute still re-runs after the open, and correctly resolves
  // to `undefined` the second time, so it settles instead of looping.
  createEffect(
    () => {
      if (!globalReady()) return undefined
      const dir = activeDirectory()
      if (!dir) return undefined
      const eligible = canAutoOpenProject({
        api: projectsQuery.data ?? [],
        list: layoutProjects(),
        dir,
        closed: layout.projects.isClosed,
        ignoreClosed: true,
      })
      return eligible ? dir : undefined
    },
    (dir) => {
      if (dir) layout.projects.open(dir)
    },
  )

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
  }
}
