import { ServerError, toAppError } from "./errors"
import { sessionId } from "./ids"
import type { StatusOwner } from "./status"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { AgentRequest, Placement, SessionStatusRead, SessionStatusReport } from "./types"
import type { Workspaces } from "./workspaces"
import { isPermissionWire, isQuestionWire, permissionRequest, questionRequest } from "./wire/requests"
import { SESSION_ACTIVITY_PATH, sessionActivityFromWire, type SessionActivity, type WorkspaceActivity } from "./wire/session-activity"

type SessionRequest = { readonly sessionId: string; readonly request: AgentRequest }

function requestsFrom(permissions: readonly unknown[], questions: readonly unknown[]): SessionRequest[] {
  return [
    ...permissions.filter(isPermissionWire).map((row) => ({ sessionId: row.sessionID, request: permissionRequest(row) })),
    ...questions.filter(isQuestionWire).map((row) => ({ sessionId: row.sessionID, request: questionRequest(row) })),
  ]
}

export async function readRequests(transport: Transport, where: RuntimeRoute, onlySession?: string): Promise<SessionRequest[]> {
  const [permissions, questions] = await Promise.all([
    transport.runtimeJson<unknown[]>(where, "/permission"),
    transport.runtimeJson<unknown[]>(where, onlySession ? withQuery("/question", { sessionId: onlySession }) : "/question"),
  ])
  const all = requestsFrom(permissions, questions)
  return onlySession ? all.filter((item) => item.sessionId === onlySession) : all
}

async function readWorkspace(transport: Transport, where: RuntimeRoute): Promise<WorkspaceActivity> {
  const [status, permissions, questions] = await Promise.all([
    transport.runtimeJson<unknown>(where, "/session/status"),
    transport.runtimeJson<unknown[]>(where, "/permission"),
    transport.runtimeJson<unknown[]>(where, "/question"),
  ])
  return { status, permissions, questions }
}

function fromShared(activity: SessionActivity, where: RuntimeRoute): WorkspaceActivity {
  const failure = activity.failed.get(where.workspaceId)
  if (failure) throw failure
  const read = activity.read.get(where.workspaceId)
  if (!read) throw new ServerError({ class: "not_found", message: "The server reported no session activity for this workspace" })
  return read
}

function reportsOf(status: StatusOwner, placement: Placement, activity: WorkspaceActivity): SessionStatusReport[] {
  const statuses = status.placementStatuses(placement.id, activity.status)
  const requests = requestsFrom(activity.permissions, activity.questions)
  const reported = [...statuses].filter(([, status]) => status.kind !== "idle").map(([id]) => id)
  const ids = new Set([...reported, ...requests.map((item) => item.sessionId)])
  return [...ids].map((id) => ({
    ref: { projectId: placement.projectId, placementId: placement.id, sessionId: sessionId(id) },
    status: statuses.get(id) ?? { kind: "idle" },
    requests: requests.filter((item) => item.sessionId === id).map((item) => item.request),
  }))
}

export function createStatusesRead(transport: Transport, workspaces: Workspaces, status: StatusOwner): () => Promise<SessionStatusRead> {
  return async () => {
    await workspaces.load()
    let shared: Promise<SessionActivity> | undefined
    const local = () => (shared ??= transport.json<unknown>(SESSION_ACTIVITY_PATH).then(sessionActivityFromWire))
    const placementReports = async (placement: Placement) => {
      const where = await workspaces.route(placement.id)
      const activity = transport.loopback && !where.remote ? fromShared(await local(), where) : await readWorkspace(transport, where)
      return reportsOf(status, placement, activity)
    }
    const placements = workspaces.list().filter((placement) => placement.reachable)
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
