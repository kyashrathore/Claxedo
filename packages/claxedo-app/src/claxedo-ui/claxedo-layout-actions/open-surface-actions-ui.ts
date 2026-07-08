import { routeMatchesSurface, surfaceRoute } from "../state/surface-route"
import { realDirectory, type ContentMeta } from "../state"
import type { ActionProps, Nav } from "./shared"

type OpenSurfaceActionProps = Pick<ActionProps, "params" | "routeWorkspaceId" | "activeWorkspaceId" | "flowLog"> & {
  state: {
    wb: {
      state: {
        focusedPaneId?: string | null
      }
    }
  }
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
      routeDir: props.routeWorkspaceId(),
      routeSession: props.params.id,
      routePage: props.params.pageId,
      focusedGroup: props.state.wb.state.focusedPaneId,
    })

    if (tab.type === "marketplace") {
      const route = surfaceRoute("", tab)
      if (route) nav(route, "tab-select", { surfaceId: tab.id, tabType: tab.type })
      return
    }

    const workspaceDir =
      tab.type === "page"
        ? realDirectory(tab.directory) ?? props.activeWorkspaceId()
        : tab.directory
    if (!workspaceDir) return

    const route = surfaceRoute(workspaceDir, tab)
    if (!route) return
    if (routeMatchesSurface(props.params, workspaceDir, tab, props.routeWorkspaceId())) return

    const syncRoute = () => {
      if (routeMatchesSurface(props.params, workspaceDir, tab, props.routeWorkspaceId())) return
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
