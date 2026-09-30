import type { RuntimeDiagnostic } from "@claxedo/agent-runtime-contract"
import type { TurnRequest } from "../../contract/broker"
import type { BrokerPorts, SessionAuthority, TurnAuthority } from "../ports"
import type { ChildAuthority, FiledRequest } from "./authority"

type UnroutedChild =
  | { kind: "unbound" }
  | { kind: "finished" | "unstarted"; childSessionId: string; assistantMessageId: string }

const unroutedReason = {
  unbound: "names no child bound to this parent",
  finished: "names a child whose turn already finished",
  unstarted: "names a child whose turn has not started",
} as const

function retargeted(request: TurnRequest, parentSessionId: string, childSessionId: string): TurnRequest {
  if (request.kind === "permission" && request.permission.sessionID === parentSessionId) {
    return { ...request, permission: { ...request.permission, sessionID: childSessionId } }
  }
  if (request.kind === "question" && request.question.sessionID === parentSessionId) {
    return { ...request, question: { ...request.question, sessionID: childSessionId } }
  }
  return request
}

function unroutedChildRequest(request: TurnRequest, correlationKey: string, route: UnroutedChild, outcome: "parent" | "refused"): RuntimeDiagnostic {
  const verdict = outcome === "parent" ? "Filed a child's request on its parent" : "Refused a child's request while its parent has no turn"
  return {
    code: `child_request_route_${route.kind}`,
    message: `${verdict}: the ${request.kind} request's correlation key ${unroutedReason[route.kind]}`,
    severity: "warn",
    source: "child-request-routing",
    details: {
      requestId: request.requestId, requestKind: request.kind, correlationKey,
      ...(route.kind === "unbound" ? {} : { childSessionId: route.childSessionId, assistantMessageId: route.assistantMessageId }),
    },
  }
}

function reportUnrouted(ports: BrokerPorts, parentSessionId: string, diagnostic: RuntimeDiagnostic): void {
  void ports.publishSessionEvent(parentSessionId, { type: "diagnostic", diagnostic })
    .then(undefined, (error: unknown) => ports.reportOwnerFailure(parentSessionId, error))
}

export function fileTurnRequest(ports: BrokerPorts, authority: TurnAuthority, request: TurnRequest): FiledRequest {
  const parentSessionId = authority.sessionId
  if (!request.child) return { sessionId: parentSessionId, request }
  const route = ports.childRoute(parentSessionId, request.child.correlationKey)
  if (route.kind === "bound") return { sessionId: route.childSessionId, request: retargeted(request, parentSessionId, route.childSessionId) }
  reportUnrouted(ports, parentSessionId, unroutedChildRequest(request, request.child.correlationKey, route, "parent"))
  return { sessionId: parentSessionId, request }
}

export function fileChildOwnedRequest(
  ports: BrokerPorts, owner: SessionAuthority, request: TurnRequest & { child: { correlationKey: string } },
): { authority: ChildAuthority; filed: FiledRequest } | undefined {
  const correlationKey = request.child.correlationKey
  const route = ports.childRoute(owner.sessionId, correlationKey)
  const open = route.kind === "bound" && ports.turnOpen(route.childSessionId, route.assistantMessageId)
  if (route.kind === "bound" && open) {
    return {
      authority: { ...owner, correlationKey, childSessionId: route.childSessionId, childTurnId: route.assistantMessageId },
      filed: { sessionId: route.childSessionId, request: retargeted(request, owner.sessionId, route.childSessionId) },
    }
  }
  const unrouted: UnroutedChild = route.kind === "bound" ? { ...route, kind: "unstarted" } : route
  reportUnrouted(ports, owner.sessionId, unroutedChildRequest(request, correlationKey, unrouted, "refused"))
  return undefined
}
