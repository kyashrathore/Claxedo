import { batch } from "solid-js"
import type { ActionProps } from "./shared"

export function createTerminalActions(props: ActionProps) {
  const handleNewTerminal = (workspaceDir: string, command?: string, title?: string, groupId?: string) => {
    props.flowLog("new terminal click", {
      workspaceDir,
      command,
      title,
      requestedGroupId: groupId,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedGroup: props.claxedo.split.focusedId(),
      pendingCreate: props.claxedo.terminal.pendingCreate(),
      creating: props.claxedo.terminal.creating(),
      creatingGroupId: props.claxedo.terminal.creatingGroupId(),
    })

    const targetGroupId = groupId ?? props.claxedo.split.focusedId()
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })
    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const tabTitle = title || "Terminal"

    // Batch tab creation and queueing so the terminal panel's mount effect
    // sees the queued command immediately when it runs.
    batch(() => {
      const tabId = tabs.addTerminal(workspaceDir, pendingId, tabTitle)
      if (tabId) {
        props.claxedo.terminal.queueCreateForTab(tabId, workspaceDir, command, title, targetGroupId)
      }
    })
  }

  return {
    handleNewTerminal,
  }
}
