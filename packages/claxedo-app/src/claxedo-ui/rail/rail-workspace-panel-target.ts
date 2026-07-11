import { createMemo, type Accessor } from "solid-js"

import type { ContentMeta } from "../state"
import type { WorkspacePanelPaneTarget } from "../workspace-panel/workspace-panel-state"
import {
  workspacePanelTargetForContent,
  workspaceToolsBlockedForContent,
} from "./workspace-surface-gates"

type RailWorkspacePanelTargetState = {
  wb: {
    state: {
      focusedPaneId?: string | null
      panes: readonly { id: string; contentId?: string | null }[]
    }
    selectors: {
      focusedContent: () => string | null | undefined
      visiblePanes: () => readonly { id: string; contentId?: string | null }[]
    }
  }
  meta: {
    get: (contentId: string) => ContentMeta | undefined
  }
  workspace: {
    paneWorktree: (paneId: string) => { pinned?: string | null; default?: string | null }
  }
}

export function useRailWorkspacePanelTarget(input: {
  state: RailWorkspacePanelTargetState
  activeWorkspaceId: Accessor<string | undefined>
}) {
  const visiblePanes = createMemo(() => input.state.wb.selectors.visiblePanes())

  const workspacePanelTargetForPane = (paneId: string): WorkspacePanelPaneTarget | undefined => {
    const contentId = input.state.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
    const active = contentId ? input.state.meta.get(contentId) : undefined
    const contentTarget = workspacePanelTargetForContent(active, paneId)
    if (contentTarget) return contentTarget
    if (workspaceToolsBlockedForContent(active)) return undefined

    const activeWorkspaceId = input.activeWorkspaceId()
    if (activeWorkspaceId) {
      return {
        workspaceDir: activeWorkspaceId,
        targetPaneId: paneId,
      }
    }

    const wt = input.state.workspace.paneWorktree(paneId)
    const pinned = wt.pinned
    if (pinned && pinned !== "__process__") {
      return {
        workspaceDir: pinned,
        targetPaneId: paneId,
      }
    }

    const workspaceDir = wt.default
    if (!workspaceDir || workspaceDir === "__process__") return undefined
    return {
      workspaceDir,
      targetPaneId: paneId,
    }
  }

  const focusedSplitPaneId = () => input.state.wb.state.focusedPaneId ?? visiblePanes()[0]?.id
  const focusedPanelTarget = () => {
    const paneId = focusedSplitPaneId()
    if (!paneId) return
    return workspacePanelTargetForPane(paneId)
  }
  const focusedSurfaceWorkspaceToolsBlocked = () => {
    const contentId = input.state.wb.selectors.focusedContent()
    return workspaceToolsBlockedForContent(contentId ? input.state.meta.get(contentId) : undefined)
  }

  return {
    focusedPanelTarget,
    focusedSplitPaneId,
    focusedSurfaceWorkspaceToolsBlocked,
    workspacePanelTargetForPane,
  }
}
