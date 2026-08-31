import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import type { LiveSession } from "../global-sdk-event-fetch"
import {
  applySessionGoalRuntimeEvent,
  invalidateSessionGoalData,
} from "@/features/session/store/session-goal-query"
import type { SessionResourceAuthorityScope } from "@/features/session/store/session-resource-authority"
import { USER_HOSTED_WORKSPACE_KIND } from "./live-session"

function goalWorkspaceKind(input: unknown) {
  const kind = input === "local" || input === "cloud" || input === USER_HOSTED_WORKSPACE_KIND ? input : undefined
  return kind === "local" ? undefined : kind
}

export function liveSessionGoalScope(input: {
  live?: LiveSession
  serverUrl?: string
  signedControlPlane: boolean
}): SessionResourceAuthorityScope | undefined {
  const live = input.live
  if (!live?.directory) return
  return {
    sessionID: live.sessionID,
    directory: live.directory,
    serverUrl: input.serverUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: live.workspaceId,
    workspaceKind: goalWorkspaceKind(live.workspaceKind),
    sessionRef: live.sessionRef,
  }
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
