import type { ProjectItem } from "../layouts/rail-sidebar"
import { sessionRoute, surfaceRoute } from "../state/surface-route"
import type { ActionProps, Nav } from "./shared"
import { recoverMissingWorkspace } from "./workspace-recovery"

export function createWorkspaceActions(props: ActionProps, nav: Nav) {
  const setFocusedWorkspace = (workspaceDir: string) => {
    const paneId = props.state.wb.state.focusedPaneId
    if (!paneId) return
    props.state.workspace.setPaneWorktreePinned(paneId, null)
    props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
  }

  const handleWorkspaceSelect = (project: ProjectItem, workspaceDir: string) => {
    props.flowLog("workspace select", {
      projectId: project.id,
      workspaceDir,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedPane: props.state.wb.state.focusedPaneId,
    })

    const existing = props.state.meta.find((meta) => meta.directory === workspaceDir)

    if (existing) {
      props.state.workspace.recordAccess(project.id, workspaceDir)
      setFocusedWorkspace(workspaceDir)
      props.globalSync.child(workspaceDir)
      props.state.layout.showContent(existing.id)
      props.flowLog("workspace select reused existing content", {
        workspaceDir,
        contentId: existing.id,
        contentType: existing.type,
        sessionId: existing.sessionId,
      })
      if ((existing.type === "session" || existing.type === "context") && existing.sessionId && existing.sessionId !== "new") {
        nav(sessionRoute(workspaceDir, existing.sessionId), "workspace-select:existing-session", {
          projectId: project.id,
          workspaceDir,
          contentId: existing.id,
          sessionId: existing.sessionId,
        })
        return
      }
      const route = surfaceRoute(workspaceDir, existing)
      if (route) {
        nav(route, "workspace-select:existing-content", {
          projectId: project.id,
          workspaceDir,
          contentId: existing.id,
          contentType: existing.type,
        })
      }
      return
    }

    if (recoverMissingWorkspace(props, workspaceDir, (created) => {
      props.globalSync.child(created)
      props.state.workspace.recordAccess(project.id, created)
      setFocusedWorkspace(created)
      props.state.layout.openSession(created, "new", "New Session")
      nav(sessionRoute(created), "workspace-select:recovered-workspace", {
        projectId: project.id,
        workspaceDir,
        created,
      })
    })) return

    props.state.workspace.recordAccess(project.id, workspaceDir)
    setFocusedWorkspace(workspaceDir)
    props.globalSync.child(workspaceDir)
    props.state.layout.openSession(workspaceDir, "new", "New Session")
    nav(sessionRoute(workspaceDir), "workspace-select:new-session", {
      projectId: project.id,
      workspaceDir,
    })
  }

  return {
    handleWorkspaceSelect,
  }
}
