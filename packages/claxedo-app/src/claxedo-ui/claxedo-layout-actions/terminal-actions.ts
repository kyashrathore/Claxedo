import { batch } from "solid-js"
import type { ActionProps } from "./shared"
import { recoverMissingWorkspace } from "./workspace-recovery"

export function createTerminalActions(props: ActionProps) {
  const openTerminal = (workspaceDir: string, command?: string, title?: string, paneId?: string) => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const tabTitle = title || "Terminal"
    batch(() => {
      if (paneId) props.state.wb.split.focus(paneId)
      const contentId = props.state.layout.openTerminal(workspaceDir, pendingId, tabTitle, { command })
      if (contentId) {
        props.state.terminal.queueCreateForContent(contentId, workspaceDir, command, title, paneId)
      }
    })
  }

  const handleNewTerminal = (workspaceDir: string, command?: string, title?: string, groupId?: string) => {
    const targetPaneId = groupId ?? props.state.wb.state.focusedPaneId ?? undefined
    props.flowLog("new terminal click", {
      workspaceDir,
      command,
      title,
      requestedPaneId: groupId,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (recoverMissingWorkspace(props, workspaceDir, (created, project) => {
      openTerminal(created, command, title, targetPaneId)
      props.flowLog("new terminal recovered workspace", {
        projectId: project.id,
        workspaceDir,
        created,
        command,
        title,
        targetPaneId,
      })
    })) return

    openTerminal(workspaceDir, command, title, targetPaneId)
  }

  return {
    handleNewTerminal,
  }
}
