import type { PermissionRequest, QuestionRequest, SessionStatus } from "../data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { dispatchSessionRequestsEvent, dispatchSessionStatusEvent } from "./session-status-dispatcher"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"

/**
 * How one directory-wide `/session/status` + `/permission` + `/question` read
 * becomes a single session's canonical status and requests entries.
 *
 * This payload has two independent authorities that fetch it — the session
 * pane's hydration (`syncSessionMeta`) and the rail's status batch — so the
 * derivation lives here rather than inside either of them. Both must produce
 * the same status from the same bytes, or the two writers flap against each
 * other through the shared cache entry.
 *
 * The two rules a raw write-through would lose: an absent permission/question
 * list means "unknown, keep what we had" rather than "empty", and a reported
 * status is merged against active turn evidence rather than trusted outright.
 */
export function applyDirectorySessionMeta(input: {
  sessionID: string
  status: Record<string, SessionStatus>
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}) {
  const cachedRequests = queryClient.getQueryData<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }>(
    shellDataKeys.sessionId(input.sessionID, "requests"),
  )
  const sessionPermissions = input.permissions === undefined
    ? cachedRequests?.permissions ?? []
    : pickSessionPermissions(input.permissions, input.sessionID)
  const sessionQuestions = input.questions === undefined
    ? cachedRequests?.questions ?? []
    : pickSessionQuestions(input.questions, input.sessionID)
  const nextStatus = mergeBusySessionStatus(
    queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(input.sessionID, "status")),
    input.status[input.sessionID],
    isSessionTurnActive({ permissions: sessionPermissions, questions: sessionQuestions }),
  ) ?? idleSessionStatus
  dispatchSessionStatusEvent({
    event: { type: "session.status", source: "server", sessionID: input.sessionID, status: nextStatus },
  })
  if (input.permissions === undefined && input.questions === undefined) return
  dispatchSessionRequestsEvent({
    event: {
      type: "session.requests",
      source: "server",
      sessionID: input.sessionID,
      requests: { permissions: sessionPermissions, questions: sessionQuestions },
    },
  })
}
