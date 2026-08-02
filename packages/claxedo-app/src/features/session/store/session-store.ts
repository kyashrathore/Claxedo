import type { PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { cmp } from "@/platform/query/sort"

export const idleSessionStatus = { type: "idle" as const }

export function mergeBusySessionStatus(
  local: SessionStatus | undefined,
  server: SessionStatus | undefined,
  activeEvidence = true,
) {
  if (activeEvidence && local?.type === "busy" && (!server || server.type === "idle")) return local
  return server
}

export function pickSessionPermissions(
  items: PermissionRequest[] | undefined,
  sessionID: string,
) {
  return (items ?? [])
    .filter((item): item is PermissionRequest => !!item?.id && item.sessionID === sessionID)
    .sort((a, b) => cmp(a.id, b.id))
}

export function pickSessionQuestions(
  items: QuestionRequest[] | undefined,
  sessionID: string,
) {
  return (items ?? [])
    .filter((item): item is QuestionRequest => !!item?.id && item.sessionID === sessionID)
    .sort((a, b) => cmp(a.id, b.id))
}

export function isSessionTurnActive(input: {
  status?: SessionStatus
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}) {
  if (input.status?.type === "busy" || input.status?.type === "retry") return true
  if ((input.permissions ?? []).length > 0) return true
  if ((input.questions ?? []).length > 0) return true
  return false
}
