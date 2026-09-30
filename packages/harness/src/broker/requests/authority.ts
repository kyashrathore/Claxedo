import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { AnswerResult, PendingRequest, TurnRequest } from "../../contract/broker"
import type { BrokerPorts, SessionAuthority, TurnAuthority } from "../ports"

export type FiledRequest = { sessionId: string; request: TurnRequest }

export type ChildAuthority = SessionAuthority & { correlationKey: string; childSessionId: string; childTurnId: string }

export type RequestAuthority =
  | { kind: "turn"; value: TurnAuthority }
  | { kind: "start"; value: AgentSessionStartBinding }
  | { kind: "child"; value: ChildAuthority }

export function sameStart(a: AgentSessionStartBinding, b: AgentSessionStartBinding): boolean {
  return a.sessionId === b.sessionId && a.operationId === b.operationId &&
    a.workspaceId === b.workspaceId && a.connectionId === b.connectionId && a.directory === b.directory
}

function sameSessionAuthority(a: SessionAuthority, b: SessionAuthority): boolean {
  return a.sessionId === b.sessionId && a.workspaceId === b.workspaceId &&
    a.directory === b.directory && a.connectionId === b.connectionId && a.ownerGeneration === b.ownerGeneration
}

export function sameTurnAuthority(a: TurnAuthority, b: TurnAuthority): boolean {
  return sameSessionAuthority(a, b) && a.turnId === b.turnId
}

function childOwnerIsCurrent(ports: BrokerPorts, owner: ChildAuthority): boolean {
  const session = ports.sessionAuthority(owner.sessionId)
  const route = ports.childRoute(owner.sessionId, owner.correlationKey)
  return !!session && sameSessionAuthority(session, owner) && route.kind === "bound" &&
    route.childSessionId === owner.childSessionId && route.assistantMessageId === owner.childTurnId &&
    ports.turnOpen(owner.childSessionId, owner.childTurnId)
}

export function requestOwnerIsCurrent(ports: BrokerPorts, owner: RequestAuthority): boolean {
  if (owner.kind === "start") {
    const current = ports.readStart(owner.value.sessionId)
    return current?.status === "starting" && sameStart(owner.value, current.binding)
  }
  if (owner.kind === "child") return childOwnerIsCurrent(ports, owner.value)
  const current = ports.currentTurnAuthority(owner.value.sessionId)
  return !!current && sameTurnAuthority(owner.value, current)
}

export function requestTargetMatchesOwner(
  ports: BrokerPorts,
  owner: RequestAuthority,
  filedSessionId: string,
  target: { sessionId: string } | { start: AgentSessionStartBinding },
): boolean {
  if (owner.kind === "start") return "start" in target && sameStart(owner.value, target.start) && requestOwnerIsCurrent(ports, owner)
  return "sessionId" in target && target.sessionId === filedSessionId && requestOwnerIsCurrent(ports, owner)
}

export function requestRefusal(reason: "stale" | "duplicate" | "foreign" | "unoffered" | "persistence"): AnswerResult {
  return { ok: false, refusal: reason, retryable: reason === "persistence", message: `Request ${reason}` }
}

export function pendingRequest(ports: BrokerPorts, authority: RequestAuthority, filed: FiledRequest): PendingRequest {
  return { sessionId: filed.sessionId, request: filed.request, askedAt: ports.clock.now(),
    ...(authority.kind !== "start" ? { upstreamSessionId: authority.value.upstreamSessionId } : {}),
    ...(authority.kind === "start" ? { start: authority.value } : {}) }
}
