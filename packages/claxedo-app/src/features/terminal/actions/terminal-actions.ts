import { batch } from "solid-js"
import { recoverMissingWorkspace, type ActionProps, type Nav } from "@/features/terminal/app-ports"
import { workspaceTerminalRoute } from "@/platform/identity/route"
import { workspaceRouteId as resolveWorkspaceRouteId } from "@/platform/identity/workspace-route"

export function createTerminalActions(props: ActionProps, nav: Nav) {
  const openTerminal = (
    workspaceDir: string,
    command?: string,
    title?: string,
    paneId?: string,
    workspaceRouteId?: string,
  ): { contentId: string | undefined; pendingId: string } => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const tabTitle = title || "Terminal"
    const focusedContentId = props.state.wb.selectors.focusedContent()
    const sessionId = focusedContentId ? props.state.meta.get(focusedContentId)?.sessionId : undefined
    let contentId: string | undefined
    batch(() => {
      if (paneId) props.state.wb.split.focus(paneId)
      contentId = props.state.layout.openTerminal(workspaceDir, pendingId, tabTitle, {
        command,
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceRouteId ? { workspaceRouteId } : {}),
      })
      props.state.workspacePanel.close()
      if (contentId) {
        props.state.terminal.queueCreateForContent(contentId, workspaceDir, command, title, paneId)
      }
    })
    return { contentId, pendingId }
  }

  const handleNewTerminal = (
    workspaceDir: string,
    command?: string,
    title?: string,
    groupId?: string,
    selectedRouteId?: string,
  ) => {
    const targetPaneId = groupId ?? props.state.wb.state.focusedPaneId ?? undefined
    props.flowLog("new terminal click", {
      workspaceDir,
      command,
      title,
      requestedPaneId: groupId,
      routeDir: props.activeDirectory(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (recoverMissingWorkspace(props, workspaceDir, (created, project) => {
      const routeId = resolveWorkspaceRouteId([project], created)
      if (!routeId) return
      const { pendingId } = openTerminal(created, command, title, targetPaneId, routeId)
      // Route to the terminal surface explicitly so the focused terminal remains
      // visible even when opened from a session route.
      nav(workspaceTerminalRoute(routeId, pendingId), "new terminal recovered workspace", {
        projectId: project.id,
        workspaceDir,
        created,
        command,
        title,
        targetPaneId,
        pendingId,
      })
    })) return

    const routeId = selectedRouteId ?? props.workspaceRouteId(workspaceDir)
    if (!routeId) return
    const { pendingId } = openTerminal(workspaceDir, command, title, targetPaneId, routeId)
    // Same reason as the recovery branch above.
    nav(workspaceTerminalRoute(routeId, pendingId), "new terminal opened", {
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
