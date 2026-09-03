import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import type { LiveSession } from "../global-sdk-event-fetch"
import {
  applySessionGoalRuntimeEvent,
  invalidateSessionGoalData,
} from "@/features/session/store/session-goal-query"
import {
  sessionResourceAuthorityScope,
  type SessionResourceAuthorityScope,
} from "@/features/session/store/session-resource-authority"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"

function goalWorkspaceKind(input: unknown) {
  const kind = workspaceKind(input)
  return kind === "local" ? undefined : kind
}

/**
 * The event side must key Goal state exactly the way the read/write side does.
 * `sessionResourceAuthorityScope` owns that gate (notably: the workspace
 * identity counts only under the signed control plane) — building the scope
 * inline here is what let goal events write to a key nobody reads.
 */
export function liveSessionGoalScope(input: {
  live?: LiveSession
  serverUrl?: string
  signedControlPlane: boolean
}): SessionResourceAuthorityScope | undefined {
  const live = input.live
  if (!live?.directory) return
  return sessionResourceAuthorityScope({
    sessionID: live.sessionID,
    directory: live.directory,
    serverUrl: input.serverUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: live.workspaceId,
    workspaceKind: goalWorkspaceKind(live.workspaceKind),
    sessionRef: live.sessionRef,
  })
}

export function applyLiveSessionGoalEvent(input: {
  live?: LiveSession
  serverUrl?: string
  signedControlPlane: boolean
  sessionId: string
  payload: Extract<AgentRuntimeEvent, { type: "goal-updated" | "goal-cleared" }>
}) {
  if (input.live?.sessionID !== input.sessionId) return false
  const scope = liveSessionGoalScope(input)
  return scope ? applySessionGoalRuntimeEvent({ scope, sessionId: input.sessionId, payload: input.payload }) : false
}

export { invalidateSessionGoalData }
