import { FIRST_TURN_ERROR_CLASSES, type FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStreamEvent, AgentTurnOutcome } from "../index"

export function isTerminalRuntimePayload(payload: AgentRuntimeStreamEvent) {
  if ("properties" in payload) return payload.type === "session.idle" || payload.type === "session.error"
  return payload.type === "finish" || payload.type === "cancelled" || payload.type === "error"
    || payload.type === "session-status" && payload.status === "error"
}

export function outcomeFromPayload(payload: AgentRuntimeStreamEvent): AgentTurnOutcome | undefined {
  if ("properties" in payload) {
    if (payload.type === "message.completed" && payload.properties.cancelled) return cancelledOutcome()
    if (payload.type === "session.idle") return { status: "completed", completedAt: Date.now() }
    if (payload.type === "session.error") {
      return failed(compatErrorMessage(payload.properties.error), compatErrorClass(payload.properties.error))
    }
    return undefined
  }
  if (payload.type === "finish") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "cancelled") return cancelledOutcome()
  if (payload.type === "session-status" && payload.status === "idle") return { status: "completed", completedAt: Date.now() }
  if (payload.type === "session-status" && payload.status === "error") {
    return { status: "failed", completedAt: Date.now(), error: "session error" }
  }
  if (payload.type === "error") return failed(payload.error, payload.errorClass)
  return undefined
}

function failed(error: string, errorClass: FirstTurnErrorClass | undefined): AgentTurnOutcome {
  return { status: "failed", completedAt: Date.now(), error, ...(errorClass ? { errorClass } : {}) }
}

export function cancelledOutcome(): AgentTurnOutcome {
  return { status: "cancelled", completedAt: Date.now(), reason: "abort" }
}

export function mergeOutcome(previous: AgentTurnOutcome | undefined, next: AgentTurnOutcome | undefined) {
  if (!next) return previous
  if (!previous) return next
  if (previous.status === "failed" && next.status === "failed" && previous.error === "session error" && next.error) {
    return { ...previous, error: next.error, ...(next.errorClass ? { errorClass: next.errorClass } : {}) }
  }
  if (previous.status === "failed" || previous.status === "cancelled") return previous
  if (next.status === "failed" || next.status === "cancelled") return next
  return previous
}

function compatErrorMessage(input: unknown) {
  if (!input || typeof input !== "object") return "session error"
  const row = input as { data?: unknown; message?: unknown }
  const data = row.data && typeof row.data === "object" ? row.data as { message?: unknown } : undefined
  if (typeof data?.message === "string") return data.message
  if (typeof row.message === "string") return row.message
  return "session error"
}

function compatErrorClass(input: unknown): FirstTurnErrorClass | undefined {
  if (!input || typeof input !== "object") return undefined
  const data = (input as { data?: unknown }).data
  const reported = data && typeof data === "object" ? (data as { firstTurnErrorClass?: unknown }).firstTurnErrorClass : undefined
  return FIRST_TURN_ERROR_CLASSES.find((errorClass) => errorClass === reported)
}
