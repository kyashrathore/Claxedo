import { base64Encode } from "@opencode-ai/util/encode"

import type { ProjectItem } from "../layouts/rail-sidebar"
import type { ActionProps, Nav } from "./shared"

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

    props.claxedo.workspaceRecency.recordAccess(project.id, workspaceDir)
    props.claxedo.worktree.setPinned(null)
    props.claxedo.worktree.setDefault(workspaceDir)
    props.globalSync.child(workspaceDir)

    const focusedId = props.claxedo.split.focusedId()
    const tabs = focusedId ? props.claxedo.groupTabs(focusedId) : props.claxedo.topTabs
    const existing = tabs.orderedItems().find((tab) => tab.directory === workspaceDir && tab.type !== "process")

    if (existing) {
      tabs.setActive(existing.id)
      props.flowLog("workspace select reused existing tab", {
        workspaceDir,
        tabId: existing.id,
        tabType: existing.type,
        sessionId:
          existing.type === "session" || existing.type === "review" || existing.type === "context"
            ? existing.sessionId
            : undefined,
      })
      if (
        (existing.type === "session" || existing.type === "review" || existing.type === "context") &&
        existing.sessionId &&
        existing.sessionId !== "new"
      ) {
        nav(`/${base64Encode(workspaceDir)}/tab/${existing.id}`, "workspace-select:existing-session", {
          projectId: project.id,
          workspaceDir,
          tabId: existing.id,
          sessionId: existing.sessionId,
        })
        return
      }
      nav(`/${base64Encode(workspaceDir)}/tab/${existing.id}`, "workspace-select:existing-tab", {
        projectId: project.id,
        workspaceDir,
        tabId: existing.id,
        tabType: existing.type,
      })
      return
    }

    const id = tabs.addSession(workspaceDir, "new", "New Session")
    if (id) tabs.setActive(id)
    if (id)
      nav(`/${base64Encode(workspaceDir)}/tab/${id}`, "workspace-select:new-session", {
        projectId: project.id,
        workspaceDir,
        tabId: id,
      })
  }

  return {
    handleWorkspaceSelect,
  }
}
