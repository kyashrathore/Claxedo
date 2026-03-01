import { base64Encode } from "@opencode-ai/util/encode"

import type { TabItem } from "../context/claxedo-layout"
import type { ActionProps, Nav } from "./shared"

export function createTabActions(props: ActionProps, nav: Nav) {
  const handleTabSelect = (tab: TabItem) => {
    props.flowLog("tab select", {
      tabId: tab.id,
      tabType: tab.type,
      tabDir: tab.directory,
      tabSessionId:
        tab.type === "session" || tab.type === "review" || tab.type === "context" ? tab.sessionId : undefined,
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
        ? tab.directory && tab.directory !== "__pages__"
          ? tab.directory
          : props.activeWorkspaceId()
        : tab.directory
    if (!workspaceDir) return

    nav(`/${base64Encode(workspaceDir)}/tab/${tab.id}`, "tab-select", {
      tabId: tab.id,
      tabType: tab.type,
      workspaceDir,
      sessionId: tab.type === "session" || tab.type === "review" || tab.type === "context" ? tab.sessionId : undefined,
      pageId: tab.type === "page" ? tab.pageId : undefined,
      terminalId: tab.type === "terminal" ? tab.terminalId : undefined,
    })
  }

  return {
    handleTabSelect,
  }
}
