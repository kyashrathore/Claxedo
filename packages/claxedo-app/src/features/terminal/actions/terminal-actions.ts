import { recoverMissingWorkspace, type ActionProps, type Nav } from "@/features/terminal/app-ports"
import { workspaceTerminalRoute } from "@/platform/identity/route"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { flush } from "solid-js"

export function createTerminalActions(props: ActionProps, nav: Nav) {
  const terminalRoute = (workspaceDir: string, terminalId: string) => {
    const workspaceId =
      sameWorkspaceDirectory(props.routeDirectory(), workspaceDir) && props.routeId()
        ? props.routeId()!
        : workspaceDir
    return workspaceTerminalRoute(workspaceId, terminalId)
  }
  const navigateToCommittedTerminal = (
    workspaceDir: string,
    pendingId: string,
    reason: string,
    details: Record<string, unknown>,
  ) => {
    // Solid 2 stages the surface write. Let that commit before the route-intent
    // consumer tries to resolve the pending id, otherwise it redirects to the
    // session root because the authoritative terminal surface is not visible.
    queueMicrotask(() => nav(terminalRoute(workspaceDir, pendingId), reason, details))
  }
  const openTerminal = (
    workspaceDir: string,
    command?: string,
    title?: string,
    paneId?: string,
  ): { contentId: string | undefined; pendingId: string } => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const tabTitle = title || "Terminal"
    let contentId: string | undefined
    flush(() => {
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
      routeDir: props.activeDirectory(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    if (
      recoverMissingWorkspace(props, workspaceDir, (created, project) => {
        const { pendingId } = openTerminal(created, command, title, targetPaneId)
        // Route to the terminal surface explicitly so the focused terminal remains
        // visible even when opened from a session route.
        navigateToCommittedTerminal(created, pendingId, "new terminal recovered workspace", {
          projectId: project.id,
          workspaceDir,
          created,
          command,
          title,
          targetPaneId,
          pendingId,
        })
      })
    )
      return

    const { pendingId } = openTerminal(workspaceDir, command, title, targetPaneId)
    // Same reason as the recovery branch above.
    navigateToCommittedTerminal(workspaceDir, pendingId, "new terminal opened", {
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
