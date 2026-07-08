import type { Workspace } from "../workspace-store"
import { deleteWorkspace } from "../workspace-store"
import { discardSupervisorSandbox } from "../workspace-supervisor"
import type { ProjectionStore } from "./projection-store"
import { rm } from "fs/promises"

export type SessionLifecycleDecision =
  | { workspaceDeleted: true; reason: string; nextSessionId: null }
  | {
    workspaceDeleted: false
    reason: "no_workspace" | "not_cloud" | "active_sessions"
    activeSessionCount?: number
    nextSessionId: string | null
  }

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

export function sessionIsArchived(input: unknown) {
  const row = rec(input)
  const time = rec(row?.time)
  return typeof time?.archived === "number" ||
    typeof row?.archived === "number" ||
    typeof row?.archived_at === "number"
}

export async function deleteCloudWorkspaceWhenNoActiveSessions(input: {
  workspace?: Workspace
  projectionStore: Pick<ProjectionStore, "list_session_metas">
  reason: string
}): Promise<SessionLifecycleDecision> {
  if (!input.workspace) return { workspaceDeleted: false, reason: "no_workspace", nextSessionId: null }

  const active = await input.projectionStore.list_session_metas({
    ...(input.workspace.id === "global"
      ? { directory: input.workspace.directory }
      : { workspaceID: input.workspace.id }),
  })
  const nextSessionId = active[0]?.sessionID ?? null

  if (input.workspace.id === "global" || input.workspace.kind !== "cloud") {
    return { workspaceDeleted: false, reason: "not_cloud", activeSessionCount: active.length, nextSessionId }
  }

  if (active.length > 0) {
    return {
      workspaceDeleted: false,
      reason: "active_sessions",
      activeSessionCount: active.length,
      nextSessionId,
    }
  }

  await discardSupervisorSandbox(input.workspace.id, input.reason)
  await deleteWorkspace(input.workspace.id)
  await rm(input.workspace.directory, { recursive: true, force: true }).catch(() => {})
  return { workspaceDeleted: true, reason: input.reason, nextSessionId: null }
}
