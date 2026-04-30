import { surfaceRoute } from "../state/surface-route"
import { realDirectory, type ContentMeta } from "../state"
import type { ActionProps, Nav } from "./shared"

export function createOpenSurfaceActions(props: ActionProps, nav: Nav) {
  const handleTabSelect = (tab: ContentMeta) => {
    props.flowLog("tab select", {
      surfaceId: tab.id,
      tabType: tab.type,
      tabDir: tab.directory,
      tabSessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
      tabPageId: tab.type === "page" ? tab.pageId : undefined,
      tabTerminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      routePage: props.params.pageId,
      focusedGroup: props.state.wb.state.focusedPaneId,
    })

    const workspaceDir =
      tab.type === "page"
        ? realDirectory(tab.directory) ?? props.activeWorkspaceId()
        : tab.directory
    if (!workspaceDir) return

    const route = surfaceRoute(workspaceDir, tab)
    if (!route) return

    nav(route, "tab-select", {
      surfaceId: tab.id,
      tabType: tab.type,
      workspaceDir,
      sessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
      pageId: tab.type === "page" ? tab.pageId : undefined,
      terminalId: tab.type === "terminal" ? tab.terminalId : undefined,
    })
  }

  return {
    handleTabSelect,
  }
}
