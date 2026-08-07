import type { ActionProps } from "./shared"
import { createProjectActions } from "../../../features/workspaces/actions/project-actions"
import { createSessionActions } from "../../../features/session/actions/session-actions"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"
import { createTerminalActions } from "../../../features/terminal/actions/terminal-actions"
import { createWorkspaceActions } from "../../../features/workspaces/actions/workspace-actions"

export function createClaxedoLayoutActions(props: ActionProps) {
  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    props.flowLog("navigate", { reason, path, ...details })
    props.navigate(path)
  }
  const handleNewPage = props.config?.documentsEnabled
    ? () => {
        void import("../../../features/documents/actions/page-actions").then((module) => {
          module.createPageActions(props).handleNewPage()
        })
      }
    : undefined

  return {
    ...createProjectActions(props, nav),
    ...createWorkspaceActions(props, nav),
    ...createSessionActions(props, nav),
    ...createTerminalActions(props, nav),
    ...createOpenSurfaceActions(props, nav),
    handleNewPage,
  }
}
