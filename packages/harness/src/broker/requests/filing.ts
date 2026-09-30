import type { RuntimeDiagnostic } from "@claxedo/agent-runtime-contract"
import type { TurnRequest } from "../../contract/broker"
import type { BrokerPorts, ChildRoute, TurnAuthority } from "../ports"
import type { FiledRequest } from "./authority"

function retargeted(request: TurnRequest, parentSessionId: string, childSessionId: string): TurnRequest {
  if (request.kind === "permission" && request.permission.sessionID === parentSessionId) {
    return { ...request, permission: { ...request.permission, sessionID: childSessionId } }
  }
  if (request.kind === "question" && request.question.sessionID === parentSessionId) {
    return { ...request, question: { ...request.question, sessionID: childSessionId } }
  }
  return request
}

function childRequestRefiled(request: TurnRequest, correlationKey: string, route: Exclude<ChildRoute, { kind: "bound" }>): RuntimeDiagnostic {
  const reason = route.kind === "unbound" ? "names no child bound to this parent" : "names a child whose turn already finished"
  return {
    code: `child_request_route_${route.kind}`,
    message: `Filed a child's ${request.kind} request on its parent because its correlation key ${reason}`,
    severity: "warn",
    source: "child-request-routing",
    details: {
      requestId: request.requestId, requestKind: request.kind, correlationKey,
      ...(route.kind === "finished" ? { childSessionId: route.childSessionId, assistantMessageId: route.assistantMessageId } : {}),
    },
  }
}

export function fileTurnRequest(ports: BrokerPorts, authority: TurnAuthority, request: TurnRequest): FiledRequest {
  const parentSessionId = authority.sessionId
  if (!request.child) return { sessionId: parentSessionId, request }
  const route = ports.childRoute(parentSessionId, request.child.correlationKey)
  if (route.kind === "bound") return { sessionId: route.childSessionId, request: retargeted(request, parentSessionId, route.childSessionId) }
  const diagnostic = childRequestRefiled(request, request.child.correlationKey, route)
  void ports.publishSessionEvent(parentSessionId, { type: "diagnostic", diagnostic })
    .then(undefined, (error: unknown) => ports.reportOwnerFailure(parentSessionId, error))
  return { sessionId: parentSessionId, request }
}
