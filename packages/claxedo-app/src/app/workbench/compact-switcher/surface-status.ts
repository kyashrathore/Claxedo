import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import type { TerminalAgentStatus } from "../state/types"
import type { SwitcherStatus } from "./switcher-items"

export type SurfaceSessionRequests = {
  permissions?: readonly PermissionRequest[]
  questions?: readonly QuestionRequest[]
}

export function terminalSurfaceStatus(input: { status?: TerminalAgentStatus; seen?: boolean }): SwitcherStatus {
  if (input.status === "permission") return "permission"
  if (input.status === "working") return "working"
  if (input.seen) return "done"
  return "idle"
}

export function sessionSurfaceStatus(input: {
  statusType?: string
  requests?: SurfaceSessionRequests
  directory?: string
  unseenDone?: boolean
  autoResponds?: (request: PermissionRequest, directory: string) => boolean
}): SwitcherStatus {
  if (hasBlockingSessionRequest(input)) return "permission"
  if (input.statusType === "busy" || input.statusType === "retry") return "working"
  if (input.unseenDone) return "done"
  return "idle"
}

export function sessionSurfaceActive(input: {
  statusType?: string
  requests?: SurfaceSessionRequests
  directory?: string
  autoResponds?: (request: PermissionRequest, directory: string) => boolean
}) {
  return sessionSurfaceStatus(input) === "permission" || input.statusType === "busy" || input.statusType === "retry"
}

/**
 * Single status seam for a workbench surface. Both the compact header strip
 * (rail-layout) and any future surface dispatch through here, so the
 * meta-kind → status mapping lives in exactly one place. Callers resolve the
 * live status inputs (terminal agent status, session status type, requests,
 * unseen-done) and hand them in; the dispatch logic is owned here.
 */
export function surfaceStatusForMeta(input: {
  meta?: {
    type: string
    terminalId?: string
    sessionId?: string
    directory?: string
  }
  terminalAgentStatus?: TerminalAgentStatus
  terminalSeen?: boolean
  sessionStatusType?: string
  sessionRequests?: SurfaceSessionRequests
  sessionUnseenDone?: boolean
  autoResponds?: (request: PermissionRequest, directory: string) => boolean
}): SwitcherStatus {
  const meta = input.meta
  if (!meta) return "idle"

  if (meta.type === "terminal") {
    if (!meta.terminalId) return "idle"
    return terminalSurfaceStatus({
      status: input.terminalAgentStatus,
      seen: input.terminalSeen,
    })
  }

  if (meta.type === "session" && meta.sessionId && meta.sessionId !== "new") {
    return sessionSurfaceStatus({
      statusType: input.sessionStatusType,
      requests: input.sessionRequests,
      directory: meta.directory,
      unseenDone: input.sessionUnseenDone,
      autoResponds: input.autoResponds,
    })
  }

  return "idle"
}

export function nextUnseenDone(input: {
  active: boolean
  previousActive?: boolean
  focused?: boolean
  current?: boolean
}) {
  if (input.focused) return false
  if (input.previousActive && !input.active) return true
  return !!input.current
}

function hasBlockingSessionRequest(input: {
  requests?: SurfaceSessionRequests
  directory?: string
  autoResponds?: (request: PermissionRequest, directory: string) => boolean
}) {
  const permission = input.requests?.permissions?.find(
    (request) => !input.autoResponds || !input.directory || !input.autoResponds(request, input.directory),
  )
  return !!permission || !!input.requests?.questions?.[0]
}
