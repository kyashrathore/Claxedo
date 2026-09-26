import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { AgentRequest } from "./types"
import { isPermissionWire, isQuestionWire, permissionRequest, questionRequest } from "./wire/requests"

type SessionRequest = { readonly sessionId: string; readonly request: AgentRequest }

function requestsFrom(permissions: readonly unknown[], questions: readonly unknown[]): SessionRequest[] {
  return [
    ...permissions.filter(isPermissionWire).map((row) => ({ sessionId: row.sessionID, request: permissionRequest(row) })),
    ...questions.filter(isQuestionWire).map((row) => ({ sessionId: row.sessionID, request: questionRequest(row) })),
  ]
}

export async function readRequests(transport: Transport, where: RuntimeRoute, sessionId: string): Promise<SessionRequest[]> {
  const [permissions, questions] = await Promise.all([
    transport.runtimeJson<unknown[]>(where, "/permission"),
    transport.runtimeJson<unknown[]>(where, withQuery("/question", { sessionId })),
  ])
  return requestsFrom(permissions, questions).filter((item) => item.sessionId === sessionId)
}
