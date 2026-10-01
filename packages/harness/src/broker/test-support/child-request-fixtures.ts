import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { TurnRequest } from "../../contract/broker"

export const permission = (id: string, grantKey?: string, sessionID = "s1"): TurnRequest => ({
  kind: "permission", requestId: id, ...(grantKey ? { grantKey } : {}),
  permission: { id, sessionID, permission: "execute", patterns: [], always: [], metadata: {} },
})

export const question = (id: string): TurnRequest => ({
  kind: "question", requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})

export const byChild = (request: TurnRequest, correlationKey: string): TurnRequest => ({ ...request, child: { correlationKey } })

export const spawn = (toolCallId: string, mode: SubagentObservation["mode"] = "foreground"): SubagentObservation => ({
  observationId: `spawn:${toolCallId}`, providerKind: "claude-agent", toolCallId, toolCallRole: "spawn",
  status: "running", mode, transcript: { kind: "live" },
})

export const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

export const once = { kind: "permission", decision: "allow_once" } as const

export function filedSession(request: TurnRequest | undefined): string | undefined {
  if (request?.kind === "permission") return request.permission.sessionID
  if (request?.kind === "question") return request.question.sessionID
  return undefined
}
