import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { AnswerResult } from "../../contract/broker"
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
    a.upstreamSessionId === b.upstreamSessionId &&
    a.ownerGeneration === b.ownerGeneration && a.turnId === b.turnId
}

export function requestTargetMatchesOwner(
  ports: BrokerPorts,
  owner: RequestAuthority,
  target: { sessionId: string } | { start: AgentSessionStartBinding },
): boolean {
  if (owner.kind === "start") return "start" in target && sameStart(owner.value, target.start)
  if (!("sessionId" in target) || target.sessionId !== owner.value.sessionId) return false
  const current = ports.currentTurnAuthority(target.sessionId)
  return !!current && sameTurnAuthority(owner.value, current)
}

export function requestRefusal(reason: "stale" | "duplicate" | "foreign" | "unoffered" | "persistence"): AnswerResult {
  return { ok: false, refusal: reason, retryable: reason === "persistence", message: `Request ${reason}` }
}
