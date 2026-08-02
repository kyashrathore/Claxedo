import { createMemo, type Accessor } from "solid-js"
import { getFilename } from "@/lib/path"

import type { ContentMeta } from "../state/index"
import type { ProjectItem } from "./domain-types"
import { workspaceToolDirectoryForContent, workspaceToolsBlockedForContent } from "./workspace-surface-gates"
import {
  railProjectHasDir,
  railProjectMatchesRef,
  type RailWorktreeInfo,
} from "./rail-project-session-info"

type RailSidebarSelectionState = {
  wb: {
    state: {
      focusedPaneId?: string | null
      panes: readonly { id: string; contentId?: string | null }[]
    }
    selectors: {
      focusedContent: () => string | null | undefined
    }
  }
  meta: {
    get: (contentId: string) => ContentMeta | undefined
  }
  workspace: {
    paneWorktree: (paneId: string) => { pinned?: string | null; default?: string | null }
  }
}

export function useRailSidebarSelection(input: {
  state: RailSidebarSelectionState
  projects: Accessor<ProjectItem[]>
  activeProjectId: Accessor<string | undefined>
  activeDirectory: Accessor<string | undefined>
  projectCaption: (project: ProjectItem) => string
  worktreeInfo: (workspaceDir: string) => RailWorktreeInfo | undefined
}) {
  const sidebarDir = createMemo(() => {
    if (input.activeDirectory()) return input.activeDirectory()
    const focusedId = input.state.wb.state.focusedPaneId
    if (!focusedId) return undefined
    const contentId = input.state.wb.selectors.focusedContent()
    const surface = contentId ? input.state.meta.get(contentId) : undefined
    const surfaceDir = workspaceToolDirectoryForContent(surface)
    if (surfaceDir) return surfaceDir
    if (workspaceToolsBlockedForContent(surface)) return undefined
    const wt = input.state.workspace.paneWorktree(focusedId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") return pinned
    const workspaceDir = wt.default
    if (workspaceDir && workspaceDir !== "__process__") return workspaceDir
    return undefined
  })

  const sidebarProject = createMemo(() => {
    const workspaceDir = sidebarDir()
    if (workspaceDir) {
      const hit = input.projects().find((project) => railProjectHasDir(project, workspaceDir))
      if (hit) return hit
    }
    if (input.activeProjectId()) return input.projects().find((project) => railProjectMatchesRef(project, input.activeProjectId()))
    return undefined
  })

  const focusedPaneWorkspaceDir = (paneId?: string) => {
    if (!paneId) return undefined
    const contentId = input.state.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
    const active = contentId ? input.state.meta.get(contentId) : undefined
    const activeDir = workspaceToolDirectoryForContent(active)
    if (activeDir) return activeDir
    if (workspaceToolsBlockedForContent(active)) return undefined

    const wt = input.state.workspace.paneWorktree(paneId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") return pinned

    const workspaceDir = wt.default
    if (workspaceDir && workspaceDir !== "__process__") return workspaceDir

    return input.activeDirectory()
  }

  const sidebarProjectName = createMemo(() => {
    const project = sidebarProject()
    return project ? input.projectCaption(project) : ""
  })
  const sidebarWorkspaceName = createMemo(() => {
    const workspaceDir = sidebarDir()
    if (!workspaceDir) return ""
    const info = input.worktreeInfo(workspaceDir)
    return info?.name || getFilename(workspaceDir)
  })

  return {
    focusedPaneWorkspaceDir,
    sidebarDir,
    sidebarProjectName,
    sidebarWorkspaceName,
  }
}
