import { batch } from "solid-js"
import type { ActionProps, Nav } from "./shared"
import { recoverMissingWorkspace } from "./workspace-recovery"
import { workspaceTerminalRoute } from "../../shell/identity/route"

export function createTerminalActions(props: ActionProps, nav: Nav) {
  const openTerminal = (
    workspaceDir: string,
    command?: string,
    title?: string,
    paneId?: string,
  ): { contentId: string | undefined; pendingId: string } => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const tabTitle = title || "Terminal"
    let contentId: string | undefined
    batch(() => {
      if (paneId) props.state.wb.split.focus(paneId)
      contentId = props.state.layout.openTerminal(workspaceDir, pendingId, tabTitle, { command })
      props.state.workspacePanel.close()
      if (contentId) {
        props.state.terminal.queueCreateForContent(contentId, workspaceDir, command, title, paneId)
      }
    })
    return { contentId, pendingId }
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
      const { pendingId } = openTerminal(created, command, title, targetPaneId)
      // Route to the terminal surface explicitly so the focused terminal remains
      // visible even when opened from a session route.
      nav(workspaceTerminalRoute(created, pendingId), "new terminal recovered workspace", {
        projectId: project.id,
        workspaceDir,
        created,
        command,
        title,
        targetPaneId,
        pendingId,
      })
    })) return

    const { pendingId } = openTerminal(workspaceDir, command, title, targetPaneId)
    // Same reason as the recovery branch above.
    nav(workspaceTerminalRoute(workspaceDir, pendingId), "new terminal opened", {
      workspaceDir,
      command,
      title,
      targetPaneId,
      pendingId,
    })
  }

  return {
    handleNewTerminal,
  }
}
