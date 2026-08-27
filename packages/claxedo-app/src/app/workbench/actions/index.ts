import type { ActionProps } from "./shared"
import { createProjectActions } from "../../../features/workspaces/actions/project-actions"
import { createSessionActions } from "../../../features/session/actions/session-actions"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"
import { createTerminalActions } from "../../../features/terminal/actions/terminal-actions"
import { createWorkspaceActions } from "../../../features/workspaces/actions/workspace-actions"
import { createPageActions } from "../../../features/documents/actions/page-actions"

export function createClaxedoLayoutActions(props: ActionProps) {
  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    props.flowLog("navigate", { reason, path, ...details })
    props.navigate(path)
  }

  return {
    ...createProjectActions(props, nav),
    ...createWorkspaceActions(props, nav),
    ...createSessionActions(props, nav),
    ...createTerminalActions(props, nav),
    ...createOpenSurfaceActions(props, nav),
    ...createPageActions(props, nav),
  }
}
