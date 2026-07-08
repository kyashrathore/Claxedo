import { sessionRoute as canonicalSessionRoute } from "../../shell/identity/route"
import { sessionInventoryTarget } from "./route-intent"

export type RuntimeRouteSessionInventory = {
  byWorkspace: Record<string, { key?: string; workspaceId?: string; directory?: string; sessions?: Array<{ id?: string }> }>
  byProject: Record<string, Array<{ id?: string; workspaceId?: string; directory?: string }>>
}

export function recoverWorkspaceRuntimeRoute(input: {
  routeDir: string | undefined
  sessionId: string | undefined
  byWorkspace: RuntimeRouteSessionInventory["byWorkspace"]
  byProject: RuntimeRouteSessionInventory["byProject"]
}) {
  if (input.routeDir !== "/workspace" || !input.sessionId) return
  if (!sessionInventoryTarget(input.sessionId, {
    byWorkspace: input.byWorkspace,
    byProject: input.byProject,
  })) return
  return canonicalSessionRoute(input.sessionId)
}
