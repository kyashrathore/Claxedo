import { toAppError, type ServerError } from "./errors"
import { sessionId } from "./ids"
import type { StatusOwner } from "./status"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { AgentRequest, Placement, SessionStatusRead, SessionStatusReport } from "./types"
import type { Workspaces } from "./workspaces"
import { isPermissionWire, isQuestionWire, permissionRequest, questionRequest } from "./wire/requests"

type SessionRequest = { readonly sessionId: string; readonly request: AgentRequest }

export async function readRequests(transport: Transport, where: RuntimeRoute, onlySession?: string): Promise<SessionRequest[]> {
  const [permissions, questions] = await Promise.all([
    transport.runtimeJson<unknown[]>(where, "/permission"),
    transport.runtimeJson<unknown[]>(where, onlySession ? withQuery("/question", { sessionId: onlySession }) : "/question"),
  ])
  const all = [
    ...permissions.filter(isPermissionWire).map((row) => ({ sessionId: row.sessionID, request: permissionRequest(row) })),
    ...questions.filter(isQuestionWire).map((row) => ({ sessionId: row.sessionID, request: questionRequest(row) })),
  ]
  return onlySession ? all.filter((item) => item.sessionId === onlySession) : all
}

export function createStatusesRead(transport: Transport, workspaces: Workspaces, status: StatusOwner): () => Promise<SessionStatusRead> {
  const placementReports = async (placement: Placement): Promise<SessionStatusReport[]> => {
    const where = await workspaces.route(placement.id)
    const [statuses, requests] = await Promise.all([status.readPlacement(where), readRequests(transport, where)])
    const reported = [...statuses].filter(([, status]) => status.kind !== "idle").map(([id]) => id)
    const ids = new Set([...reported, ...requests.map((item) => item.sessionId)])
    return [...ids].map((id) => ({
      ref: { projectId: placement.projectId, placementId: placement.id, sessionId: sessionId(id) },
      status: statuses.get(id) ?? { kind: "idle" },
      requests: requests.filter((item) => item.sessionId === id).map((item) => item.request),
    }))
  }
  return async () => {
    await workspaces.load()
    const placements = workspaces.list()
    const settled = await Promise.allSettled(placements.map(placementReports))
    const reports: SessionStatusReport[] = []
    const failures: { placementId: Placement["id"]; error: ServerError }[] = []
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") reports.push(...result.value)
      else failures.push({ placementId: placements[index]!.id, error: toAppError(result.reason) })
    })
    return { reports, unreported: { kind: "idle" }, failures }
  }
}
