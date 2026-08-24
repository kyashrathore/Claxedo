import { routeMatchesSurface, surfaceRoute } from "../state/surface-route"
import { realDirectory, type ContentMeta } from "../state/index"
import type { ActionProps, Nav } from "./shared"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { workspaceRouteIdentity } from "@/features/workspaces/lib/workspace-display"

type OpenSurfaceActionProps = Pick<
  ActionProps,
  "params" | "projects" | "routeDirectory" | "routeId" | "activeDirectory" | "flowLog"
> & {
  state: {
    wb: {
      state: {
        focusedPaneId?: string | null
      }
    }
  }
}

function routeWorkspaceId(props: OpenSurfaceActionProps, workspaceDir: string) {
  const currentRouteId = props.routeId()
  if (currentRouteId && sameWorkspaceDirectory(props.routeDirectory(), workspaceDir)) return currentRouteId

  const explicitWorkspaceId = workspaceRouteIdentity(props.projects(), workspaceDir)?.routeId
  if (explicitWorkspaceId) return explicitWorkspaceId

  // A project's root worktree is represented by the project id. Sandboxes
  // without an explicit workspace id deliberately retain their directory key;
  // routing them through the parent project id would select the main worktree.
  return props.projects().find((project) => project.worktree === workspaceDir)?.id ?? workspaceDir
}

export function createOpenSurfaceActions(props: OpenSurfaceActionProps, nav: Nav) {
  const handleTabSelect = (tab: ContentMeta) => {
    props.flowLog("tab select", {
      surfaceId: tab.id,
      tabType: tab.type,
      tabDir: tab.directory,
      tabSessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
      tabPageId: tab.type === "page" ? tab.pageId : undefined,
      tabTerminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      routeDir: props.routeDirectory(),
      routeSession: props.params.id,
      routePage: props.params.pageId,
      focusedGroup: props.state.wb.state.focusedPaneId,
    })

    if (tab.type === "marketplace" || tab.type === "workgraph") {
      const route = surfaceRoute("", tab)
      if (route) nav(route, "tab-select", { surfaceId: tab.id, tabType: tab.type })
      return
    }

    const workspaceDir = tab.type === "page" ? (realDirectory(tab.directory) ?? props.activeDirectory()) : tab.directory
    if (!workspaceDir) return

    const workspaceId = routeWorkspaceId(props, workspaceDir)
    const route = surfaceRoute(workspaceId, tab)
    if (!route) return
    const currentRouteWorkspaceId = props.routeId() ?? props.routeDirectory()
    if (routeMatchesSurface(props.params, workspaceId, tab, currentRouteWorkspaceId)) return

    const syncRoute = () => {
      if (routeMatchesSurface(props.params, workspaceId, tab, props.routeId() ?? props.routeDirectory())) return
      nav(route, "tab-select", {
        surfaceId: tab.id,
        tabType: tab.type,
        workspaceDir,
        sessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
        pageId: tab.type === "page" ? tab.pageId : undefined,
        terminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      })
    }
    queueMicrotask(syncRoute)
  }

  return {
    handleTabSelect,
  }
}
