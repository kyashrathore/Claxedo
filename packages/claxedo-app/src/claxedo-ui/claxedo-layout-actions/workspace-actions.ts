// `handleWorkspaceSelect` uses `props.state.{layout,workspace,wb,meta}`
// instead of the legacy `props.claxedo.{topTabs,groupTabs,split,worktree,workspaceRecency}`
// surface, which no longer exists on `ActionProps`.
//
// Behaviour preserved:
// - Records workspace access for recency.
// - If a session content already exists for this directory, opens it
//   (workbench dedup via `meta.find`); else opens a fresh "new"
//   session and lets the session route claim a real id later.
// - Pane-scoped worktree pinning binds the focused pane to the
//   selected workspace so subsequent terminal/page creates inherit
//   the directory.
// - Hands off to `recoverMissingWorkspace` when the workspace was
//   deleted on disk; honours the recovery callback's directory.

import type { ProjectItem } from "../layouts/rail-sidebar"
import { sessionRoute as canonicalSessionRoute, workspaceSessionRoute } from "../../shell/identity/route"
import type { ActionProps, Nav } from "./shared"
import { ensureDirectorySessionCache, sessionRefForActionWorkspace } from "./shared"
import { recoverMissingWorkspace, type LocalWorkspaceProps } from "./workspace-recovery"

export type WorkspaceActionProps = LocalWorkspaceProps & Pick<
  ActionProps,
  "activeWorkspaceId" | "directorySessionCacheActions" | "flowLog" | "params" | "projects"
> & {
  state: LocalWorkspaceProps["state"] & {
    layout: Pick<ActionProps["state"]["layout"], "openSession">
    meta: Pick<ActionProps["state"]["meta"], "find">
  }
}

export function createWorkspaceActions(props: WorkspaceActionProps, nav: Nav) {
  const focusedPaneId = (): string | undefined => props.state.wb.state.focusedPaneId ?? undefined

  const bindWorktree = (workspaceDir: string) => {
    const paneId = focusedPaneId()
    if (!paneId) return
    props.state.workspace.setPaneWorktreePinned(paneId, null)
    props.state.workspace.setPaneWorktreeDefault(paneId, workspaceDir)
  }

  const findExistingSessionContent = (workspaceDir: string) => {
    return props.state.meta.find(
      (m) => m.type === "session" && m.directory === workspaceDir,
    )
  }

  const openOrCreateSession = (workspaceDir: string): { id: string; sessionId: string; reused: boolean } => {
    const existing = findExistingSessionContent(workspaceDir)
    if (existing && existing.type === "session" && existing.sessionId) {
      const id = props.state.layout.openSession(workspaceDir, existing.sessionId, undefined, {
        sessionRef: existing.content?.sessionRef ?? sessionRefForActionWorkspace({
          projects: props.projects,
          workspaceDir,
          sessionId: existing.sessionId,
        }),
      })
      return { id, sessionId: existing.sessionId, reused: true }
    }
    const id = props.state.layout.openSession(workspaceDir, "new", "New Session")
    return { id, sessionId: "new", reused: false }
  }

  const handleWorkspaceSelect = (project: ProjectItem, workspaceDir: string) => {
    props.flowLog("workspace select", {
      projectId: project.id,
      workspaceDir,
      routeDir: props.activeWorkspaceId(),
      routeSession: props.params.id,
      focusedPaneId: focusedPaneId(),
    })

    if (recoverMissingWorkspace(props, workspaceDir, (created) => {
      void ensureDirectorySessionCache(props.directorySessionCacheActions, created)
      props.state.workspace.recordAccess(project.id, created)
      bindWorktree(created)
      const { id } = openOrCreateSession(created)
      nav(workspaceSessionRoute(created), "workspace-select:recovered-workspace", {
        projectId: project.id,
        workspaceDir,
        created,
        contentId: id,
      })
    })) return

    props.state.workspace.recordAccess(project.id, workspaceDir)
    bindWorktree(workspaceDir)
    void ensureDirectorySessionCache(props.directorySessionCacheActions, workspaceDir)

    const { id, sessionId, reused } = openOrCreateSession(workspaceDir)
    nav(reused ? canonicalSessionRoute(sessionId) : workspaceSessionRoute(workspaceDir), reused
      ? "workspace-select:reused-session"
      : "workspace-select:new-session",
    {
      projectId: project.id,
      workspaceDir,
      contentId: id,
    })
  }

  return {
    handleWorkspaceSelect,
  }
}
