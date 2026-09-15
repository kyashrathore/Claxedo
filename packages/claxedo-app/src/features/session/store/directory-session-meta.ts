import type { PermissionRequest, QuestionRequest, SessionRequestsQueryData, SessionStatus } from "../data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { pendingSessionRequests } from "../data/sync/writers"
import { dispatchSessionRequestsEvent, dispatchSessionStatusEvent } from "./session-status-dispatcher"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"

/**
 * How one directory-wide `/session/status` + `/permission` + `/question` read
 * becomes a single session's canonical status and requests entries.
 *
 * This payload has two independent authorities that fetch it — the session
 * pane's hydration (`syncSessionMeta`) and the rail's status batch — so the
 * derivation lives here rather than inside either of them. Both must produce
 * the same entries from the same bytes, or the two writers flap against each
 * other through the shared cache entry.
 *
 * The three rules a raw write-through would lose: an absent
 * permission/question list means "unknown, keep what we had" rather than
 * "empty"; a read taken before a reply still lists the request it answered, so
 * it may neither re-open that request nor count it as a turn still running;
 * and a reported status is merged against active turn evidence rather than
 * trusted outright.
 */
export function applyDirectorySessionMeta(input: {
  sessionID: string
  status?: Record<string, SessionStatus>
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}) {
  const cachedRequests = queryClient.getQueryData<SessionRequestsQueryData>(
    shellDataKeys.sessionId(input.sessionID, "requests"),
  )
  const pending = pendingSessionRequests({
    queryClient,
    sessionId: input.sessionID,
    permissions: input.permissions && pickSessionPermissions(input.permissions, input.sessionID),
    questions: input.questions && pickSessionQuestions(input.questions, input.sessionID),
  })
  const sessionPermissions = pending.permissions ?? cachedRequests?.permissions ?? []
  const sessionQuestions = pending.questions ?? cachedRequests?.questions ?? []
  // A directory read is only authoritative about the absence of active
  // requests when both request legs completed (or both were already cached).
  // If either leg failed, treating its missing value as [] can let an idle
  // status erase a locally-observed busy turn while its approval/question is
  // still outstanding.
  const requestEvidenceKnown = cachedRequests !== undefined || (
    input.permissions !== undefined && input.questions !== undefined
  )
  const cachedStatus = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(input.sessionID, "status"))
  const nextStatus = input.status === undefined
    ? cachedStatus
    : mergeBusySessionStatus(
        cachedStatus,
        input.status[input.sessionID],
        !requestEvidenceKnown || isSessionTurnActive({ permissions: sessionPermissions, questions: sessionQuestions }),
      ) ?? idleSessionStatus
  // A failed status leg has no authority to initialize a cold session as idle.
  // Preserve a cached value when one exists; otherwise let a later successful
  // status read establish the first canonical state.
  if (nextStatus) {
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: input.sessionID, status: nextStatus },
    })
  }
  if (input.permissions === undefined && input.questions === undefined) return
  dispatchSessionRequestsEvent({
    event: {
      type: "session.requests",
      source: "server",
      sessionID: input.sessionID,
      // A partial read — one leg failed or was skipped — is not a reconciliation:
      // it neither stamps a fresh window nor erases an earlier one.
      requests: (previous) => ({
        permissions: sessionPermissions,
        questions: sessionQuestions,
        reconciledAt: input.permissions !== undefined && input.questions !== undefined
          ? Date.now()
          : previous?.reconciledAt,
      }),
    },
  })
}
