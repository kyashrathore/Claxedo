import type { ProjectItem } from "../layouts/rail-sidebar"
import { itemRoute, sessionRoute } from "../context/claxedo-layout/tab-route"
import type { ActionProps, Nav } from "./shared"
import { recoverMissingWorkspace } from "./workspace-recovery"

export function createWorkspaceActions(props: ActionProps, nav: Nav) {
  const handleWorkspaceSelect = (project: ProjectItem, workspaceDir: string) => {
    props.flowLog("workspace select", {
      projectId: project.id,
      workspaceDir,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      routeTab: props.params.tabId,
      activeTabId: props.claxedo.topTabs.activeId(),
      activeTabDir: props.claxedo.topTabs.active()?.directory,
      focusedGroup: props.claxedo.split.focusedId(),
    })

    const focusedId = props.claxedo.split.focusedId()
    const tabs = focusedId ? props.claxedo.groupTabs(focusedId) : props.claxedo.topTabs
    const existing = tabs.orderedItems().find((tab) => tab.directory === workspaceDir && tab.type !== "process")

    if (existing) {
      props.claxedo.workspaceRecency.recordAccess(project.id, workspaceDir)
      props.claxedo.worktree.setPinned(null)
      props.claxedo.worktree.setDefault(workspaceDir)
      props.globalSync.child(workspaceDir)
      tabs.setActive(existing.id)
      props.flowLog("workspace select reused existing tab", {
        workspaceDir,
        tabId: existing.id,
        tabType: existing.type,
        sessionId:
          existing.type === "session" || existing.type === "review" || existing.type === "review-workspace" || existing.type === "context"
            ? existing.sessionId
            : undefined,
      })
      if (
        (existing.type === "session" || existing.type === "review" || existing.type === "review-workspace" || existing.type === "context") &&
        existing.sessionId &&
        existing.sessionId !== "new"
      ) {
        nav(itemRoute(workspaceDir, existing), "workspace-select:existing-session", {
          projectId: project.id,
          workspaceDir,
          tabId: existing.id,
          sessionId: existing.sessionId,
        })
        return
      }
      nav(itemRoute(workspaceDir, existing), "workspace-select:existing-tab", {
        projectId: project.id,
        workspaceDir,
        tabId: existing.id,
        tabType: existing.type,
      })
      return
    }

    if (recoverMissingWorkspace(props, workspaceDir, (created) => {
      props.globalSync.child(created)
      props.claxedo.workspaceRecency.recordAccess(project.id, created)
      props.claxedo.worktree.setPinned(null)
      props.claxedo.worktree.setDefault(created)
      const tabId = tabs.addSession(created, "new", "New Session")
      if (tabId) tabs.setActive(tabId)
      if (tabId) {
        nav(sessionRoute(created), "workspace-select:recovered-workspace", {
          projectId: project.id,
          workspaceDir,
          created,
          tabId,
        })
      }
    })) return

    props.claxedo.workspaceRecency.recordAccess(project.id, workspaceDir)
    props.claxedo.worktree.setPinned(null)
    props.claxedo.worktree.setDefault(workspaceDir)
    props.globalSync.child(workspaceDir)

    const id = tabs.addSession(workspaceDir, "new", "New Session")
    if (id) tabs.setActive(id)
    if (id)
      nav(sessionRoute(workspaceDir), "workspace-select:new-session", {
        projectId: project.id,
        workspaceDir,
        tabId: id,
      })
  }

  return {
    handleWorkspaceSelect,
  }
}
