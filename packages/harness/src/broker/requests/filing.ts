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

type ChildOwned = { authority: ChildAuthority; filed: FiledRequest }
type ChildRequest = TurnRequest & { child: { correlationKey: string } }

function childOwnedRoute(ports: BrokerPorts, owner: SessionAuthority, request: ChildRequest): ChildOwned | UnroutedChild {
  const correlationKey = request.child.correlationKey
  const route = ports.childRoute(owner.sessionId, correlationKey)
  if (route.kind !== "bound") return route
  if (!ports.turnOpen(route.childSessionId, route.assistantMessageId)) return { ...route, kind: "unstarted" }
  return {
    authority: { ...owner, correlationKey, childSessionId: route.childSessionId, childTurnId: route.assistantMessageId },
    filed: { sessionId: route.childSessionId, request: retargeted(request, owner.sessionId, route.childSessionId) },
  }
}

export function fileOpenChildRequest(ports: BrokerPorts, owner: SessionAuthority, request: ChildRequest): ChildOwned | undefined {
  const routed = childOwnedRoute(ports, owner, request)
  return "authority" in routed ? routed : undefined
}

export function fileChildOwnedRequest(ports: BrokerPorts, owner: SessionAuthority, request: ChildRequest): ChildOwned | undefined {
  const routed = childOwnedRoute(ports, owner, request)
  if ("authority" in routed) return routed
  reportUnrouted(ports, owner.sessionId, unroutedChildRequest(request, request.child.correlationKey, routed, "refused"))
  return undefined
}
