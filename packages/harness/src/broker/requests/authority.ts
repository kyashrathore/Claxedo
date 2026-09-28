import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { AnswerResult, PendingRequest, TurnRequest } from "../../contract/broker"
import type { BrokerPorts, TurnAuthority } from "../ports"

export type RequestAuthority =
  | { kind: "turn"; value: TurnAuthority }
  | { kind: "start"; value: AgentSessionStartBinding }

export function sameStart(a: AgentSessionStartBinding, b: AgentSessionStartBinding): boolean {
  return a.sessionId === b.sessionId && a.operationId === b.operationId &&
    a.workspaceId === b.workspaceId && a.connectionId === b.connectionId && a.directory === b.directory
}

export function sameTurnAuthority(a: TurnAuthority, b: TurnAuthority): boolean {
  return a.sessionId === b.sessionId && a.workspaceId === b.workspaceId &&
    a.directory === b.directory && a.connectionId === b.connectionId &&
    a.ownerGeneration === b.ownerGeneration && a.turnId === b.turnId
}

export function requestTargetMatchesOwner(
  ports: BrokerPorts,
  owner: RequestAuthority,
  target: { sessionId: string } | { start: AgentSessionStartBinding },
): boolean {
  if (owner.kind === "start") {
    const current = ports.readStart(owner.value.sessionId)
    return "start" in target && sameStart(owner.value, target.start) &&
      current?.status === "starting" && sameStart(owner.value, current.binding)
  }
  if (!("sessionId" in target) || target.sessionId !== owner.value.sessionId) return false
  const current = ports.currentTurnAuthority(target.sessionId)
  return !!current && sameTurnAuthority(owner.value, current)
}

export function requestOwnerIsCurrent(ports: BrokerPorts, owner: RequestAuthority): boolean {
  const target = owner.kind === "start" ? { start: owner.value } : { sessionId: owner.value.sessionId }
  return requestTargetMatchesOwner(ports, owner, target)
}

export function requestRefusal(reason: "stale" | "duplicate" | "foreign" | "unoffered" | "persistence"): AnswerResult {
  return { ok: false, refusal: reason, retryable: reason === "persistence", message: `Request ${reason}` }
}

export function pendingRequest(ports: BrokerPorts, authority: RequestAuthority, request: TurnRequest): PendingRequest {
  return { sessionId: authority.value.sessionId, request, askedAt: ports.clock.now(),
    ...(authority.kind === "turn" ? { upstreamSessionId: authority.value.upstreamSessionId } : {}),
    ...(authority.kind === "start" ? { start: authority.value } : {}) }
}
