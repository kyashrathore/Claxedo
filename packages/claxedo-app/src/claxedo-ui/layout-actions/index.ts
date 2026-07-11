import type { ActionProps } from "./shared"
import { createProjectActions } from "./project-actions"
import { createSessionActions } from "./session-actions"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"
import { createTerminalActions } from "./terminal-actions"
import { createWorkspaceActions } from "./workspace-actions"
import { createPageActions } from "./page-actions"

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
    ...createPageActions(props),
  }
}
