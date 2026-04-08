import type { TabItem } from "../context/claxedo-layout"
import { itemRoute } from "../context/claxedo-layout/tab-route"
import { realDirectory } from "../context/claxedo-layout/types"
import type { ActionProps, Nav } from "./shared"

export function createTabActions(props: ActionProps, nav: Nav) {
  const handleTabSelect = (tab: TabItem) => {
    props.flowLog("tab select", {
      tabId: tab.id,
      tabType: tab.type,
      tabDir: tab.directory,
      tabSessionId:
        tab.type === "session" || tab.type === "review" || tab.type === "review-workspace" || tab.type === "context" ? tab.sessionId : undefined,
      tabPageId: tab.type === "page" ? tab.pageId : undefined,
      tabTerminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      routePage: props.params.pageId,
      routeTab: props.params.tabId,
      focusedGroup: props.claxedo.split.focusedId(),
    })

    const workspaceDir =
      tab.type === "page"
        ? realDirectory(tab.directory) ?? props.activeWorkspaceId()
        : tab.directory
    if (!workspaceDir) return

    nav(itemRoute(workspaceDir, tab), "tab-select", {
      tabId: tab.id,
      tabType: tab.type,
      workspaceDir,
      sessionId: tab.type === "session" || tab.type === "review" || tab.type === "review-workspace" || tab.type === "context" ? tab.sessionId : undefined,
      pageId: tab.type === "page" ? tab.pageId : undefined,
      terminalId: tab.type === "terminal" ? tab.terminalId : undefined,
    })
  }

  return {
    handleTabSelect,
  }
}
