import type { ActionProps } from "./claxedo-layout-actions/shared"
import { createProjectActions } from "./claxedo-layout-actions/project-actions"
import { createSessionActions } from "./claxedo-layout-actions/session-actions"
import { createOpenSurfaceActions } from "./claxedo-layout-actions/open-surface-actions-ui"
import { createTerminalActions } from "./claxedo-layout-actions/terminal-actions"
import { createWorkspaceActions } from "./claxedo-layout-actions/workspace-actions"
import { createPageActions } from "./claxedo-layout-actions/page-actions"

export function createClaxedoLayoutActions(props: ActionProps) {
  const nav = (path: string, reason: string, details?: Record<string, unknown>) => {
    props.flowLog("navigate", { reason, path, ...details })
    props.navigate(path)
  }

  return {
    ...createProjectActions(props, nav),
    ...createWorkspaceActions(props, nav),
    ...createSessionActions(props, nav),
    ...createTerminalActions(props),
    ...createOpenSurfaceActions(props, nav),
    ...createPageActions(props),
  }
}
